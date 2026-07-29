import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OcrEntity, OcrLanguage, OcrRegion, OcrResult, PaddleOcrProfile } from '@shared/types/app'
import {
  detectOcrEntities,
  detectVisualCodes,
  OcrServiceError,
  type OcrImageSize,
  type OcrProgress,
  type OcrRecognitionOptions,
  type OcrService
} from './ocr-service'

const CACHE_LIMIT = 8
const MAX_OUTPUT_LINE_LENGTH = 2_000_000
const MAX_REGIONS = 2_000
const MAX_TEXT_LENGTH = 100_000
const DEFAULT_TIMEOUT_MS = 120_000
const LOW_CONFIDENCE_THRESHOLD = 60
const MULTILINGUAL: OcrLanguage = {
  code: 'mul',
  label: 'PP-OCRv6 multilingual',
  source: 'configured'
}

export const PADDLE_OCR_PROFILES: Record<PaddleOcrProfile, {
  detector: string
  recognizer: string
}> = {
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
}

export interface PaddleOcrLine {
  text: string
  confidence: number
  bounds: [number, number, number, number]
}

export interface PaddleOcrPayload {
  profile: PaddleOcrProfile
  detector: string
  recognizer: string
  lines: PaddleOcrLine[]
  inferenceMs?: number
}

interface PaddleOcrServiceOptions {
  pythonPath: string
  scriptPath: string
  runtimePath: string
  profile?: PaddleOcrProfile
  timeoutMs?: number
}

interface PendingRequest {
  attachmentId: string
  resolve(payload: PaddleOcrPayload): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

interface SidecarMessage {
  type?: string
  requestId?: string
  message?: string
  profile?: PaddleOcrProfile
  detector?: string
  recognizer?: string
  lines?: PaddleOcrLine[]
  inferenceMs?: number
}

export class PaddleOcrService implements OcrService {
  readonly profile: PaddleOcrProfile
  private readonly timeoutMs: number
  private readonly cache = new Map<string, OcrResult>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly cancelled = new Set<string>()
  private process: ChildProcessWithoutNullStreams | null = null
  private startingProcess: ChildProcessWithoutNullStreams | null = null
  private processPromise: Promise<ChildProcessWithoutNullStreams> | null = null
  private processReadyResolve: ((process: ChildProcessWithoutNullStreams) => void) | null = null
  private processReadyReject: ((error: Error) => void) | null = null
  private stdoutBuffer = ''
  private tail: Promise<void> = Promise.resolve()
  private activeAttachmentId: string | null = null
  private disposed = false

  constructor(private readonly options: PaddleOcrServiceOptions) {
    this.profile = options.profile ?? 'small'
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  recognise(
    attachmentId: string,
    image: Buffer,
    size: OcrImageSize,
    onProgress?: (progress: OcrProgress) => void,
    options: OcrRecognitionOptions = {}
  ): Promise<OcrResult> {
    const operation = this.tail.then(
      () => this.performRecognition(attachmentId, image, size, onProgress, options),
      () => this.performRecognition(attachmentId, image, size, onProgress, options)
    )
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  async listLanguages(): Promise<OcrLanguage[]> {
    return [structuredClone(MULTILINGUAL)]
  }

  async cancel(attachmentId: string): Promise<void> {
    this.cancelled.add(attachmentId)
    const request = [...this.pending.values()].find((candidate) => candidate.attachmentId === attachmentId)
    if (!request && this.activeAttachmentId !== attachmentId) return
    this.stopProcess(new OcrServiceError('ocr-cancelled', 'PaddleOCR recognition was stopped.'))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopProcess(new OcrServiceError('ocr-unavailable', 'The PaddleOCR service has stopped.'))
    await this.tail
  }

  private async performRecognition(
    attachmentId: string,
    image: Buffer,
    size: OcrImageSize,
    onProgress: ((progress: OcrProgress) => void) | undefined,
    options: OcrRecognitionOptions
  ): Promise<OcrResult> {
    if (this.disposed) throw new OcrServiceError('ocr-unavailable', 'The PaddleOCR service has stopped.')
    this.throwIfCancelled(attachmentId)
    const startedAt = Date.now()
    const cacheKey = createHash('sha256').update(this.profile).update(image).digest('hex')
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      onProgress?.({ progress: 1, stage: `Using cached PaddleOCR ${this.profile} text` })
      return { ...structuredClone(cached), attachmentId, cached: true, durationMs: Date.now() - startedAt }
    }

    await mkdir(this.options.runtimePath, { recursive: true })
    const temporaryPath = options.sourcePath
      ? null
      : join(this.options.runtimePath, `paddle-input-${randomUUID()}.png`)
    const imagePath = options.sourcePath ?? temporaryPath!
    if (temporaryPath) await writeFile(temporaryPath, image)

    onProgress?.({ progress: 0, stage: `Loading PaddleOCR ${this.profile}` })
    this.activeAttachmentId = attachmentId
    try {
      const payload = await this.request(attachmentId, imagePath)
      this.throwIfCancelled(attachmentId)
      const result = mapPaddleOcrPayload(attachmentId, payload, size, Date.now() - startedAt)
      result.entities = mergeEntities(await detectVisualCodes(image), result.entities ?? [])
      this.remember(cacheKey, result)
      onProgress?.({ progress: 1, stage: `PaddleOCR ${this.profile} completed` })
      return structuredClone(result)
    } catch (error) {
      if (this.cancelled.delete(attachmentId)) {
        throw new OcrServiceError('ocr-cancelled', 'PaddleOCR recognition was stopped.', { cause: error })
      }
      if (error instanceof OcrServiceError) throw error
      throw new OcrServiceError(
        'ocr-unavailable',
        error instanceof Error ? error.message : String(error),
        { cause: error }
      )
    } finally {
      if (this.activeAttachmentId === attachmentId) this.activeAttachmentId = null
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined)
    }
  }

