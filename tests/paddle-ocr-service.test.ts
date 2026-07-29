import { describe, expect, it, vi } from 'vitest'
import type { OcrResult } from '../src/shared/types/app'
import { OcrServiceError, type OcrService } from '../src/main/ocr/ocr-service'
import {
  mapPaddleOcrPayload,
  PADDLE_OCR_PROFILES,
  PaddleFirstOcrService,
  resolvePaddleOcrProfile
} from '../src/main/ocr/paddle-ocr-service'

function result(overrides: Partial<OcrResult> = {}): OcrResult {
  return {
    attachmentId: 'capture',
    text: '',
    confidence: 0,
    quality: 'low-confidence',
    language: { code: 'mul', label: 'PP-OCRv6 multilingual', source: 'configured' },
    regions: [],
    truncated: false,
    engine: 'paddle',
    cached: false,
    preprocessing: 'none',
    ...overrides
  }
}

function service(recognise: OcrService['recognise']): OcrService {
  return {
    recognise,
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined)
  }
}

describe('PaddleOCR integration', () => {
  it('defines three measurable profiles without disguising the underlying models', () => {
    expect(PADDLE_OCR_PROFILES).toEqual({
      small: {
        detector: 'PP-OCRv6_small_det',
        recognizer: 'PP-OCRv6_small_rec'
      },
      medium: {
        detector: 'PP-OCRv6_small_det',
        recognizer: 'PP-OCRv6_medium_rec'
      },
      large: {
        detector: 'PP-OCRv6_medium_det',
        recognizer: 'PP-OCRv6_medium_rec'
      }
    })
    expect(resolvePaddleOcrProfile('medium')).toBe('medium')
    expect(resolvePaddleOcrProfile('unknown')).toBe('small')
  })

  it('maps Paddle confidence and pixel boxes into shared OCR regions', () => {
    const mapped = mapPaddleOcrPayload('capture', {
      profile: 'medium',
      detector: 'PP-OCRv6_small_det',
      recognizer: 'PP-OCRv6_medium_rec',
      inferenceMs: 413,
      lines: [
        { text: '  Accurate   screen text ', confidence: 0.96, bounds: [100, 50, 500, 90] },
        { text: 'Lower confidence', confidence: 0.5, bounds: [100, 120, 400, 160] }
      ]
    }, { width: 1_000, height: 500 })

    expect(mapped).toMatchObject({
      attachmentId: 'capture',
      text: 'Accurate screen text\nLower confidence',
      confidence: 76,
      quality: 'normal',
      engine: 'paddle',
      paddleProfile: 'medium',
      durationMs: 413,
      regions: [
        {
          id: 'line-1',
          text: 'Accurate screen text',
          confidence: 96,
          bounds: { x: 0.1, y: 0.1, width: 0.4, height: 0.08 }
        },
        {
          id: 'line-2',
          text: 'Lower confidence',
          confidence: 50,
          bounds: { x: 0.1, y: 0.24, width: 0.3, height: 0.08 }
        }
      ]
    })
  })

  it('uses Tesseract only when Paddle is unavailable or empty', async () => {
    const fallback = service(vi.fn(async () => result({ text: 'Tesseract text', engine: 'tesseract' })))
    const unavailable = service(vi.fn(async () => {
      throw new OcrServiceError('ocr-unavailable', 'Paddle is not installed')
    }))
    const empty = service(vi.fn(async () => result()))

    await expect(new PaddleFirstOcrService(unavailable, fallback)
      .recognise('capture', Buffer.from('image'), { width: 100, height: 100 }))
      .resolves.toMatchObject({ text: 'Tesseract text', engine: 'tesseract' })
    await expect(new PaddleFirstOcrService(empty, fallback)
      .recognise('capture', Buffer.from('image'), { width: 100, height: 100 }))
      .resolves.toMatchObject({ text: 'Tesseract text', engine: 'tesseract' })
    expect(fallback.recognise).toHaveBeenCalledTimes(2)
  })

  it('does not hide Paddle cancellation by starting Tesseract', async () => {
    const fallback = service(vi.fn(async () => result({ text: 'Should not run', engine: 'tesseract' })))
    const cancelled = service(vi.fn(async () => {
      throw new OcrServiceError('ocr-cancelled', 'Cancelled')
    }))

    await expect(new PaddleFirstOcrService(cancelled, fallback)
      .recognise('capture', Buffer.from('image'), { width: 100, height: 100 }))
      .rejects.toMatchObject({ code: 'ocr-cancelled' })
    expect(fallback.recognise).not.toHaveBeenCalled()
  })
})
