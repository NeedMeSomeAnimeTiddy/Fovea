import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { OcrEntity, OcrResult } from '@shared/types/app'
import {
  detectOcrEntities,
  detectVisualCodes,
  layoutAwareLineText,
  OcrServiceError,
  type OcrImageSize,
  type OcrProgress,
  type OcrRecognitionOptions,
  type OcrService
} from './ocr-service'
import { correctOcrGeometry } from './document-image'

const MAX_OUTPUT_LENGTH = 2_000_000
const MAX_REGIONS = 2_000
const MAX_TEXT_LENGTH = 100_000
const NATIVE_TIMEOUT_MS = 15_000
const CACHE_LIMIT = 8
const execFileAsync = promisify(execFile)

interface WindowsOcrLine {
  text: string
  x: number
  y: number
  width: number
  height: number
  words?: Array<{
    text: string
    x: number
    y: number
    width: number
    height: number
  }>
}

export interface WindowsOcrPayload {
  language: {
    code: string
    label: string
  }
  lines: WindowsOcrLine[]
  textAngle: number | null
}

export class WindowsOcrService implements OcrService {
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>()
  private readonly cancelled = new Set<string>()
  private readonly cache = new Map<string, OcrResult>()
  private languagePromise: Promise<OcrResult['language'][]> | null = null
  private disposed = false

  constructor(
    private readonly scriptPath: string,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async recognise(
    attachmentId: string,
    image: Buffer,
    size: OcrImageSize,
    onProgress?: (progress: OcrProgress) => void,
    options: OcrRecognitionOptions = {}
  ): Promise<OcrResult> {
    const { sourcePath, languageCode } = options
    if (this.disposed || this.platform !== 'win32' || !sourcePath) {
      throw new OcrServiceError('ocr-unavailable', 'Windows text recognition is unavailable.')
    }
    if (this.cancelled.delete(attachmentId)) {
      throw new OcrServiceError('ocr-cancelled', 'Text extraction was stopped.')
    }
    const startedAt = Date.now()
    const cacheKey = createHash('sha256').update(languageCode ?? 'automatic').update(image).digest('hex')
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      onProgress?.({ progress: 1, stage: 'Using cached text' })
      return { ...structuredClone(cached), attachmentId, cached: true, durationMs: Date.now() - startedAt }
    }
    const visualCodes = detectVisualCodes(image)
    onProgress?.({ progress: 0.05, stage: 'Using Windows text recognition' })
    try {
      const payload = JSON.parse(await this.runPowerShell(attachmentId, sourcePath, languageCode)) as WindowsOcrPayload
      if (this.cancelled.delete(attachmentId)) {
        throw new OcrServiceError('ocr-cancelled', 'Text extraction was stopped.')
      }
      const result = mapWindowsOcrPayload(attachmentId, payload, size, Date.now() - startedAt)
      result.entities = mergeEntities(await visualCodes, result.entities ?? [])
      this.remember(cacheKey, result)
      onProgress?.({ progress: 1, stage: 'Text recognised locally' })
      return result
    } catch (error) {
      if (this.cancelled.delete(attachmentId)) {
        throw new OcrServiceError('ocr-cancelled', 'Text extraction was stopped.', { cause: error })
      }
      if (error instanceof OcrServiceError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new OcrServiceError('ocr-unavailable', message, { cause: error })
    }
  }

  async listLanguages(): Promise<OcrResult['language'][]> {
    if (this.platform !== 'win32') return []
    if (!this.languagePromise) {
      this.languagePromise = execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.scriptPath,
        '-ListLanguages'
      ], { encoding: 'utf8', timeout: NATIVE_TIMEOUT_MS, windowsHide: true })
        .then(({ stdout }) => {
          const languages = JSON.parse(stdout.trim()) as Array<{ code?: string; label?: string }>
          return languages
            .filter(({ code, label }) => Boolean(code?.trim() && label?.trim()))
            .map(({ code, label }) => ({
              code: code!.trim(),
              label: label!.trim(),
              source: 'configured' as const
            }))
        })
        .catch(() => [])
    }
    return structuredClone(await this.languagePromise)
  }

  async cancel(attachmentId: string): Promise<void> {
    const child = this.active.get(attachmentId)
    if (!child) return
    this.cancelled.add(attachmentId)
    child.kill()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const child of this.active.values()) child.kill()
    this.active.clear()
  }

  private remember(cacheKey: string, result: OcrResult): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest) this.cache.delete(oldest)
    }
    this.cache.set(cacheKey, structuredClone(result))
  }

  private runPowerShell(attachmentId: string, sourcePath: string, languageCode?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const arguments_ = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.scriptPath,
        sourcePath
      ]
      if (languageCode) arguments_.push('-LanguageTag', languageCode)
      const child = spawn('powershell.exe', arguments_, { windowsHide: true })
      this.active.set(attachmentId, child)
      child.stdin.end()
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (operation: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.active.delete(attachmentId)
        operation()
      }
      const timeout = setTimeout(() => {
        child.kill()
        finish(() => reject(new OcrServiceError('ocr-unavailable', 'Windows text recognition timed out.')))
      }, NATIVE_TIMEOUT_MS)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
        if (stdout.length > MAX_OUTPUT_LENGTH) {
          child.kill()
          finish(() => reject(new OcrServiceError('ocr-failed', 'Windows OCR returned too much data.')))
        }
      })
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8_000)
      })
      child.once('error', (error) => finish(() => reject(error)))
      child.once('close', (code) => {
        if (code === 0 && stdout.trim()) finish(() => resolve(stdout.trim()))
        else finish(() => reject(new Error(stderr.trim() || `Windows OCR exited with code ${code ?? 'unknown'}.`)))
      })
    })
  }
}

