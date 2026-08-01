import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import sharp from 'sharp'
import type { OcrBounds, OcrEntity, OcrRegion, OcrResult } from '@shared/types/app'
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
const MIN_SCREEN_CHARACTERS_BEFORE_FULL_REFINEMENT = 24
const MAX_NATIVE_FRAGMENT_RATIO = 0.8
const MIN_REFINEMENT_LINES_FOR_DENSITY_GATE = 8
const MIN_REFINEMENT_CHARACTERS_PER_LINE = 4
const MIN_SUBSTANTIAL_REFINEMENT_CHARACTERS = 180
const MAX_REFINEMENT_FRAGMENT_RATIO = 0.65
const REFINEMENT_GRID_COLUMNS = 6
const REFINEMENT_GRID_ROWS = 4
const MAX_REFINEMENT_TILES = 6
const REFINEMENT_PREVIEW_WIDTH = 960
const REFINEMENT_PREVIEW_HEIGHT = 540
const REFINEMENT_EDGE_THRESHOLD = 42
const MIN_REFINEMENT_EDGE_DENSITY = 0.004
const MIN_REFINEMENT_EDGE_CONCENTRATION = 0.3
const REFINEMENT_GUTTER = 12
const execFileAsync = promisify(execFile)

export interface PixelBounds {
  left: number
  top: number
  width: number
  height: number
}

export interface FrozenScreenRefinementPanel {
  source: PixelBounds
  destination: PixelBounds
}

export interface FrozenScreenRefinementPlan {
  image: Buffer
  size: OcrImageSize
  panels: FrozenScreenRefinementPanel[]
  screenSize: OcrImageSize
  coverage: number
}

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
        onProgress?.({ progress: 0, stage: 'Reading frozen-screen text' })
        let nativeResult: OcrResult | null = null
        let nativeFailure: unknown
        try {
          nativeResult = applyCorrection(await this.native.recognise(
            attachmentId,
            corrected.image,
            corrected.size,
            onProgress,
            correctedOptions
          ))
          this.throwIfCancelled(attachmentId)
          if (nativeResult.regions.length) {
            onProgress?.({
              progress: 0.45,
              stage: 'Fast screen text ready',
              result: structuredClone(nativeResult)
            })
          }
        } catch (error) {
          if (error instanceof OcrServiceError && error.code === 'ocr-cancelled') throw error
          nativeFailure = error
        }

        this.throwIfCancelled(attachmentId)
        const useFullScreenFallback = !nativeResult || shouldRefineFrozenScreenOcr(nativeResult)
        const refinementPlan = nativeResult && !useFullScreenFallback
          ? await prepareFrozenScreenRefinement(
              corrected.image,
              corrected.size,
              nativeResult,
              correctedOptions.refinementRegions ?? []
            )
          : null
        this.throwIfCancelled(attachmentId)
        if (nativeResult && !useFullScreenFallback && !refinementPlan) {
          const metrics = screenOcrMetrics(nativeResult)
          onProgress?.({ progress: 1, stage: 'Screen text ready' })
          console.info(
            `[ocr] Windows found ${metrics.lineCount} lines/${metrics.characterCount} chars and ` +
            `no uncovered text-like regions required Paddle refinement.`
          )
          return nativeResult
        }

        if (refinementPlan) {
          console.info(
            `[ocr] Refining ${refinementPlan.panels.length} uncovered screen regions ` +
            `covering ${Math.round(refinementPlan.coverage * 100)}% of the frozen screen.`
          )
        }
        onProgress?.({
          progress: 0.5,
          stage: refinementPlan
            ? 'Refining uncovered screen text'
            : nativeResult
              ? 'Refining sparse screen text'
              : 'Using bundled screen recognition'
        })
        await this.fallback.prepare?.().catch(() => undefined)
        this.throwIfCancelled(attachmentId)
        let fallbackResult: OcrResult | null = null
        let fallbackFailure: unknown
        try {
          const rawFallbackResult = await this.fallback.recognise(
            attachmentId,
            refinementPlan?.image ?? corrected.image,
            refinementPlan?.size ?? corrected.size,
            refinementPlan
              ? (progress) => onProgress?.({
                  progress: 0.5 + progress.progress * 0.45,
                  stage: progress.stage
                })
              : onProgress,
            refinementPlan
              ? {
                  ...correctedOptions,
                  sourcePath: undefined,
                  refinementRegions: undefined,
                  selectiveScreenRefinement: true
                }
              : correctedOptions
          )
          fallbackResult = refinementPlan
            ? mapFrozenScreenRefinementResult(rawFallbackResult, refinementPlan)
            : applyCorrection(rawFallbackResult)
        } catch (error) {
          if (error instanceof OcrServiceError && error.code === 'ocr-cancelled') throw error
          fallbackFailure = error
        }
        this.throwIfCancelled(attachmentId)
        if (nativeResult && fallbackResult) {
          const rejection = screenRefinementRejectionReason(nativeResult, fallbackResult, Boolean(refinementPlan))
          if (rejection) {
            console.info(
              `[ocr] Discarded ${resultSummary(fallbackResult)} refinement: ${rejection}; ` +
              `kept ${resultSummary(nativeResult)}.`
            )
            return nativeResult
          }
          const merged = mergeScreenOcrResults(nativeResult, fallbackResult)
          onProgress?.({
            progress: 1,
            stage: refinementPlan ? 'Uncovered screen text added' : 'Screen text ready',
            result: structuredClone(merged)
          })
          console.info(
            `[ocr] ${refinementPlan ? 'Selective frozen-screen comparison' : 'Frozen-screen comparison'}: ` +
            `${resultSummary(nativeResult)}; ` +
            `${resultSummary(fallbackResult)}; merged ${merged.regions.length} lines using ${merged.engine ?? 'unknown'}.`
          )
          return merged
        }
        if (fallbackResult) {
          console.info(`[ocr] Frozen-screen comparison: Windows unavailable; ${resultSummary(fallbackResult)}.`)
          return fallbackResult
        }
        if (nativeResult) {
          console.info(`[ocr] Frozen-screen comparison: ${resultSummary(nativeResult)}; fallback unavailable.`)
          return nativeResult
        }
        if (fallbackFailure) throw fallbackFailure
        if (nativeFailure) throw nativeFailure
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

