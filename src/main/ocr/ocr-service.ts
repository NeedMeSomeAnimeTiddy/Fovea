import { createHash } from 'node:crypto'
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource
} from '@zxing/library'
import sharp from 'sharp'
import type { OcrBounds, OcrEntity, OcrLanguage, OcrRegion, OcrResult } from '@shared/types/app'
import { OEM, createWorker, type LoggerMessage, type Page, type Worker } from 'tesseract.js'

const MAX_REGIONS = 2_000
const MAX_TEXT_LENGTH = 100_000
const LOW_CONFIDENCE_THRESHOLD = 60
const CACHE_LIMIT = 8
const MAX_PREPROCESS_PIXELS = 8_000_000
const MAX_PREPROCESS_DIMENSION = 2_400
const PREPROCESS_VERSION = 'v2'
const ENGLISH: OcrLanguage = { code: 'eng', label: 'English', source: 'configured' }

export interface OcrImageSize {
  width: number
  height: number
}

export interface OcrProgress {
  progress: number
  stage: string
}

export interface OcrRecognitionOptions {
  sourcePath?: string
  languageCode?: string
  preserveGeometry?: boolean
}

export interface OcrService {
  recognise(
    attachmentId: string,
    image: Buffer,
    size: OcrImageSize,
    onProgress?: (progress: OcrProgress) => void,
    options?: OcrRecognitionOptions
  ): Promise<OcrResult>
  listLanguages?(): Promise<OcrLanguage[]>
  cancel?(attachmentId: string): Promise<void>
  dispose(): Promise<void>
}

export type OcrServiceErrorCode = 'ocr-unavailable' | 'ocr-language-unavailable' | 'ocr-failed' | 'ocr-cancelled'

export class OcrServiceError extends Error {
  constructor(readonly code: OcrServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OcrServiceError'
  }
}

export class UnavailableOcrService implements OcrService {
  async recognise(): Promise<OcrResult> {
    throw new OcrServiceError('ocr-unavailable', 'The local OCR service has not been configured.')
  }

  async dispose(): Promise<void> {}
}

export class TesseractOcrService implements OcrService {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private tail: Promise<void> = Promise.resolve()
  private activeProgress: ((progress: OcrProgress) => void) | undefined
  private activeAttachmentId: string | null = null
  private readonly cancelled = new Set<string>()
  private readonly cache = new Map<string, OcrResult>()
  private disposed = false

  constructor(
    private readonly langPath: string,
    private readonly language: OcrLanguage = ENGLISH
  ) {}

