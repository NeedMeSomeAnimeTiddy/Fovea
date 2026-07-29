import { describe, expect, it, vi } from 'vitest'
import { BarcodeFormat, QRCodeWriter } from '@zxing/library'
import sharp from 'sharp'
import type { Page } from 'tesseract.js'
import {
  detectOcrEntities,
  detectVisualCodes,
  layoutAwareLineText,
  mapOcrPage,
  prepareHighContrastOcrImage,
  prepareOcrImage,
  TesseractOcrService
} from '../src/main/ocr/ocr-service'

const workerMocks = vi.hoisted(() => ({
  recognise: vi.fn(),
  terminate: vi.fn(async () => undefined)
}))

vi.mock('tesseract.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('tesseract.js')>(),
  createWorker: vi.fn(async () => ({
    recognize: workerMocks.recognise,
    terminate: workerMocks.terminate
  }))
}))

function page(overrides: Partial<Page> = {}): Page {
  return {
    blocks: [{
      paragraphs: [{
        lines: [
          {
            words: [],
            text: '  First   recognised line  ',
            confidence: 92,
            baseline: { x0: 10, y0: 30, x1: 110, y1: 30 },
            rowAttributes: { ascenders: 0, descenders: 0, rowHeight: 20 },
            bbox: { x0: 10, y0: 10, x1: 110, y1: 30 }
          },
          {
            words: [],
            text: 'Uncertain line',
            confidence: 20,
            baseline: { x0: 20, y0: 80, x1: 220, y1: 80 },
            rowAttributes: { ascenders: 0, descenders: 0, rowHeight: 20 },
            bbox: { x0: 20, y0: 60, x1: 220, y1: 80 }
          }
        ],
        text: '',
        confidence: 56,
        bbox: { x0: 10, y0: 10, x1: 220, y1: 80 },
        is_ltr: true
      }],
      text: '',
      confidence: 56,
      bbox: { x0: 10, y0: 10, x1: 220, y1: 80 },
      blocktype: 'FLOWING_TEXT',
      page: null as unknown as Page
    }],
    confidence: 56,
    text: '',
    oem: '',
    osd: '',
    psm: '',
    version: '',
    hocr: null,
    tsv: null,
    box: null,
    unlv: null,
    sd: null,
    imageColor: null,
    imageGrey: null,
    imageBinary: null,
    rotateRadians: null,
    pdf: null,
    debug: null,
    ...overrides
  }
}

async function qrPng(value: string, size = 240): Promise<Buffer> {
  const matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, size, size, new Map())
  const pixels = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const colour = matrix.get(x, y) ? 0 : 255
      const offset = (y * size + x) * 3
      pixels[offset] = colour
      pixels[offset + 1] = colour
      pixels[offset + 2] = colour
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer()
}

