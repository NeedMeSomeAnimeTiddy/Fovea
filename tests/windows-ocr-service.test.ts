import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OcrServiceError, type OcrService } from '../src/main/ocr/ocr-service'
import {
  mapWindowsOcrPayload,
  mapFrozenScreenRefinementResult,
  mergeScreenOcrResults,
  NativeFirstOcrService,
  prepareFrozenScreenRefinement,
  resultQualityScore,
  shouldAcceptFrozenScreenRefinement,
  shouldCompareWithFallback,
  shouldRefineFrozenScreenOcr,
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
    expect(result.words).toEqual([
      expect.objectContaining({ text: 'Product', bounds: { x: 0.02, y: 0.1, width: 0.14, height: 0.12 } }),
      expect.objectContaining({ text: 'Price', bounds: { x: 0.66, y: 0.1, width: 0.1, height: 0.12 } })
    ])
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

  it('does not let conflicting Paddle confidence overwrite immediate Windows text', async () => {
    const native = service(vi.fn(async () => ({
      ...emptyResult,
      text: 'Plausible Windows',
      regions: [{ id: 'line-1', text: 'Plausible Windows', confidence: 0, bounds: { x: 0, y: 0, width: 1, height: 1 } }]
    })))
    const fallback = service(vi.fn(async () => ({
      ...emptyResult,
      text: 'Accurate Paddle text with enough characters',
      confidence: 96,
      engine: 'paddle' as const,
      paddleProfile: 'small' as const,
      regions: [{ id: 'line-1', text: 'Accurate Paddle text with enough characters', confidence: 96, bounds: { x: 0, y: 0, width: 1, height: 1 } }]
    })))

    const onProgress = vi.fn()
    await expect(new NativeFirstOcrService(native, fallback)
      .recognise('capture', Buffer.from('image'), { width: 100, height: 100 }, onProgress, {
        sourcePath: 'capture.png',
        preserveGeometry: true
      }))
      .resolves.toMatchObject({ text: 'Plausible Windows', engine: 'windows' })
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'Fast screen text ready',
      result: expect.objectContaining({ text: 'Plausible Windows' })
    }))
    expect(fallback.recognise).toHaveBeenCalledOnce()
  })

  it('keeps complementary lines from both frozen-screen OCR engines', () => {
    const nativeResult = {
      ...emptyResult,
      text: 'Native heading\nNative footer',
      regions: [
        { id: 'line-1', text: 'Native heading', confidence: 0, bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 } },
        { id: 'line-2', text: 'Native footer', confidence: 0, bounds: { x: 0.1, y: 0.7, width: 0.3, height: 0.05 } }
      ]
    }
    const paddleResult = {
      ...emptyResult,
      text: 'Paddle middle line',
      confidence: 96,
      engine: 'paddle' as const,
      regions: [
        { id: 'line-1', text: 'Paddle middle line', confidence: 96, bounds: { x: 0.1, y: 0.4, width: 0.35, height: 0.05 } }
      ]
    }

    const merged = mergeScreenOcrResults(nativeResult, paddleResult)

    expect(merged.regions.map(({ text }) => text)).toEqual([
      'Native heading',
      'Paddle middle line',
      'Native footer'
    ])
    expect(merged.text).toBe('Native heading\nPaddle middle line\nNative footer')
  })

  it('collapses overlapping partial text into the fuller OCR line', () => {
    const nativeResult = {
      ...emptyResult,
      text: 'Settings and privacy',
      regions: [{
        id: 'line-1',
        text: 'Settings and privacy',
        confidence: 0,
        bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.05 }
      }]
    }
    const paddleResult = {
      ...emptyResult,
      text: 'Settings',
      confidence: 99,
      engine: 'paddle' as const,
      regions: [{
        id: 'line-1',
        text: 'Settings',
        confidence: 99,
        bounds: { x: 0.1, y: 0.2, width: 0.18, height: 0.05 }
      }]
    }

    const merged = mergeScreenOcrResults(nativeResult, paddleResult)

    expect(merged.regions).toHaveLength(1)
    expect(merged.regions[0]).toMatchObject({ text: 'Settings and privacy' })
    expect(merged.text).toBe('Settings and privacy')
  })

  it('returns a substantial frozen-screen Windows result without preparing Paddle', async () => {
    const lines = Array.from({ length: 6 }, (_, index) => ({
      id: `line-${index + 1}`,
      text: `Windows recognised complete screen sentence number ${index + 1}`,
      confidence: 0,
      bounds: { x: 0.05, y: 0.05 + index * 0.1, width: 0.5, height: 0.04 }
    }))
    const nativeResult = {
      ...emptyResult,
      text: lines.map(({ text }) => text).join('\n'),
      regions: lines
    }
    const native = service(vi.fn(async () => nativeResult))
    const fallback = {
      ...service(vi.fn(async () => ({ ...emptyResult, engine: 'paddle' as const }))),
      prepare: vi.fn(async () => undefined)
    }

    await expect(new NativeFirstOcrService(native, fallback)
      .recognise('capture', Buffer.from('original pixels'), { width: 100, height: 100 }, undefined, {
        sourcePath: 'capture.png',
        preserveGeometry: true
      }))
      .resolves.toMatchObject({ engine: 'windows', text: nativeResult.text })

    expect(shouldRefineFrozenScreenOcr(nativeResult)).toBe(false)
    expect(fallback.prepare).not.toHaveBeenCalled()
    expect(fallback.recognise).not.toHaveBeenCalled()
  })

  it('plans selective refinement for an uncovered value beside native text', async () => {
    const image = await sharp(Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">
        <rect width="600" height="400" fill="#fff"/>
        <text x="45" y="90" font-size="24" fill="#111">Recognised heading and description</text>
        <text x="410" y="210" font-size="22" fill="#111">£149.00</text>
      </svg>
    `)).png().toBuffer()
    const nativeResult = {
      ...emptyResult,
      text: 'Recognised heading and description',
      regions: [{
        id: 'line-1',
        text: 'Recognised heading and description',
        confidence: 0,
        bounds: { x: 0.075, y: 0.15, width: 0.52, height: 0.08 }
      }]
    }
    const hint = { x: 0.67, y: 0.44, width: 0.2, height: 0.08 }

    const plan = await prepareFrozenScreenRefinement(
      image,
      { width: 600, height: 400 },
      nativeResult,
      [hint]
    )

    expect(plan).not.toBeNull()
    expect(plan?.panels.length).toBeGreaterThan(0)
    expect(plan?.panels.length).toBeLessThanOrEqual(6)
    expect(plan?.coverage).toBeLessThanOrEqual(0.25)
    expect(plan?.panels.some(({ source }) => {
      const hintCenterX = (hint.x + hint.width / 2) * 600
      const hintCenterY = (hint.y + hint.height / 2) * 400
      return hintCenterX >= source.left &&
        hintCenterX <= source.left + source.width &&
        hintCenterY >= source.top &&
        hintCenterY <= source.top + source.height
    })).toBe(true)
    await expect(sharp(plan!.image).metadata()).resolves.toMatchObject(plan!.size)
  })

  it('maps selective Paddle crop geometry back onto the frozen screen', () => {
    const mapped = mapFrozenScreenRefinementResult({
      ...emptyResult,
      text: '42',
      confidence: 92,
      engine: 'paddle',
      regions: [{
        id: 'line-1',
        text: '42',
        confidence: 92,
        bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 }
      }]
    }, {
      image: Buffer.from('montage'),
      size: { width: 200, height: 100 },
      screenSize: { width: 1_000, height: 500 },
      coverage: 0.04,
      panels: [{
        source: { left: 400, top: 100, width: 160, height: 80 },
        destination: { left: 10, top: 10, width: 160, height: 80 }
      }]
    })

    expect(mapped.regions).toHaveLength(1)
    expect(mapped.regions[0]?.text).toBe('42')
    expect(mapped.regions[0]?.bounds.x).toBeCloseTo(0.41)
    expect(mapped.regions[0]?.bounds.y).toBeCloseTo(0.22)
    expect(mapped.regions[0]?.bounds.width).toBeCloseTo(0.06)
    expect(mapped.regions[0]?.bounds.height).toBeCloseTo(0.04)
  })

  it('runs one selective Paddle montage when dense Windows text misses a hinted value', async () => {
    const image = await sharp(Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">
        <rect width="600" height="400" fill="#fff"/>
        <text x="40" y="80" font-size="22" fill="#111">Windows recognised enough text elsewhere</text>
        <text x="410" y="220" font-size="22" fill="#111">Missing value</text>
      </svg>
    `)).png().toBuffer()
    const nativeResult = {
      ...emptyResult,
      text: 'Windows recognised enough text elsewhere',
      regions: [{
        id: 'line-1',
        text: 'Windows recognised enough text elsewhere',
        confidence: 0,
        bounds: { x: 0.06, y: 0.13, width: 0.56, height: 0.08 }
      }]
    }
    const native = service(vi.fn(async () => nativeResult))
    const fallbackRecognise = vi.fn<OcrService['recognise']>(async () => ({
      ...emptyResult,
      engine: 'paddle',
      paddleProfile: 'medium'
    }))
    const fallback = {
      ...service(fallbackRecognise),
      prepare: vi.fn(async () => undefined)
    }

    await expect(new NativeFirstOcrService(native, fallback)
      .recognise('capture', image, { width: 600, height: 400 }, undefined, {
        sourcePath: 'capture.png',
        preserveGeometry: true,
        refinementRegions: [{ x: 0.67, y: 0.45, width: 0.22, height: 0.08 }]
      }))
      .resolves.toMatchObject({ engine: 'windows', text: nativeResult.text })

    expect(fallback.prepare).toHaveBeenCalledOnce()
    expect(fallbackRecognise).toHaveBeenCalledOnce()
    const [attachmentId, selectiveImage, selectiveSize, , selectiveOptions] = fallbackRecognise.mock.calls[0]!
    expect(attachmentId).toBe('capture')
    expect(selectiveImage.equals(image)).toBe(false)
    expect(selectiveSize).not.toEqual({ width: 600, height: 400 })
    expect(selectiveOptions).toMatchObject({
      sourcePath: undefined,
      refinementRegions: undefined,
      selectiveScreenRefinement: true
    })
  })

  it('waits for sparse Windows OCR before preparing Paddle and passes the untouched screen', async () => {
    let releaseNative: (() => void) | undefined
    const native = service(vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseNative = resolve })
      return {
        ...emptyResult,
        text: 'Windows result',
        regions: [{ id: 'line-1', text: 'Windows result', confidence: 0, bounds: { x: 0, y: 0, width: 1, height: 1 } }]
      }
    }))
    const fallback = {
      ...service(vi.fn(async () => ({
      ...emptyResult,
      text: 'Paddle screen result with enough characters',
      confidence: 98,
      engine: 'paddle' as const,
      paddleProfile: 'small' as const,
      regions: [{ id: 'line-1', text: 'Paddle screen result with enough characters', confidence: 98, bounds: { x: 0, y: 0, width: 1, height: 1 } }]
      }))),
      prepare: vi.fn(async () => undefined)
    }
    const image = Buffer.from('original frozen screen pixels')
    const recognition = new NativeFirstOcrService(native, fallback)
      .recognise('capture', image, { width: 100, height: 100 }, undefined, {
        sourcePath: 'capture.png',
        preserveGeometry: true
      })

    await vi.waitFor(() => expect(native.recognise).toHaveBeenCalledOnce())
    expect(fallback.prepare).not.toHaveBeenCalled()
    expect(fallback.recognise).not.toHaveBeenCalled()
    releaseNative?.()
    await expect(recognition).resolves.toMatchObject({ engine: 'windows' })
    expect(fallback.prepare).toHaveBeenCalledOnce()
    expect(fallback.recognise).toHaveBeenCalledOnce()
    expect(fallback.recognise).toHaveBeenCalledWith(
      'capture',
      image,
      { width: 100, height: 100 },
      undefined,
      expect.objectContaining({ sourcePath: 'capture.png' })
    )
  })

  it('rejects a fragment-heavy Paddle refinement instead of doubling screen boxes', async () => {
    const nativeResult = {
      ...emptyResult,
      text: 'Sparse heading',
      regions: [{
        id: 'line-1',
        text: 'Sparse heading',
        confidence: 0,
        bounds: { x: 0.1, y: 0.1, width: 0.45, height: 0.05 }
      }]
    }
    const fragmentRegions = Array.from({ length: 12 }, (_, index) => ({
      id: `line-${index + 1}`,
      text: `x${index % 10}`,
      confidence: 91,
      bounds: { x: 0.05 + (index % 4) * 0.2, y: 0.3 + Math.floor(index / 4) * 0.1, width: 0.04, height: 0.03 }
    }))
    const fallbackResult = {
      ...emptyResult,
      text: fragmentRegions.map(({ text }) => text).join('\n'),
      confidence: 91,
      engine: 'paddle' as const,
      regions: fragmentRegions
    }
    const native = service(vi.fn(async () => nativeResult))
    const fallback = service(vi.fn(async () => fallbackResult))

    await expect(new NativeFirstOcrService(native, fallback)
      .recognise('capture', Buffer.from('image'), { width: 100, height: 100 }, undefined, {
        sourcePath: 'capture.png',
        preserveGeometry: true
      }))
      .resolves.toMatchObject({ engine: 'windows', text: nativeResult.text, regions: nativeResult.regions })

    expect(shouldAcceptFrozenScreenRefinement(nativeResult, fallbackResult)).toBe(false)
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