  private async request(attachmentId: string, imagePath: string): Promise<PaddleOcrPayload> {
    const process = await this.getProcess()
    const requestId = randomUUID()
    return new Promise<PaddleOcrPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        this.stopProcess(new OcrServiceError('ocr-unavailable', `PaddleOCR ${this.profile} timed out.`))
        reject(new OcrServiceError('ocr-unavailable', `PaddleOCR ${this.profile} timed out.`))
      }, this.timeoutMs)
      this.pending.set(requestId, { attachmentId, resolve, reject, timeout })
      process.stdin.write(`${JSON.stringify({ type: 'recognise', requestId, imagePath })}\n`, (error) => {
        if (!error) return
        clearTimeout(timeout)
        this.pending.delete(requestId)
        reject(new OcrServiceError('ocr-unavailable', error.message, { cause: error }))
      })
    })
  }

  private getProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.process) return Promise.resolve(this.process)
    if (this.processPromise) return this.processPromise
    this.processPromise = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      const startupTimeout = setTimeout(() => {
        this.stopProcess(new OcrServiceError('ocr-unavailable', `PaddleOCR ${this.profile} failed to start in time.`))
      }, this.timeoutMs)
      this.processReadyResolve = (process) => {
        clearTimeout(startupTimeout)
        resolve(process)
      }
      this.processReadyReject = (error) => {
        clearTimeout(startupTimeout)
        reject(error)
      }
      const child = spawn(this.options.pythonPath, [
        '-u',
        this.options.scriptPath,
        '--serve',
        '--profile',
        this.profile,
        '--cache-dir',
        this.options.runtimePath
      ], {
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          PADDLE_PDX_CACHE_HOME: this.options.runtimePath,
          PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: '1'
        }
      })
      this.startingProcess = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.consumeOutput(chunk))
      child.stderr.on('data', (chunk: string) => {
        const message = chunk.trim()
        if (message) console.info(`[paddle-ocr] ${message.slice(-2_000)}`)
      })
      child.once('error', (error) => {
        if (this.process !== child && this.startingProcess !== child) return
        this.stopProcess(new OcrServiceError(
          'ocr-unavailable',
          `Could not start PaddleOCR using ${this.options.pythonPath}: ${error.message}`,
          { cause: error }
        ))
      })
      child.once('close', (code) => {
        if (this.process !== child && this.startingProcess !== child) return
        this.stopProcess(new OcrServiceError(
          'ocr-unavailable',
          `PaddleOCR exited with code ${code ?? 'unknown'}.`
        ))
      })
    })
    return this.processPromise
  }

  private consumeOutput(chunk: string): void {
    this.stdoutBuffer += chunk
    if (this.stdoutBuffer.length > MAX_OUTPUT_LINE_LENGTH) {
      this.stopProcess(new OcrServiceError('ocr-failed', 'PaddleOCR returned too much data.'))
      return
    }
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line) this.consumeMessage(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private consumeMessage(line: string): void {
    let message: SidecarMessage
    try {
      message = JSON.parse(line) as SidecarMessage
    } catch {
      console.info(`[paddle-ocr] ${line.slice(-1_000)}`)
      return
    }
    if (message.type === 'ready') {
      const ready = this.startingProcess
      if (!ready) return
      this.startingProcess = null
      this.process = ready
      this.processReadyResolve?.(ready)
      this.processReadyResolve = null
      this.processReadyReject = null
      return
    }
    if (!message.requestId) return
    const request = this.pending.get(message.requestId)
    if (!request) return
    clearTimeout(request.timeout)
    this.pending.delete(message.requestId)
    if (message.type === 'error') {
      request.reject(new OcrServiceError('ocr-failed', message.message || 'PaddleOCR recognition failed.'))
      return
    }
    if (
      message.type !== 'result' ||
      !isPaddleOcrProfile(message.profile) ||
      typeof message.detector !== 'string' ||
      typeof message.recognizer !== 'string' ||
      !Array.isArray(message.lines)
    ) {
      request.reject(new OcrServiceError('ocr-failed', 'PaddleOCR returned an invalid result.'))
      return
    }
    request.resolve({
      profile: message.profile,
      detector: message.detector,
      recognizer: message.recognizer,
      lines: message.lines,
      inferenceMs: message.inferenceMs
    })
  }

  private stopProcess(error: Error): void {
    const child = this.process ?? this.startingProcess
    this.process = null
    this.startingProcess = null
    this.processPromise = null
    this.stdoutBuffer = ''
    this.processReadyReject?.(error)
    this.processReadyResolve = null
    this.processReadyReject = null
    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timeout)
      request.reject(error)
      this.pending.delete(requestId)
    }
    if (child && !child.killed) child.kill()
  }

  private remember(cacheKey: string, result: OcrResult): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest) this.cache.delete(oldest)
    }
    this.cache.set(cacheKey, structuredClone(result))
  }

  private throwIfCancelled(attachmentId: string): void {
    if (!this.cancelled.delete(attachmentId)) return
    throw new OcrServiceError('ocr-cancelled', 'PaddleOCR recognition was stopped.')
  }
}