describe('local OCR result mapping', () => {
  it('normalises selectable lines, confidence, and image-relative bounds', () => {
    const result = mapOcrPage('attachment-1', page(), { width: 400, height: 200 })

    expect(result).toMatchObject({
      attachmentId: 'attachment-1',
      text: 'First recognised line\nUncertain line',
      confidence: 56,
      quality: 'low-confidence',
      language: { code: 'eng', label: 'English', source: 'configured' },
      truncated: false
    })
    expect(result.regions).toEqual([
      {
        id: 'line-1',
        text: 'First recognised line',
        confidence: 92,
        bounds: { x: 0.025, y: 0.05, width: 0.25, height: 0.1 }
      },
      {
        id: 'line-2',
        text: 'Uncertain line',
        confidence: 20,
        bounds: { x: 0.05, y: 0.3, width: 0.5, height: 0.1 }
      }
    ])
  })

  it('returns an empty, non-throwing result when no text is detected', () => {
    const result = mapOcrPage('attachment-2', page({ blocks: [], text: '', confidence: 0 }), { width: 0, height: 0 })

    expect(result.text).toBe('')
    expect(result.regions).toEqual([])
    expect(result.quality).toBe('low-confidence')
  })

  it('falls back to the page text when granular blocks are unavailable', () => {
    const result = mapOcrPage('attachment-3', page({ blocks: null, text: 'Fallback text', confidence: 81 }), { width: 800, height: 600 })

    expect(result).toMatchObject({
      text: 'Fallback text',
      confidence: 81,
      quality: 'normal',
      regions: [{ id: 'line-1', text: 'Fallback text', bounds: { x: 0, y: 0, width: 1, height: 1 } }]
    })
  })

  it('preserves paragraph breaks and repairs simple line-end hyphenation', () => {
    const input = page()
    const block = input.blocks![0]!
    const paragraph = block.paragraphs[0]!
    const firstLine = paragraph.lines[0]!
    const secondLine = paragraph.lines[1]!
    block.paragraphs = [
      {
        ...paragraph,
        lines: [
          { ...firstLine, text: 'Multi-' },
          { ...secondLine, text: 'line heading' }
        ]
      },
      {
        ...paragraph,
        lines: [{ ...firstLine, text: 'Second paragraph' }]
      }
    ]

    expect(mapOcrPage('attachment-4', input, { width: 400, height: 200 }).text)
      .toBe('Multiline heading\n\nSecond paragraph')
  })

  it('detects useful entities without treating ISO dates as phone numbers', () => {
    const entities = detectOcrEntities(
      'Docs https://example.com/help. Email hello@example.com or call +44 20 7946 0958 on 2026-07-28.'
    )

    expect(entities.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: 'url', value: 'https://example.com/help' },
      { kind: 'email', value: 'hello@example.com' },
      { kind: 'phone', value: '+44 20 7946 0958' }
    ])
  })

  it('preserves wide visual gaps as table columns while keeping normal word spacing', () => {
    const words = [
      { text: 'Item', bbox: { x0: 10, y0: 10, x1: 42, y1: 28 } },
      { text: 'description', bbox: { x0: 50, y0: 10, x1: 138, y1: 28 } },
      { text: 'Quantity', bbox: { x0: 280, y0: 10, x1: 344, y1: 28 } },
      { text: '12', bbox: { x0: 430, y0: 10, x1: 448, y1: 28 } }
    ]

    expect(layoutAwareLineText(words, 'Item description Quantity 12'))
      .toBe('Item description\tQuantity\t12')
  })

  it('upscales and enhances small captures within bounded dimensions', async () => {
    const image = await sharp({
      create: { width: 200, height: 80, channels: 3, background: '#ffffff' }
    }).png().toBuffer()

    const prepared = await prepareOcrImage(image, { width: 200, height: 80 })
    const metadata = await sharp(prepared.image).metadata()

    expect(prepared).toMatchObject({
      size: { width: 400, height: 160 },
      preprocessing: 'upscaled-contrast'
    })
    expect(metadata).toMatchObject({ width: 400, height: 160 })
  })

  it('reuses recent OCR results for identical captures', async () => {
    workerMocks.recognise.mockReset()
    workerMocks.recognise.mockResolvedValue({
      data: page({ blocks: [], text: 'High-confidence cached text', confidence: 92 })
    })
    const image = await sharp({
      create: { width: 1_600, height: 800, channels: 3, background: '#ffffff' }
    }).png().toBuffer()
    const service = new TesseractOcrService('unused-in-mocked-worker')

    const first = await service.recognise('first', image, { width: 1_600, height: 800 })
    const second = await service.recognise('second', image, { width: 1_600, height: 800 })

    expect(workerMocks.recognise).toHaveBeenCalledOnce()
    expect(first).toMatchObject({ attachmentId: 'first', cached: false })
    expect(second).toMatchObject({ attachmentId: 'second', cached: true })
    await service.dispose()
  })

  it('detects a QR code locally without sending the image elsewhere', async () => {
    const image = await qrPng('https://example.com/local-qr')

    await expect(detectVisualCodes(image)).resolves.toEqual([
      expect.objectContaining({
        id: 'entity-1',
        kind: 'qr',
        value: 'https://example.com/local-qr',
        bounds: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) })
      })
    ])
  })

  it('detects and deduplicates multiple QR codes in one capture', async () => {
    const first = await qrPng('https://example.com/first')
    const second = await qrPng('https://example.com/second')
    const image = await sharp({
      create: { width: 520, height: 260, channels: 3, background: '#ffffff' }
    }).composite([
      { input: first, left: 10, top: 10 },
      { input: second, left: 270, top: 10 }
    ]).png().toBuffer()

    const entities = await detectVisualCodes(image)

    expect(entities.map(({ kind, value }) => ({ kind, value }))).toEqual(expect.arrayContaining([
      { kind: 'qr', value: 'https://example.com/first' },
      { kind: 'qr', value: 'https://example.com/second' }
    ]))
    expect(entities.every(({ bounds }) => bounds && bounds.width > 0 && bounds.height > 0)).toBe(true)
    expect(new Set(entities.map(({ value }) => value)).size).toBe(entities.length)
  })

  it('creates a bounded black-and-white candidate for difficult photographed text', async () => {
    const image = await sharp({
      create: { width: 180, height: 70, channels: 3, background: '#383838' }
    }).png().toBuffer()

    const prepared = await prepareHighContrastOcrImage(image, { width: 180, height: 70 })
    const metadata = await sharp(prepared.image).metadata()

    expect(prepared.preprocessing).toBe('high-contrast')
    expect(prepared.size).toEqual({ width: 360, height: 140 })
    expect(metadata).toMatchObject({ width: 360, height: 140 })
  })

  it('uses the high-contrast candidate when it materially improves a low-confidence result', async () => {
    workerMocks.recognise.mockReset()
    workerMocks.recognise
      .mockResolvedValueOnce({ data: page() })
      .mockResolvedValueOnce({ data: page() })
      .mockResolvedValueOnce({ data: page({ blocks: [], text: 'Recovered photographed text', confidence: 91 }) })
    const image = await sharp({
      create: { width: 200, height: 80, channels: 3, background: '#555555' }
    }).png().toBuffer()
    const service = new TesseractOcrService('unused-in-mocked-worker')

    const result = await service.recognise('photo', image, { width: 200, height: 80 })

    expect(result).toMatchObject({
      text: 'Recovered photographed text',
      quality: 'normal',
      preprocessing: 'high-contrast'
    })
    expect(workerMocks.recognise).toHaveBeenCalledTimes(3)
    await service.dispose()
  })

  it('terminates active recognition when OCR is cancelled', async () => {
    workerMocks.recognise.mockReset()
    workerMocks.terminate.mockReset()
    let rejectRecognition: ((error: Error) => void) | undefined
    workerMocks.recognise.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectRecognition = reject
    }))
    workerMocks.terminate.mockImplementationOnce(async () => {
      rejectRecognition?.(new Error('worker terminated'))
    })
    const image = await sharp({
      create: { width: 1_600, height: 800, channels: 3, background: '#ffffff' }
    }).png().toBuffer()
    const service = new TesseractOcrService('unused-in-mocked-worker')

    const recognition = service.recognise('cancel-me', image, { width: 1_600, height: 800 })
    await vi.waitFor(() => expect(workerMocks.recognise).toHaveBeenCalledOnce())
    await service.cancel('cancel-me')

    await expect(recognition).rejects.toMatchObject({ code: 'ocr-cancelled' })
    expect(workerMocks.terminate).toHaveBeenCalledOnce()
    await service.dispose()
  })
})