  recognise(
    attachmentId: string,
    image: Buffer,
    size: OcrImageSize,
    onProgress?: (progress: OcrProgress) => void
  ): Promise<OcrResult> {
    const operation = this.tail.then(
      () => this.performRecognition(attachmentId, image, size, onProgress),
      () => this.performRecognition(attachmentId, image, size, onProgress)
    )
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  async listLanguages(): Promise<OcrLanguage[]> {
    return [structuredClone(this.language)]
  }

  async cancel(attachmentId: string): Promise<void> {
    this.cancelled.add(attachmentId)
    if (this.activeAttachmentId !== attachmentId) return
    const worker = this.worker ?? await this.workerPromise?.catch(() => null)
    this.worker = null
    this.workerPromise = null
    if (worker) await worker.terminate().catch(() => undefined)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.tail
    const worker = this.worker ?? await this.workerPromise?.catch(() => null)
    this.worker = null
    this.workerPromise = null
    if (worker) await worker.terminate()
  }

  private async performRecognition(
    attachmentId: string,
    image: Buffer,
    size: OcrImageSize,
    onProgress?: (progress: OcrProgress) => void
  ): Promise<OcrResult> {
    if (this.disposed) throw new OcrServiceError('ocr-unavailable', 'The local OCR service has stopped.')
    this.throwIfCancelled(attachmentId)
    const startedAt = Date.now()
    const cacheKey = createHash('sha256').update(PREPROCESS_VERSION).update(this.language.code).update(image).digest('hex')
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      onProgress?.({ progress: 1, stage: 'Using cached text' })
      return { ...structuredClone(cached), attachmentId, cached: true, durationMs: Date.now() - startedAt }
    }
    this.activeAttachmentId = attachmentId
    this.activeProgress = onProgress
    onProgress?.({ progress: 0, stage: `Loading ${this.language.label} recognition model` })
    try {
      const visualCodes = detectVisualCodes(image)
      const worker = await this.getWorker()
      this.throwIfCancelled(attachmentId)
      const prepared = await prepareOcrImage(image, size)
      this.throwIfCancelled(attachmentId)
      onProgress?.({ progress: 0, stage: prepared.preprocessing === 'none' ? 'Recognising text' : 'Enhancing and recognising text' })
      const { data } = await worker.recognize(prepared.image, { rotateAuto: true }, { text: true, blocks: true })
      this.throwIfCancelled(attachmentId)
      let result: OcrResult = {
        ...mapOcrPage(attachmentId, data, prepared.size, this.language),
        engine: 'tesseract' as const,
        cached: false,
        preprocessing: prepared.preprocessing,
        durationMs: Date.now() - startedAt
      }
      if (prepared.preprocessing !== 'none' && result.quality === 'low-confidence') {
        onProgress?.({ progress: 0.85, stage: 'Checking original image' })
        const original = await worker.recognize(image, { rotateAuto: true }, { text: true, blocks: true })
        this.throwIfCancelled(attachmentId)
        const originalResult = {
          ...mapOcrPage(attachmentId, original.data, size, this.language),
          engine: 'tesseract' as const,
          cached: false,
          preprocessing: 'none' as const,
          durationMs: Date.now() - startedAt
        }
        if (resultScore(originalResult) > resultScore(result)) result = originalResult
      }
      if (result.quality === 'low-confidence') {
        onProgress?.({ progress: 0.9, stage: 'Checking high-contrast image' })
        const highContrast = await prepareHighContrastOcrImage(image, size)
        this.throwIfCancelled(attachmentId)
        const thresholded = await worker.recognize(highContrast.image, { rotateAuto: true }, { text: true, blocks: true })
        this.throwIfCancelled(attachmentId)
        const thresholdedResult = {
          ...mapOcrPage(attachmentId, thresholded.data, highContrast.size, this.language),
          engine: 'tesseract' as const,
          cached: false,
          preprocessing: 'high-contrast' as const,
          durationMs: Date.now() - startedAt
        }
        if (resultScore(thresholdedResult) > resultScore(result)) result = thresholdedResult
      }
      result.entities = mergeOcrEntities(await visualCodes, result.entities ?? [])
      this.throwIfCancelled(attachmentId)
      this.remember(cacheKey, result)
      return structuredClone(result)
    } catch (error) {
      if (this.cancelled.delete(attachmentId)) {
        throw new OcrServiceError('ocr-cancelled', 'Text extraction was stopped.', { cause: error })
      }
      if (error instanceof OcrServiceError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/traineddata|language/i.test(message)) {
        throw new OcrServiceError('ocr-language-unavailable', message, { cause: error })
      }
      if (/worker|wasm|module|core/i.test(message)) {
        throw new OcrServiceError('ocr-unavailable', message, { cause: error })
      }
      throw new OcrServiceError('ocr-failed', message, { cause: error })
    } finally {
      this.activeProgress = undefined
      if (this.activeAttachmentId === attachmentId) this.activeAttachmentId = null
    }
  }

  private throwIfCancelled(attachmentId: string): void {
    if (!this.cancelled.delete(attachmentId)) return
    throw new OcrServiceError('ocr-cancelled', 'Text extraction was stopped.')
  }

  private remember(cacheKey: string, result: OcrResult): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest) this.cache.delete(oldest)
    }
    this.cache.set(cacheKey, structuredClone(result))
  }

  private async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker
    if (!this.workerPromise) {
      this.workerPromise = createWorker(this.language.code, OEM.LSTM_ONLY, {
        langPath: this.langPath,
        cacheMethod: 'none',
        gzip: true,
        logger: (message) => this.reportProgress(message)
      }).then((worker) => {
        this.worker = worker
        return worker
      }).catch((error) => {
        this.workerPromise = null
        throw error
      })
    }
    return this.workerPromise
  }

  private reportProgress(message: LoggerMessage): void {
    const progress = clamp(message.progress, 0, 1)
    const stage = message.status === 'recognizing text'
      ? 'Recognising text'
      : message.status.replaceAll('_', ' ').replace(/^\w/, (character) => character.toUpperCase())
    this.activeProgress?.({ progress, stage })
  }
}