export class PaddleFirstOcrService implements OcrService {
  constructor(
    private readonly paddle: OcrService,
    private readonly fallback: OcrService
  ) {}

  async recognise(
    attachmentId: string,
    image: Buffer,
    size: OcrImageSize,
    onProgress?: (progress: OcrProgress) => void,
    options: OcrRecognitionOptions = {}
  ): Promise<OcrResult> {
    try {
      const result = await this.paddle.recognise(attachmentId, image, size, onProgress, options)
      if (result.text.trim()) return result
    } catch (error) {
      if (error instanceof OcrServiceError && error.code === 'ocr-cancelled') throw error
    }
    onProgress?.({ progress: 0, stage: 'Using bundled Tesseract recognition' })
    return this.fallback.recognise(attachmentId, image, size, onProgress, options)
  }

  async listLanguages(): Promise<OcrLanguage[]> {
    return this.paddle.listLanguages?.() ?? this.fallback.listLanguages?.() ?? []
  }

  async cancel(attachmentId: string): Promise<void> {
    await Promise.allSettled([
      this.paddle.cancel?.(attachmentId),
      this.fallback.cancel?.(attachmentId)
    ])
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.paddle.dispose(), this.fallback.dispose()])
  }
}

export function mapPaddleOcrPayload(
  attachmentId: string,
  payload: PaddleOcrPayload,
  size: OcrImageSize,
  durationMs = payload.inferenceMs ?? 0
): OcrResult {
  const width = Math.max(1, size.width)
  const height = Math.max(1, size.height)
  const regions = payload.lines
    .slice(0, MAX_REGIONS)
    .map((line, index): OcrRegion | null => {
      const text = normaliseLine(line.text)
      if (!text) return null
      const [rawLeft, rawTop, rawRight, rawBottom] = line.bounds
      const left = clamp(rawLeft / width, 0, 1)
      const top = clamp(rawTop / height, 0, 1)
      const right = clamp(rawRight / width, left, 1)
      const bottom = clamp(rawBottom / height, top, 1)
      return {
        id: `line-${index + 1}`,
        text,
        confidence: normaliseConfidence(line.confidence),
        bounds: {
          x: roundNormalised(left),
          y: roundNormalised(top),
          width: roundNormalised(right - left),
          height: roundNormalised(bottom - top)
        }
      }
    })
    .filter((line): line is OcrRegion => Boolean(line))
  const fullText = regions.map(({ text }) => text).join('\n')
  const text = fullText.slice(0, MAX_TEXT_LENGTH)
  const confidence = weightedConfidence(regions)
  return {
    attachmentId,
    text,
    confidence,
    quality: confidence < LOW_CONFIDENCE_THRESHOLD ? 'low-confidence' : 'normal',
    language: structuredClone(MULTILINGUAL),
    regions,
    entities: detectOcrEntities(text),
    truncated: payload.lines.length > MAX_REGIONS || fullText.length > MAX_TEXT_LENGTH,
    engine: 'paddle',
    paddleProfile: payload.profile,
    paddleModels: {
      detector: payload.detector,
      recognizer: payload.recognizer
    },
    cached: false,
    preprocessing: 'none',
    durationMs
  }
}

export function resolvePaddleOcrProfile(value: string | undefined): PaddleOcrProfile {
  return isPaddleOcrProfile(value) ? value : 'small'
}

function isPaddleOcrProfile(value: unknown): value is PaddleOcrProfile {
  return value === 'small' || value === 'medium' || value === 'large'
}

function weightedConfidence(regions: OcrRegion[]): number {
  let weight = 0
  let total = 0
  for (const region of regions) {
    const regionWeight = Math.max(1, region.text.length)
    weight += regionWeight
    total += region.confidence * regionWeight
  }
  return weight ? Math.round(total / weight) : 0
}

function normaliseLine(value: string): string {
  return value.replaceAll('\0', '').replace(/\s+/g, ' ').trim()
}

function normaliseConfidence(value: number): number {
  const percent = value <= 1 ? value * 100 : value
  return Math.round(clamp(Number.isFinite(percent) ? percent : 0, 0, 100))
}

function mergeEntities(...groups: OcrEntity[][]): OcrEntity[] {
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function roundNormalised(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