export async function prepareFrozenScreenRefinement(
  image: Buffer,
  size: OcrImageSize,
  nativeResult: OcrResult,
  refinementHints: OcrBounds[] = []
): Promise<FrozenScreenRefinementPlan | null> {
  const screenSize = {
    width: Math.max(1, Math.round(size.width)),
    height: Math.max(1, Math.round(size.height))
  }
  if (screenSize.width < 64 || screenSize.height < 64) return null

  try {
    const previewScale = Math.min(
      1,
      REFINEMENT_PREVIEW_WIDTH / screenSize.width,
      REFINEMENT_PREVIEW_HEIGHT / screenSize.height
    )
    const previewWidth = Math.max(1, Math.round(screenSize.width * previewScale))
    const previewHeight = Math.max(1, Math.round(screenSize.height * previewScale))
    const preview = await sharp(image)
      .resize(previewWidth, previewHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .grayscale()
      .raw()
      .toBuffer()
    const knownTextMask = new Uint8Array(previewWidth * previewHeight)
    for (const { bounds } of nativeResult.regions) {
      const left = Math.max(0, Math.floor(bounds.x * previewWidth) - 2)
      const top = Math.max(0, Math.floor(bounds.y * previewHeight) - 2)
      const right = Math.min(previewWidth, Math.ceil((bounds.x + bounds.width) * previewWidth) + 2)
      const bottom = Math.min(previewHeight, Math.ceil((bounds.y + bounds.height) * previewHeight) + 2)
      for (let y = top; y < bottom; y += 1) {
        knownTextMask.fill(1, y * previewWidth + left, y * previewWidth + right)
      }
    }

    const nativeTiles = new Set(nativeResult.regions.map(({ bounds }) =>
      refinementTileKey(
        Math.floor(clamp(bounds.x + bounds.width / 2, 0, 0.999_999) * REFINEMENT_GRID_COLUMNS),
        Math.floor(clamp(bounds.y + bounds.height / 2, 0, 0.999_999) * REFINEMENT_GRID_ROWS)
      )
    ))
    const uncoveredHintTiles = new Set(refinementHints
      .filter((hint) =>
        validNormalisedBounds(hint) &&
        !nativeResult.regions.some(({ bounds }) =>
          boundsIntersection(bounds, hint) / Math.max(0.000_001, hint.width * hint.height) >= 0.45
        )
      )
      .map((hint) => refinementTileKey(
        Math.floor(clamp(hint.x + hint.width / 2, 0, 0.999_999) * REFINEMENT_GRID_COLUMNS),
        Math.floor(clamp(hint.y + hint.height / 2, 0, 0.999_999) * REFINEMENT_GRID_ROWS)
      )))

    const candidates: Array<{
      column: number
      row: number
      score: number
      hinted: boolean
    }> = []
    for (let row = 0; row < REFINEMENT_GRID_ROWS; row += 1) {
      const previewTop = Math.floor(row * previewHeight / REFINEMENT_GRID_ROWS)
      const previewBottom = Math.ceil((row + 1) * previewHeight / REFINEMENT_GRID_ROWS)
      for (let column = 0; column < REFINEMENT_GRID_COLUMNS; column += 1) {
        const previewLeft = Math.floor(column * previewWidth / REFINEMENT_GRID_COLUMNS)
        const previewRight = Math.ceil((column + 1) * previewWidth / REFINEMENT_GRID_COLUMNS)
        const rowEdges = new Array<number>(Math.max(1, previewBottom - previewTop)).fill(0)
        let edgeCount = 0
        for (let y = Math.max(1, previewTop); y < previewBottom; y += 1) {
          for (let x = Math.max(1, previewLeft); x < previewRight; x += 1) {
            const index = y * previewWidth + x
            if (knownTextMask[index]) continue
            const gradient = Math.abs(preview[index]! - preview[index - 1]!) +
              Math.abs(preview[index]! - preview[index - previewWidth]!)
            if (gradient < REFINEMENT_EDGE_THRESHOLD) continue
            edgeCount += 1
            rowEdges[y - previewTop] = (rowEdges[y - previewTop] ?? 0) + 1
          }
        }
        const tileArea = Math.max(1, (previewRight - previewLeft) * (previewBottom - previewTop))
        const edgeDensity = edgeCount / tileArea
        const concentratedRows = Math.max(1, Math.ceil(rowEdges.length * 0.25))
        const concentratedEdges = [...rowEdges]
          .sort((left, right) => right - left)
          .slice(0, concentratedRows)
          .reduce((sum, count) => sum + count, 0)
        const edgeConcentration = edgeCount ? concentratedEdges / edgeCount : 0
        const key = refinementTileKey(column, row)
        const hinted = uncoveredHintTiles.has(key)
        const adjacentToNative = [
          refinementTileKey(column - 1, row),
          refinementTileKey(column + 1, row),
          refinementTileKey(column, row - 1),
          refinementTileKey(column, row + 1)
        ].some((candidate) => nativeTiles.has(candidate))
        if (
          !hinted &&
          (edgeDensity < MIN_REFINEMENT_EDGE_DENSITY ||
            edgeConcentration < MIN_REFINEMENT_EDGE_CONCENTRATION)
        ) {
          continue
        }
        candidates.push({
          column,
          row,
          hinted,
          score: edgeDensity * (0.6 + edgeConcentration) +
            (hinted ? 0.2 : 0) +
            (adjacentToNative ? 0.025 : 0)
        })
      }
    }

    const selected = candidates
      .sort((left, right) =>
        Number(right.hinted) - Number(left.hinted) ||
        right.score - left.score ||
        left.row - right.row ||
        left.column - right.column
      )
      .slice(0, MAX_REFINEMENT_TILES)
    if (!selected.length) return null

    const sourcePadding = Math.max(8, Math.round(Math.min(screenSize.width, screenSize.height) * 0.006))
    const sources = selected.map(({ column, row }): PixelBounds => {
      const rawLeft = Math.floor(column * screenSize.width / REFINEMENT_GRID_COLUMNS)
      const rawTop = Math.floor(row * screenSize.height / REFINEMENT_GRID_ROWS)
      const rawRight = Math.ceil((column + 1) * screenSize.width / REFINEMENT_GRID_COLUMNS)
      const rawBottom = Math.ceil((row + 1) * screenSize.height / REFINEMENT_GRID_ROWS)
      const left = Math.max(0, rawLeft - sourcePadding)
      const top = Math.max(0, rawTop - sourcePadding)
      const right = Math.min(screenSize.width, rawRight + sourcePadding)
      const bottom = Math.min(screenSize.height, rawBottom + sourcePadding)
      return { left, top, width: right - left, height: bottom - top }
    })
    const montageColumns = Math.min(3, sources.length)
    const montageRows = Math.ceil(sources.length / montageColumns)
    const cellWidth = Math.max(...sources.map(({ width }) => width)) + REFINEMENT_GUTTER * 2
    const cellHeight = Math.max(...sources.map(({ height }) => height)) + REFINEMENT_GUTTER * 2
    const panels: FrozenScreenRefinementPanel[] = sources.map((source, index) => ({
      source,
      destination: {
        left: (index % montageColumns) * cellWidth + REFINEMENT_GUTTER,
        top: Math.floor(index / montageColumns) * cellHeight + REFINEMENT_GUTTER,
        width: source.width,
        height: source.height
      }
    }))
    const inputs = await Promise.all(panels.map(async ({ source, destination }) => ({
      input: await sharp(image).extract(source).png().toBuffer(),
      left: destination.left,
      top: destination.top
    })))
    const montageSize = {
      width: montageColumns * cellWidth,
      height: montageRows * cellHeight
    }
    const montage = await sharp({
      create: {
        width: montageSize.width,
        height: montageSize.height,
        channels: 3,
        background: { r: 127, g: 127, b: 127 }
      }
    }).composite(inputs).png().toBuffer()
    return {
      image: montage,
      size: montageSize,
      panels,
      screenSize,
      coverage: selected.length / (REFINEMENT_GRID_COLUMNS * REFINEMENT_GRID_ROWS)
    }
  } catch (error) {
    console.warn(`[ocr] Could not prepare selective screen refinement: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export function mapFrozenScreenRefinementResult(
  result: OcrResult,
  plan: FrozenScreenRefinementPlan
): OcrResult {
  const mapRegions = (regions: OcrRegion[] | undefined, prefix: 'line' | 'word'): OcrRegion[] =>
    (regions ?? [])
      .map((region) => mapFrozenScreenRefinementRegion(region, plan))
      .filter((region): region is OcrRegion => Boolean(region))
      .sort((left, right) => left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x)
      .slice(0, MAX_REGIONS)
      .map((region, index) => ({ ...region, id: `${prefix}-${index + 1}` }))
  const regions = mapRegions(result.regions, 'line')
  const words = mapRegions(result.words, 'word')
  const text = regions.map(({ text }) => text).join('\n').slice(0, MAX_TEXT_LENGTH)
  const confidence = regions.length
    ? Math.round(regions.reduce((sum, { confidence: value }) => sum + value, 0) / regions.length)
    : 0
  return {
    ...result,
    text,
    confidence,
    quality: confidence < 60 ? 'low-confidence' : 'normal',
    regions,
    words: words.length ? words : undefined,
    entities: detectOcrEntities(text),
    truncated: result.truncated || text.length >= MAX_TEXT_LENGTH
  }
}

function mapFrozenScreenRefinementRegion(
  region: OcrRegion,
  plan: FrozenScreenRefinementPlan
): OcrRegion | null {
  const text = region.text.replaceAll('\0', '').replace(/\s+/g, ' ').trim()
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return null
  if (region.confidence > 0 && region.confidence < 50) return null
  if ([...text.replace(/\s/g, '')].length <= 2 && region.confidence > 0 && region.confidence < 72) return null

  const rawLeft = region.bounds.x * plan.size.width
  const rawTop = region.bounds.y * plan.size.height
  const rawRight = (region.bounds.x + region.bounds.width) * plan.size.width
  const rawBottom = (region.bounds.y + region.bounds.height) * plan.size.height
  const centerX = (rawLeft + rawRight) / 2
  const centerY = (rawTop + rawBottom) / 2
  const panel = plan.panels.find(({ destination }) =>
    centerX >= destination.left &&
    centerX <= destination.left + destination.width &&
    centerY >= destination.top &&
    centerY <= destination.top + destination.height
  )
  if (!panel) return null

  const clippedLeft = Math.max(rawLeft, panel.destination.left)
  const clippedTop = Math.max(rawTop, panel.destination.top)
  const clippedRight = Math.min(rawRight, panel.destination.left + panel.destination.width)
  const clippedBottom = Math.min(rawBottom, panel.destination.top + panel.destination.height)
  if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return null
  const retainedArea = (clippedRight - clippedLeft) * (clippedBottom - clippedTop)
  const rawArea = Math.max(1, (rawRight - rawLeft) * (rawBottom - rawTop))
  if (retainedArea / rawArea < 0.45) return null

  const screenLeft = panel.source.left + clippedLeft - panel.destination.left
  const screenTop = panel.source.top + clippedTop - panel.destination.top
  const screenRight = panel.source.left + clippedRight - panel.destination.left
  const screenBottom = panel.source.top + clippedBottom - panel.destination.top
  const left = clamp(screenLeft / plan.screenSize.width, 0, 1)
  const top = clamp(screenTop / plan.screenSize.height, 0, 1)
  const right = clamp(screenRight / plan.screenSize.width, left, 1)
  const bottom = clamp(screenBottom / plan.screenSize.height, top, 1)
  if (right <= left || bottom <= top) return null
  return {
    ...region,
    text,
    bounds: {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    }
  }
}

function refinementTileKey(column: number, row: number): string {
  return `${column}:${row}`
}

function validNormalisedBounds(bounds: OcrBounds): boolean {
  return Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x < 1 &&
    bounds.y < 1 &&
    bounds.x + bounds.width > 0 &&
    bounds.y + bounds.height > 0
}

export function shouldRefineFrozenScreenOcr(result: OcrResult): boolean {
  const metrics = screenOcrMetrics(result)
  if (!metrics.lineCount || metrics.characterCount < MIN_SCREEN_CHARACTERS_BEFORE_FULL_REFINEMENT) return true
  if (
    metrics.fragmentRatio > MAX_NATIVE_FRAGMENT_RATIO &&
    metrics.characterCount < MIN_SCREEN_CHARACTERS_BEFORE_FULL_REFINEMENT * 2
  ) {
    return true
  }
  return false
}

export function shouldAcceptFrozenScreenRefinement(
  nativeResult: OcrResult,
  fallbackResult: OcrResult
): boolean {
  return screenRefinementRejectionReason(nativeResult, fallbackResult) === null
}

interface ScreenOcrMetrics {
  lineCount: number
  characterCount: number
  averageCharactersPerLine: number
  fragmentRatio: number
}

function screenOcrMetrics(result: Pick<OcrResult, 'regions' | 'text'>): ScreenOcrMetrics {
  const texts = result.regions
    .map(({ text }) => text.replaceAll('\0', '').trim())
    .filter(Boolean)
  if (!texts.length && result.text.trim()) {
    texts.push(...result.text.split(/\r?\n/).map((text) => text.trim()).filter(Boolean))
  }
  const characterCounts = texts.map((text) => [...text.replace(/\s/g, '')].length)
  const characterCount = characterCounts.reduce((sum, count) => sum + count, 0)
  const fragmentCount = characterCounts.filter((count) => count <= 3).length
  return {
    lineCount: texts.length,
    characterCount,
    averageCharactersPerLine: texts.length ? characterCount / texts.length : 0,
    fragmentRatio: texts.length ? fragmentCount / texts.length : 0
  }
}

function screenRefinementRejectionReason(
  nativeResult: OcrResult,
  fallbackResult: OcrResult,
  selectiveRefinement = false
): string | null {
  const fallbackMetrics = screenOcrMetrics(fallbackResult)
  if (!fallbackMetrics.lineCount || !fallbackMetrics.characterCount) return 'it returned no usable text'
  if (selectiveRefinement) return null
  if (
    fallbackMetrics.lineCount >= MIN_REFINEMENT_LINES_FOR_DENSITY_GATE &&
    fallbackMetrics.averageCharactersPerLine < MIN_REFINEMENT_CHARACTERS_PER_LINE
  ) {
    return `fragment density was too high (${fallbackMetrics.averageCharactersPerLine.toFixed(1)} chars/line)`
  }

  const nativeMetrics = screenOcrMetrics(nativeResult)
  if (
    fallbackMetrics.lineCount >= MIN_REFINEMENT_LINES_FOR_DENSITY_GATE &&
    fallbackMetrics.fragmentRatio >= MAX_REFINEMENT_FRAGMENT_RATIO &&
    fallbackMetrics.characterCount < Math.max(MIN_SUBSTANTIAL_REFINEMENT_CHARACTERS, nativeMetrics.characterCount * 0.5)
  ) {
    return `${Math.round(fallbackMetrics.fragmentRatio * 100)}% of its lines were short fragments`
  }

  const complementaryRegions = fallbackResult.regions.filter((candidate) =>
    !nativeResult.regions.some((existing) => duplicateOcrRegion(existing, candidate))
  )
  if (complementaryRegions.length >= MIN_REFINEMENT_LINES_FOR_DENSITY_GATE) {
    const complementaryMetrics = screenOcrMetrics({ regions: complementaryRegions, text: '' })
    if (complementaryMetrics.averageCharactersPerLine < MIN_REFINEMENT_CHARACTERS_PER_LINE) {
      return `new regions averaged only ${complementaryMetrics.averageCharactersPerLine.toFixed(1)} chars/line`
    }
  }
  return null
}

export function mergeScreenOcrResults(nativeResult: OcrResult, fallbackResult: OcrResult): OcrResult {
  if (!nativeResult.regions.length) return structuredClone(fallbackResult)
  if (!fallbackResult.regions.length) return structuredClone(nativeResult)
  const regions = mergeOcrRegions(nativeResult.regions, fallbackResult.regions, 'line')
  const words = mergeOcrRegions(nativeResult.words ?? [], fallbackResult.words ?? [], 'word')
  const text = regions.map(({ text }) => text).join('\n').slice(0, MAX_TEXT_LENGTH)
  return {
    ...nativeResult,
    text,
    regions,
    words: words.length ? words : undefined,
    entities: mergeEntities(nativeResult.entities ?? [], fallbackResult.entities ?? []),
    truncated: nativeResult.truncated || fallbackResult.truncated || text.length >= MAX_TEXT_LENGTH,
    cached: nativeResult.cached === true && fallbackResult.cached === true,
    durationMs: Math.max(nativeResult.durationMs ?? 0, fallbackResult.durationMs ?? 0)
  }
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

function mergeOcrRegions(
  preferred: OcrResult['regions'],
  secondary: OcrResult['regions'],
  idPrefix: 'line' | 'word'
): OcrResult['regions'] {
  const merged: OcrResult['regions'] = []
  for (const candidate of [...preferred, ...secondary]) {
    if (!candidate.text.trim() || candidate.bounds.width <= 0 || candidate.bounds.height <= 0) continue
    const duplicateIndex = merged.findIndex((existing) => duplicateOcrRegion(existing, candidate))
    if (duplicateIndex < 0) {
      merged.push(structuredClone(candidate))
      continue
    }
    merged[duplicateIndex] = preferOcrRegion(merged[duplicateIndex]!, candidate)
  }
  return merged
    .sort((left, right) => left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x)
    .slice(0, MAX_REGIONS)
    .map((region, index) => ({ ...region, id: `${idPrefix}-${index + 1}` }))
}

function duplicateOcrRegion(left: OcrResult['regions'][number], right: OcrResult['regions'][number]): boolean {
  const intersection = boundsIntersection(left.bounds, right.bounds)
  if (intersection <= 0) return false
  const leftArea = left.bounds.width * left.bounds.height
  const rightArea = right.bounds.width * right.bounds.height
  const containment = intersection / Math.max(0.000001, Math.min(leftArea, rightArea))
  const union = leftArea + rightArea - intersection
  const intersectionOverUnion = intersection / Math.max(0.000001, union)
  const leftText = normaliseComparisonText(left.text)
  const rightText = normaliseComparisonText(right.text)
  const labelsOverlap = Boolean(
    leftText &&
    rightText &&
    (leftText.includes(rightText) || rightText.includes(leftText))
  )
  return (labelsOverlap && (containment >= 0.72 || intersectionOverUnion >= 0.55)) ||
    containment >= 0.92 ||
    intersectionOverUnion >= 0.82
}

function preferOcrRegion(
  preferred: OcrResult['regions'][number],
  candidate: OcrResult['regions'][number]
): OcrResult['regions'][number] {
  const preferredText = normaliseComparisonText(preferred.text)
  const candidateText = normaliseComparisonText(candidate.text)
  const labelsOverlap = preferredText.includes(candidateText) || candidateText.includes(preferredText)
  if (!labelsOverlap) return preferred
  if (preferredText.includes(candidateText) && preferredText.length > candidateText.length) return preferred
  if (candidateText.includes(preferredText) && candidateText.length > preferredText.length) return structuredClone(candidate)
  const preferredConfidence = preferred.confidence === 0 ? 75 : preferred.confidence
  const candidateConfidence = candidate.confidence === 0 ? 75 : candidate.confidence
  return candidateConfidence > preferredConfidence + 8 ? structuredClone(candidate) : preferred
}

function boundsIntersection(left: OcrResult['regions'][number]['bounds'], right: OcrResult['regions'][number]['bounds']): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  )
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  )
  return width * height
}

function normaliseComparisonText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function resultSummary(result: OcrResult): string {
  return `${result.engine ?? 'unknown'} ${result.regions.length} lines/${result.text.length} chars/${result.confidence}%`
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