export async function prepareOcrImage(
  image: Buffer,
  size: OcrImageSize
): Promise<{ image: Buffer; size: OcrImageSize; preprocessing: 'none' | 'upscaled-contrast' }> {
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))
  if (width >= 1_400 && height >= 700) return { image, size: { width, height }, preprocessing: 'none' }
  const scale = Math.min(
    2,
    MAX_PREPROCESS_DIMENSION / width,
    MAX_PREPROCESS_DIMENSION / height,
    Math.sqrt(MAX_PREPROCESS_PIXELS / (width * height))
  )
  if (scale < 1.2) return { image, size: { width, height }, preprocessing: 'none' }
  const target = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
  try {
    const enhanced = await sharp(image)
      .resize(target.width, target.height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .grayscale()
      .normalize({ lower: 1, upper: 99 })
      .sharpen({ sigma: 0.8 })
      .png()
      .toBuffer()
    return { image: enhanced, size: target, preprocessing: 'upscaled-contrast' }
  } catch {
    return { image, size: { width, height }, preprocessing: 'none' }
  }
}

export async function prepareHighContrastOcrImage(
  image: Buffer,
  size: OcrImageSize
): Promise<{ image: Buffer; size: OcrImageSize; preprocessing: 'high-contrast' }> {
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))
  const scale = Math.max(1, Math.min(
    2,
    MAX_PREPROCESS_DIMENSION / width,
    MAX_PREPROCESS_DIMENSION / height,
    Math.sqrt(MAX_PREPROCESS_PIXELS / (width * height))
  ))
  const target = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
  try {
    const grayscale = sharp(image).resize(target.width, target.height, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3
    }).grayscale()
    const stats = await grayscale.clone().stats()
    const darkBackground = (stats.channels[0]?.mean ?? 255) < 110
    let pipeline = grayscale.normalize({ lower: 1, upper: 99 }).sharpen({ sigma: 0.8 })
    if (darkBackground) pipeline = pipeline.negate()
    return {
      image: await pipeline.threshold(165).png().toBuffer(),
      size: target,
      preprocessing: 'high-contrast'
    }
  } catch {
    return { image, size: { width, height }, preprocessing: 'high-contrast' }
  }
}

export function mapOcrPage(
  attachmentId: string,
  page: Page,
  size: OcrImageSize,
  language: OcrLanguage = ENGLISH
): OcrResult {
  const candidates = (page.blocks ?? []).flatMap((block, blockIndex) =>
    block.paragraphs.flatMap((paragraph, paragraphIndex) =>
      paragraph.lines.map((line) => ({ line, paragraphKey: `${blockIndex}:${paragraphIndex}` }))
    )
  )
  const wordCandidates = candidates.flatMap(({ line }) => line.words)
  const words = wordCandidates
    .slice(0, MAX_REGIONS)
    .map((word, index) => ({
      id: `word-${index + 1}`,
      text: word.text.replaceAll('\0', '').replace(/\s+/g, ' ').trim(),
      confidence: normaliseConfidence(word.confidence),
      bounds: normaliseBounds(word.bbox, size)
    }))
    .filter((word) => word.text)
  const regions: OcrRegion[] = []
  const paragraphKeys: string[] = []
  let textLength = 0
  let truncated = candidates.length > MAX_REGIONS || wordCandidates.length > MAX_REGIONS

  for (const { line, paragraphKey } of candidates.slice(0, MAX_REGIONS)) {
    const text = layoutAwareLineText(line.words, line.text)
    if (!text) continue
    const nextLength = textLength + text.length + (regions.length ? 1 : 0)
    if (nextLength > MAX_TEXT_LENGTH) {
      truncated = true
      break
    }
    regions.push({
      id: `line-${regions.length + 1}`,
      text,
      confidence: normaliseConfidence(line.confidence),
      bounds: normaliseBounds(line.bbox, size)
    })
    paragraphKeys.push(paragraphKey)
    textLength = nextLength
  }

  if (!regions.length) {
    const text = page.text.replaceAll('\0', '').trim().slice(0, MAX_TEXT_LENGTH)
    if (text) {
      regions.push({
        id: 'line-1',
        text,
        confidence: normaliseConfidence(page.confidence),
        bounds: { x: 0, y: 0, width: 1, height: 1 }
      })
      paragraphKeys.push('fallback')
      if (page.text.trim().length > MAX_TEXT_LENGTH) truncated = true
    }
  }

  const text = formatOcrText(regions, paragraphKeys)
  const confidence = regions.length
    ? normaliseConfidence(regions.reduce((sum, region) => sum + region.confidence, 0) / regions.length)
    : normaliseConfidence(page.confidence)
  return {
    attachmentId,
    text,
    confidence,
    quality: confidence < LOW_CONFIDENCE_THRESHOLD ? 'low-confidence' : 'normal',
    language: structuredClone(language),
    regions,
    words,
    entities: detectOcrEntities(text),
    truncated
  }
}

