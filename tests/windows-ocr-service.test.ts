import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OcrServiceError, type OcrService } from '../src/main/ocr/ocr-service'
import {
  mapWindowsOcrPayload,
  NativeFirstOcrService,
  resultQualityScore,
  shouldCompareWithFallback,
  WindowsOcrService
} from '../src/main/ocr/windows-ocr-service'

const emptyResult = {
  attachmentId: 'capture',
  text: '',
  confidence: 0,
  quality: 'normal' as const,
  language: { code: 'en-GB', label: 'English (United Kingdom)', source: 'detected' as const },
  regions: [],
  entities: [],
  truncated: false,
  engine: 'windows' as const,
  cached: false,
  preprocessing: 'none' as const,
  durationMs: 20
}

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

function service(recognise: OcrService['recognise']): OcrService {
  return {
    recognise,
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined)
  }
}

describe('Windows OCR integration', () => {
  it('maps native lines, language, and bounds into the shared result shape', () => {
    const result = mapWindowsOcrPayload('capture', {
      language: { code: 'en-GB', label: 'English (United Kingdom)' },
      lines: [
        { text: '  Native   text  ', x: 100, y: 50, width: 300, height: 40 },
        { text: 'hello@example.com', x: 100, y: 120, width: 500, height: 40 }
      ],
      textAngle: 0
    }, { width: 1_000, height: 500 }, 125)

    expect(result).toMatchObject({
      attachmentId: 'capture',
      text: 'Native text\nhello@example.com',
      confidence: 0,
      quality: 'normal',
      language: { code: 'en-GB', label: 'English (United Kingdom)', source: 'detected' },
      engine: 'windows',
      durationMs: 125
    })
    expect(result.regions[0]).toMatchObject({
      text: 'Native text',
      bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.08 }
    })
    expect(result.entities).toEqual([
      { id: 'entity-1', kind: 'email', value: 'hello@example.com' }
    ])
  })

  it('uses native word positions to preserve table columns', () => {
    const result = mapWindowsOcrPayload('capture', {
      language: { code: 'en-GB', label: 'English (United Kingdom)' },
      textAngle: null,
      lines: [{
        text: 'Product Price',
        x: 10,
        y: 20,
        width: 400,
        height: 24,
        words: [
          { text: 'Product', x: 10, y: 20, width: 70, height: 24 },
          { text: 'Price', x: 330, y: 20, width: 50, height: 24 }
        ]
      }]
    }, { width: 500, height: 200 })

    expect(result.text).toBe('Product\tPrice')
  })

  it('uses a useful native result without starting the bundled fallback', async () => {
    const native = service(vi.fn(async () => ({
      ...emptyResult,
      text: 'Native result with enough useful text',
      regions: [{ id: 'line-1', text: 'Native result with enough useful text', confidence: 0, bounds: { x: 0, y: 0, width: 1, height: 1 } }]
    })))
    const fallback = service(vi.fn(async () => ({ ...emptyResult, engine: 'tesseract' as const })))
    const combined = new NativeFirstOcrService(native, fallback)

    await expect(combined.recognise('capture', Buffer.from('image'), { width: 100, height: 100 }, undefined, { sourcePath: 'capture.png' }))
      .resolves.toMatchObject({ text: 'Native result with enough useful text', engine: 'windows' })
    expect(fallback.recognise).not.toHaveBeenCalled()
  })

  it('passes a corrected temporary image to Windows OCR and removes it afterwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fovea-ocr-geometry-'))
    roots.push(root)
    const sourcePath = join(root, 'capture.png')
    const image = await sharp(Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="640" height="260">
        <rect width="640" height="260" fill="#fff"/>
        <g fill="#111">
          <rect x="80" y="55" width="480" height="6"/>
          <rect x="100" y="105" width="440" height="6"/>
          <rect x="70" y="155" width="500" height="6"/>
        </g>
      </svg>
    `)).rotate(3, { background: '#fff' }).png().toBuffer()
    await writeFile(sourcePath, image)
    const nativeRecognise = vi.fn<OcrService['recognise']>(async () => ({
      ...emptyResult,
      text: 'Corrected native result with enough useful text',
      regions: [{ id: 'line-1', text: 'Corrected native result with enough useful text', confidence: 0, bounds: { x: 0, y: 0, width: 1, height: 1 } }]
    }))
    const native = service(nativeRecognise)
    const fallback = service(vi.fn(async () => ({ ...emptyResult, engine: 'tesseract' as const })))

    const result = await new NativeFirstOcrService(native, fallback)
      .recognise('capture', image, await sharp(image).metadata().then(({ width, height }) => ({ width: width!, height: height! })), undefined, { sourcePath })

    expect(result.geometryCorrection).toBe('deskewed')
    const correctedOptions = nativeRecognise.mock.calls[0]?.[4]
    expect(correctedOptions?.sourcePath).toMatch(/\.ocr-[\da-f-]+\.png$/)
    await expect(access(correctedOptions!.sourcePath!)).rejects.toThrow()
  })

  it('falls back when Windows OCR is unavailable or finds no useful text', async () => {
    const fallbackResult = {
      ...emptyResult,
      text: 'Bundled result',
      engine: 'tesseract' as const
    }
    const fallback = service(vi.fn(async () => fallbackResult))
    const unavailable = service(vi.fn(async () => {
      throw new OcrServiceError('ocr-unavailable', 'No native engine')
    }))
    const empty = service(vi.fn(async () => emptyResult))

    await expect(new NativeFirstOcrService(unavailable, fallback)
      .recognise('capture', Buffer.from('image'), { width: 100, height: 100 }, undefined, { sourcePath: 'capture.png' }))
      .resolves.toMatchObject({ text: 'Bundled result', engine: 'tesseract' })
    await expect(new NativeFirstOcrService(empty, fallback)
      .recognise('capture', Buffer.from('image'), { width: 100, height: 100 }, undefined, { sourcePath: 'capture.png' }))
      .resolves.toMatchObject({ text: 'Bundled result', engine: 'tesseract' })
    expect(fallback.recognise).toHaveBeenCalledTimes(2)
  })

  it('compares questionable English output and keeps the stronger engine result', async () => {
    const nativeResult = {
      ...emptyResult,
      text: 'Nafive text',
      regions: [{ id: 'line-1', text: 'Nafive text', confidence: 0, bounds: { x: 0, y: 0, width: 1, height: 1 } }]
    }
    const fallbackResult = {
      ...emptyResult,
      text: 'Native text',
      confidence: 96,
      engine: 'tesseract' as const,
      regions: [{ id: 'line-1', text: 'Native text', confidence: 96, bounds: { x: 0, y: 0, width: 1, height: 1 } }]
    }
    const native = service(vi.fn(async () => nativeResult))
    const fallback = service(vi.fn(async () => fallbackResult))

    await expect(new NativeFirstOcrService(native, fallback)
      .recognise('capture', Buffer.from('image'), { width: 100, height: 100 }, undefined, { sourcePath: 'capture.png' }))
      .resolves.toMatchObject({ text: 'Native text', engine: 'tesseract' })
    expect(resultQualityScore(fallbackResult)).toBeGreaterThan(resultQualityScore(nativeResult))
  })

  it('does not compare a selected non-English Windows result against the English fallback', async () => {
    const native = service(vi.fn(async () => ({
      ...emptyResult,
      text: '日本語',
      language: { code: 'ja', label: '日本語', source: 'detected' as const }
    })))
    const fallback = service(vi.fn(async () => ({ ...emptyResult, text: 'wrong', engine: 'tesseract' as const })))

    await expect(new NativeFirstOcrService(native, fallback)
      .recognise('capture', Buffer.from('image'), { width: 100, height: 100 }, undefined, { sourcePath: 'capture.png', languageCode: 'ja' }))
      .resolves.toMatchObject({ text: '日本語', engine: 'windows' })
    expect(fallback.recognise).not.toHaveBeenCalled()
    expect(shouldCompareWithFallback(emptyResult, 'ja')).toBe(false)
  })

  it('reuses a native result for the same image and selected language', async () => {
    const windows = new WindowsOcrService('unused-script', 'win32')
    const runPowerShell = vi.fn(async () => JSON.stringify({
      language: { code: 'en-GB', label: 'English (United Kingdom)' },
      lines: [{ text: 'Cached native result', x: 0, y: 0, width: 100, height: 20 }],
      textAngle: 0
    }))
    ;(windows as unknown as { runPowerShell: typeof runPowerShell }).runPowerShell = runPowerShell
    const image = Buffer.from('not-an-image')

    const first = await windows.recognise('first', image, { width: 100, height: 100 }, undefined, { sourcePath: 'capture.png', languageCode: 'en-GB' })
    const second = await windows.recognise('second', image, { width: 100, height: 100 }, undefined, { sourcePath: 'capture.png', languageCode: 'en-GB' })

    expect(runPowerShell).toHaveBeenCalledOnce()
    expect(first).toMatchObject({ cached: false, attachmentId: 'first' })
    expect(second).toMatchObject({ cached: true, attachmentId: 'second' })
  })
})