export class NativeFirstOcrService implements OcrService {
  private readonly active = new Set<string>()
  private readonly cancelled = new Set<string>()

  constructor(
    private readonly native: OcrService,
    private readonly fallback: OcrService
  ) {}

  async recognise(
    attachmentId: string,
    image: Buffer,
    size: OcrImageSize,
    onProgress?: (progress: OcrProgress) => void,
    options: OcrRecognitionOptions = {}
  ): Promise<OcrResult> {
    this.active.add(attachmentId)
    let correctedPath: string | undefined
    try {
      onProgress?.({ progress: 0, stage: options.preserveGeometry ? 'Preparing screen recognition' : 'Checking document alignment' })
      const corrected = options.preserveGeometry
        ? {
            image,
            size: { width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) },
            correction: 'none' as const,
            angle: 0
          }
        : await correctOcrGeometry(image, size)
      this.throwIfCancelled(attachmentId)
      const correctedOptions = { ...options }
      if (corrected.correction !== 'none' && options.sourcePath) {
        correctedPath = `${options.sourcePath}.ocr-${randomUUID()}.png`
        await writeFile(correctedPath, corrected.image)
        this.throwIfCancelled(attachmentId)
        correctedOptions.sourcePath = correctedPath
      }
      const applyCorrection = (result: OcrResult): OcrResult => corrected.correction === 'none'
        ? result
        : { ...result, geometryCorrection: corrected.correction }
      if (options.preserveGeometry) {
        onProgress?.({ progress: 0, stage: 'Comparing screen text recognition' })
        const [nativeAttempt, fallbackAttempt] = await Promise.allSettled([
          this.native.recognise(
            attachmentId,
            corrected.image,
            corrected.size,
            onProgress,
            correctedOptions
          ),
          this.fallback.recognise(
            attachmentId,
            corrected.image,
            corrected.size,
            onProgress,
            correctedOptions
          )
        ])
        this.throwIfCancelled(attachmentId)
        const nativeResult = nativeAttempt.status === 'fulfilled' ? applyCorrection(nativeAttempt.value) : null
        const fallbackResult = fallbackAttempt.status === 'fulfilled' ? applyCorrection(fallbackAttempt.value) : null
        if (nativeResult && fallbackResult) {
          return resultQualityScore(fallbackResult) > resultQualityScore(nativeResult) ? fallbackResult : nativeResult
        }
        if (fallbackResult) return fallbackResult
        if (nativeResult) return nativeResult
        if (fallbackAttempt.status === 'rejected') throw fallbackAttempt.reason
        if (nativeAttempt.status === 'rejected') throw nativeAttempt.reason
        throw new OcrServiceError('ocr-unavailable', 'No local OCR engine returned a result.')
      }
      let nativeResult: OcrResult | null = null
      try {
        nativeResult = applyCorrection(await this.native.recognise(
          attachmentId,
          corrected.image,
          corrected.size,
          onProgress,
          correctedOptions
        ))
        if (!shouldCompareWithFallback(nativeResult, options.languageCode)) return nativeResult
      } catch (error) {
        if (error instanceof OcrServiceError && error.code === 'ocr-cancelled') throw error
      }
      onProgress?.({ progress: 0, stage: 'Using bundled text recognition' })
      try {
        const fallbackResult = applyCorrection(await this.fallback.recognise(
          attachmentId,
          corrected.image,
          corrected.size,
          onProgress,
          correctedOptions
        ))
        if (!nativeResult) return fallbackResult
        return resultQualityScore(fallbackResult) > resultQualityScore(nativeResult) ? fallbackResult : nativeResult
      } catch (error) {
        if (nativeResult) return nativeResult
        throw error
      }
    } finally {
      if (correctedPath) await unlink(correctedPath).catch(() => undefined)
      this.active.delete(attachmentId)
      this.cancelled.delete(attachmentId)
    }
  }

  async listLanguages(): Promise<OcrResult['language'][]> {
    const native = await this.native.listLanguages?.().catch(() => []) ?? []
    if (native.length) return native
    return this.fallback.listLanguages?.() ?? []
  }

  async cancel(attachmentId: string): Promise<void> {
    if (this.active.has(attachmentId)) this.cancelled.add(attachmentId)
    await Promise.allSettled([
      this.native.cancel?.(attachmentId),
      this.fallback.cancel?.(attachmentId)
    ])
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.native.dispose(), this.fallback.dispose()])
  }

  private throwIfCancelled(attachmentId: string): void {
    if (!this.cancelled.has(attachmentId)) return
    throw new OcrServiceError('ocr-cancelled', 'Text extraction was stopped.')
  }
}