export function detectOcrEntities(text: string): OcrEntity[] {
  const matches: Array<{ kind: OcrEntity['kind']; value: string; index: number }> = []
  collectMatches(matches, text, /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, 'url')
  collectMatches(matches, text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 'email')
  collectMatches(matches, text, /(?:\+?\d[\d\s().-]{5,}\d)/g, 'phone', (value) => {
    const digits = value.replace(/\D/g, '')
    if (digits.length < 7 || digits.length > 15) return false
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(value.trim())) return false
    return digits.length >= 10 || value.trim().startsWith('+') || /[()\s]/.test(value)
  })
  const seen = new Set<string>()
  return matches
    .sort((left, right) => left.index - right.index)
    .filter(({ kind, value }) => {
      const key = `${kind}:${value.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 20)
    .map(({ kind, value }, index) => ({ id: `entity-${index + 1}`, kind, value }))
}

export function layoutAwareLineText(
  words: Array<{ text: string; bbox: { x0: number; x1: number; y0: number; y1: number } }>,
  fallback: string
): string {
  const ordered = words
    .map((word) => ({ ...word, text: normaliseLine(word.text) }))
    .filter((word) => word.text)
    .sort((left, right) => left.bbox.x0 - right.bbox.x0)
  if (ordered.length < 2) return normaliseLine(fallback)
  const characterWidths = ordered
    .map((word) => (word.bbox.x1 - word.bbox.x0) / Math.max(1, [...word.text].length))
    .filter((width) => Number.isFinite(width) && width > 0)
  const heights = ordered
    .map((word) => word.bbox.y1 - word.bbox.y0)
    .filter((height) => Number.isFinite(height) && height > 0)
  const typicalCharacterWidth = median(characterWidths) || 6
  const typicalHeight = median(heights) || typicalCharacterWidth * 2
  const columnGap = Math.max(typicalCharacterWidth * 3.25, typicalHeight * 1.35)
  let output = ordered[0]!.text
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!
    const current = ordered[index]!
    const gap = current.bbox.x0 - previous.bbox.x1
    output += `${gap >= columnGap ? '\t' : ' '}${current.text}`
  }
  return output.trim()
}

export async function detectVisualCodes(image: Buffer): Promise<OcrEntity[]> {
  try {
    const { data, info } = await sharp(image)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const source = new RGBLuminanceSource(Uint8ClampedArray.from(data), info.width, info.height)
    const regions = visualCodeScanRegions(info.width, info.height)
    const entities: OcrEntity[] = []
    const seen = new Set<string>()
    for (const region of regions) {
      try {
        const cropped = source.crop(region.left, region.top, region.width, region.height)
        const bitmap = new BinaryBitmap(new HybridBinarizer(cropped))
        const reader = new MultiFormatReader()
        reader.setHints(new Map([[DecodeHintType.TRY_HARDER, true]]))
        const result = reader.decode(bitmap)
        const value = result.getText().trim()
        const key = value.toLowerCase()
        if (!value || seen.has(key)) continue
        seen.add(key)
        const kind: OcrEntity['kind'] = result.getBarcodeFormat() === BarcodeFormat.QR_CODE ? 'qr' : 'barcode'
        const bounds = visualCodeBounds(result.getResultPoints(), region, info.width, info.height)
        entities.push({ id: `entity-${entities.length + 1}`, kind, value, ...(bounds ? { bounds } : {}) })
        if (entities.length >= 10) break
      } catch {
        // A scan region without a readable code is expected.
      }
    }
    return entities
  } catch {
    return []
  }
}

function visualCodeBounds(
  points: Array<{ getX(): number; getY(): number }> | null,
  region: { left: number; top: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number
): OcrBounds | null {
  if (!points || points.length < 2) return null
  const xs = points.map((point) => region.left + point.getX())
  const ys = points.map((point) => region.top + point.getY())
  const rawLeft = Math.min(...xs)
  const rawTop = Math.min(...ys)
  const rawRight = Math.max(...xs)
  const rawBottom = Math.max(...ys)
  const rawWidth = rawRight - rawLeft
  const rawHeight = rawBottom - rawTop
  if (rawWidth < 4 || rawHeight < 4) return null
  const paddingX = Math.max(6, rawWidth * 0.16)
  const paddingY = Math.max(6, rawHeight * 0.16)
  const left = Math.max(0, rawLeft - paddingX)
  const top = Math.max(0, rawTop - paddingY)
  const right = Math.min(imageWidth, rawRight + paddingX)
  const bottom = Math.min(imageHeight, rawBottom + paddingY)
  return {
    x: left / imageWidth,
    y: top / imageHeight,
    width: (right - left) / imageWidth,
    height: (bottom - top) / imageHeight
  }
}

function visualCodeScanRegions(width: number, height: number): Array<{ left: number; top: number; width: number; height: number }> {
  const regions = [{ left: 0, top: 0, width, height }]
  const addSplit = (axis: 'horizontal' | 'vertical'): void => {
    const extent = axis === 'horizontal' ? width : height
    if (extent < 180) return
    const span = Math.ceil(extent * 0.58)
    for (const offset of [0, extent - span]) {
      regions.push(axis === 'horizontal'
        ? { left: offset, top: 0, width: span, height }
        : { left: 0, top: offset, width, height: span })
    }
  }
  addSplit('horizontal')
  addSplit('vertical')
  if (width >= 240 && height >= 240) {
    const cellWidth = Math.ceil(width * 0.58)
    const cellHeight = Math.ceil(height * 0.58)
    for (const left of [0, width - cellWidth]) {
      for (const top of [0, height - cellHeight]) {
        regions.push({ left, top, width: cellWidth, height: cellHeight })
      }
    }
  }
  return regions
}

function mergeOcrEntities(...groups: OcrEntity[][]): OcrEntity[] {
  const seen = new Set<string>()
  return groups
    .flat()
    .filter(({ value }) => {
      const key = value.trim().toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 20)
    .map((entity, index) => ({ ...entity, id: `entity-${index + 1}` }))
}

function formatOcrText(regions: OcrRegion[], paragraphKeys: string[]): string {
  let output = ''
  for (const [index, region] of regions.entries()) {
    if (!output) {
      output = region.text
      continue
    }
    const paragraphChanged = paragraphKeys[index] !== paragraphKeys[index - 1]
    if (!paragraphChanged && /[A-Za-z]-$/.test(output) && /^[a-z]/.test(region.text)) {
      output = `${output.slice(0, -1)}${region.text}`
    } else {
      output += `${paragraphChanged ? '\n\n' : '\n'}${region.text}`
    }
  }
  return output.slice(0, MAX_TEXT_LENGTH)
}

function collectMatches(
  target: Array<{ kind: OcrEntity['kind']; value: string; index: number }>,
  text: string,
  pattern: RegExp,
  kind: OcrEntity['kind'],
  accept: (value: string) => boolean = () => true
): void {
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]
    if (!raw) continue
    const value = kind === 'phone' ? raw.trim() : raw.replace(/[),.;:!?]+$/, '')
    if (!value || !accept(value)) continue
    target.push({ kind, value, index: match.index ?? 0 })
  }
}

function resultScore(result: OcrResult): number {
  const usefulLength = Math.min(2_000, result.text.replace(/\s/g, '').length)
  return result.confidence * 10 + usefulLength
}

function median(values: number[]): number {
  if (!values.length) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2
}

function normaliseLine(value: string): string {
  return value.replaceAll('\0', '').replace(/\s+/g, ' ').trim()
}

function normaliseConfidence(value: number): number {
  return Math.round(clamp(Number.isFinite(value) ? value : 0, 0, 100))
}

function normaliseBounds(
  value: { x0: number; y0: number; x1: number; y1: number },
  size: OcrImageSize
): OcrBounds {
  const width = Math.max(1, size.width)
  const height = Math.max(1, size.height)
  const x = clamp(value.x0 / width, 0, 1)
  const y = clamp(value.y0 / height, 0, 1)
  return {
    x,
    y,
    width: clamp((value.x1 - value.x0) / width, 0, 1 - x),
    height: clamp((value.y1 - value.y0) / height, 0, 1 - y)
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