export function shouldCompareWithFallback(result: OcrResult, languageCode?: string): boolean {
  if (languageCode && !/^en(?:-|$)/i.test(languageCode) && languageCode !== 'eng') return false
  const compact = result.text.replace(/\s/g, '')
  if (compact.length < 24) return true
  const suspicious = [...compact].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return character === '\uFFFD' || codePoint < 32
  }).length
  return suspicious > 0
}

export function resultQualityScore(result: OcrResult): number {
  const compact = result.text.replace(/\s/g, '')
  if (!compact) return 0
  const useful = [...compact].filter((character) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(character)).length
  const cleanliness = useful / Math.max(1, [...compact].length)
  const lengthScore = Math.min(2_000, compact.length) * cleanliness
  const confidenceScore = result.engine === 'windows' ? 225 : result.confidence * 3
  return Math.round(lengthScore + confidenceScore - (result.quality === 'low-confidence' ? 100 : 0))
}

export function mapWindowsOcrPayload(
  attachmentId: string,
  payload: WindowsOcrPayload,
  size: OcrImageSize,
  durationMs = 0
): OcrResult {
  const width = Math.max(1, size.width)
  const height = Math.max(1, size.height)
  const regions = payload.lines
    .slice(0, MAX_REGIONS)
    .map((line, index) => {
      const x = clamp(line.x / width, 0, 1)
      const y = clamp(line.y / height, 0, 1)
      return {
        id: `line-${index + 1}`,
        text: layoutAwareLineText(
          (line.words ?? []).map((word) => ({
            text: word.text,
            bbox: { x0: word.x, y0: word.y, x1: word.x + word.width, y1: word.y + word.height }
          })),
          line.text
        ),
        confidence: 0,
        bounds: {
          x,
          y,
          width: clamp(line.width / width, 0, 1 - x),
          height: clamp(line.height / height, 0, 1 - y)
        }
      }
    })
    .filter((line) => line.text)
  const wordCandidates = payload.lines.flatMap((line) => line.words ?? [])
  const words = wordCandidates
    .slice(0, MAX_REGIONS)
    .map((word, index) => {
      const text = word.text.replaceAll('\0', '').replace(/\s+/g, ' ').trim()
      const x = clamp(word.x / width, 0, 1)
      const y = clamp(word.y / height, 0, 1)
      return {
        id: `word-${index + 1}`,
        text,
        confidence: 0,
        bounds: {
          x,
          y,
          width: clamp(word.width / width, 0, 1 - x),
          height: clamp(word.height / height, 0, 1 - y)
        }
      }
    })
    .filter((word) => word.text)
  const fullText = regions.map((line) => line.text).join('\n')
  const text = fullText.slice(0, MAX_TEXT_LENGTH)
  return {
    attachmentId,
    text,
    confidence: 0,
    quality: 'normal',
    language: {
      code: payload.language.code || 'und',
      label: payload.language.label || payload.language.code || 'Windows language',
      source: 'detected'
    },
    regions,
    words,
    entities: detectOcrEntities(text),
    truncated: payload.lines.length > MAX_REGIONS || wordCandidates.length > MAX_REGIONS || fullText.length > MAX_TEXT_LENGTH,
    engine: 'windows',
    cached: false,
    preprocessing: 'none',
    durationMs
  }
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
