import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptureFeature } from '@shared/types/app'

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_OUTPUT_LINE_LENGTH = 2_000_000
const MAX_DETECTIONS = 1_000

export interface ScreenshotImageSize {
  width: number
  height: number
}

export interface ScreenshotElementDetectionOptions {
  sourcePath?: string
}

export interface ScreenshotElementDetectionProgress {
  features: CaptureFeature[]
  stage: 'faces' | 'full-frame' | 'tiles'
  inferenceMs?: number
}

export interface ScreenshotElementDetector {
  prepare?(): Promise<void>
  detect(
    analysisId: string,
    image: Buffer,
    size: ScreenshotImageSize,
    onProgress?: (progress: ScreenshotElementDetectionProgress) => void,
    options?: ScreenshotElementDetectionOptions
  ): Promise<CaptureFeature[]>
  cancel?(analysisId: string): Promise<void>
  dispose?(): Promise<void>
}

export interface OmniParserDetectorServiceOptions {
  pythonPath: string
  scriptPath: string
  runtimePath: string
  omniParserRoot: string
  modelPath: string
  faceModelPath?: string
  device?: string
  confidence?: number
  faceConfidence?: number
  tileSize?: number
  tileOverlap?: number
  fullFrameLongSide?: number
  fullNative?: boolean
  maxDetections?: number
  timeoutMs?: number
}

interface DetectorPayload {
  detections: DetectorDetection[]
  inferenceMs?: number
  diagnostics?: {
    fullFrameSize?: [number, number]
    faceDetections?: number
    faceInferenceMs?: number
    fullDetections?: number
    fullInferenceMs?: number
    tileSize?: number
    tileOverlap?: number
    tileCount?: number
    tileDetections?: number
    tileInferenceMs?: number
    combinedDetections?: number
  }
}

interface DetectorDetection {
  confidence?: number
  source?: string
  kind?: 'control' | 'face'
  bounds?: [number, number, number, number]
}

interface SidecarMessage extends Partial<DetectorPayload> {
  type?: string
  requestId?: string
  message?: string
  stage?: string
  model?: string
  modelPath?: string
  device?: string
  loadMs?: number
}

interface PendingRequest {
  analysisId: string
  resolve(payload: DetectorPayload): void
  reject(error: Error): void
  onProgress?: (progress: ScreenshotElementDetectionProgress) => void
  timeout: NodeJS.Timeout
}

export class OmniParserDetectorService implements ScreenshotElementDetector {
  private readonly timeoutMs: number
  private readonly pending = new Map<string, PendingRequest>()
  private readonly cancelled = new Set<string>()
  private process: ChildProcessWithoutNullStreams | null = null
  private startingProcess: ChildProcessWithoutNullStreams | null = null
  private processPromise: Promise<ChildProcessWithoutNullStreams> | null = null
  private processReadyResolve: ((process: ChildProcessWithoutNullStreams) => void) | null = null
  private processReadyReject: ((error: Error) => void) | null = null
  private stdoutBuffer = ''
  private tail: Promise<void> = Promise.resolve()
  private activeAnalysisId: string | null = null
  private disposed = false

  constructor(private readonly options: OmniParserDetectorServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async prepare(): Promise<void> {
    await this.getProcess()
  }

  detect(
    analysisId: string,
    image: Buffer,
    size: ScreenshotImageSize,
    onProgress?: (progress: ScreenshotElementDetectionProgress) => void,
    options: ScreenshotElementDetectionOptions = {}
  ): Promise<CaptureFeature[]> {
    const operation = this.tail.then(
      () => this.performDetection(analysisId, image, size, onProgress, options),
      () => this.performDetection(analysisId, image, size, onProgress, options)
    )
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  async cancel(analysisId: string): Promise<void> {
    this.cancelled.add(analysisId)
    const request = [...this.pending.values()].find((candidate) => candidate.analysisId === analysisId)
    if (!request && this.activeAnalysisId !== analysisId) return
    this.stopProcess(new Error('OmniParser detection was stopped.'))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopProcess(new Error('The OmniParser detector has stopped.'))
    await this.tail
  }

  private async performDetection(
    analysisId: string,
    image: Buffer,
    _size: ScreenshotImageSize,
    onProgress: ((progress: ScreenshotElementDetectionProgress) => void) | undefined,
    options: ScreenshotElementDetectionOptions
  ): Promise<CaptureFeature[]> {
    if (this.disposed) throw new Error('The OmniParser detector has stopped.')
    this.throwIfCancelled(analysisId)
    await mkdir(this.options.runtimePath, { recursive: true })
    const temporaryPath = options.sourcePath
      ? null
      : join(this.options.runtimePath, `omniparser-input-${randomUUID()}.png`)
    const imagePath = options.sourcePath ?? temporaryPath!
    if (temporaryPath) await writeFile(temporaryPath, image)
    this.activeAnalysisId = analysisId
    try {
      const payload = await this.request(analysisId, imagePath, onProgress)
      this.throwIfCancelled(analysisId)
      return mapDetectorPayload(payload)
    } finally {
      if (this.activeAnalysisId === analysisId) this.activeAnalysisId = null
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined)
    }
  }

  private async request(
    analysisId: string,
    imagePath: string,
    onProgress?: (progress: ScreenshotElementDetectionProgress) => void
  ): Promise<DetectorPayload> {
    const process = await this.getProcess()
    const requestId = randomUUID()
    return new Promise<DetectorPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        this.stopProcess(new Error('OmniParser screen detection timed out.'))
        reject(new Error('OmniParser screen detection timed out.'))
      }, this.timeoutMs)
      this.pending.set(requestId, { analysisId, resolve, reject, onProgress, timeout })
      process.stdin.write(`${JSON.stringify({
        type: 'detect',
        requestId,
        imagePath,
        confidence: this.options.confidence,
        tileSize: this.options.tileSize,
        tileOverlap: this.options.tileOverlap,
        fullFrameLongSide: this.options.fullFrameLongSide,
        fullNative: this.options.fullNative,
        maxDetections: this.options.maxDetections
      })}\n`, (error) => {
        if (!error) return
        clearTimeout(timeout)
        this.pending.delete(requestId)
        reject(new Error(`Could not send the frozen screen to OmniParser: ${error.message}`, { cause: error }))
      })
    })
  }

  private getProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.process) return Promise.resolve(this.process)
    if (this.processPromise) return this.processPromise
    this.processPromise = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      const startupTimeout = setTimeout(() => {
        this.stopProcess(new Error('OmniParser failed to start in time.'))
      }, this.timeoutMs)
      this.processReadyResolve = (process) => {
        clearTimeout(startupTimeout)
        resolve(process)
      }
      this.processReadyReject = (error) => {
        clearTimeout(startupTimeout)
        reject(error)
      }
      const arguments_ = [
        '-u',
        this.options.scriptPath,
        '--serve',
        '--root',
        this.options.omniParserRoot,
        '--model',
        this.options.modelPath,
        '--device',
        this.options.device ?? 'auto',
        '--confidence',
        String(this.options.confidence ?? 0.08),
        '--tile-size',
        String(this.options.tileSize ?? 1280),
        '--tile-overlap',
        String(this.options.tileOverlap ?? 0.125),
        '--full-frame-long-side',
        String(this.options.fullFrameLongSide ?? 1920),
        '--max-detections',
        String(this.options.maxDetections ?? 500)
      ]
      if (this.options.faceModelPath) {
        arguments_.push(
          '--face-model', this.options.faceModelPath,
          '--face-confidence', String(this.options.faceConfidence ?? 0.82)
        )
      }
      if (this.options.fullNative) arguments_.push('--full-native')
      const child = spawn(this.options.pythonPath, arguments_, {
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1'
        }
      })
      this.startingProcess = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.consumeOutput(chunk))
      child.stderr.on('data', (chunk: string) => this.reportSidecarStderr(chunk))
      child.once('error', (error) => {
        if (this.process !== child && this.startingProcess !== child) return
        this.stopProcess(new Error(
          `Could not start OmniParser using ${this.options.pythonPath}: ${error.message}`,
          { cause: error }
        ))
      })
      child.once('close', (code) => {
        if (this.process !== child && this.startingProcess !== child) return
        this.stopProcess(new Error(`OmniParser exited with code ${code ?? 'unknown'}.`))
      })
    })
    return this.processPromise
  }

  private consumeOutput(chunk: string): void {
    this.stdoutBuffer += chunk
    if (this.stdoutBuffer.length > MAX_OUTPUT_LINE_LENGTH) {
      this.stopProcess(new Error('OmniParser returned too much data.'))
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
      console.info(`[omniparser] ${line.slice(-1_000)}`)
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
      console.info(
        `[omniparser] ${message.model ?? 'detector'} ready on ${message.device ?? 'unknown device'} ` +
        `in ${message.loadMs ?? 0}ms.`
      )
      return
    }
    if (message.type === 'model-ready') {
      console.info(
        `[omniparser] ${message.model ?? 'icon detector'} ready on ${message.device ?? 'unknown device'} ` +
        `in ${message.loadMs ?? 0}ms.`
      )
      return
    }
    if (message.type === 'fatal') {
      this.stopProcess(new Error(message.message || 'OmniParser failed to load.'))
      return
    }
    if (!message.requestId) return
    const request = this.pending.get(message.requestId)
    if (!request) return
    if (message.type === 'progress') {
      if (!Array.isArray(message.detections)) return
      if (message.stage === 'faces') {
        console.info(
          `[yunet] detected ${message.detections.filter(({ kind }) => kind === 'face').length} ` +
          `faces on the frozen screen in ${message.inferenceMs ?? 0}ms.`
        )
      }
      request.onProgress?.({
        features: mapDetectorPayload({ detections: message.detections, inferenceMs: message.inferenceMs }),
        stage: message.stage === 'faces' ? 'faces' : message.stage === 'full' ? 'full-frame' : 'tiles',
        inferenceMs: message.inferenceMs
      })
      return
    }
    clearTimeout(request.timeout)
    this.pending.delete(message.requestId)
    if (message.type === 'error') {
      request.reject(new Error(message.message || 'OmniParser detection failed.'))
      return
    }
    if (message.type !== 'result' || !Array.isArray(message.detections)) {
      request.reject(new Error('OmniParser returned an invalid result.'))
      return
    }
    const payload: DetectorPayload = {
      detections: message.detections,
      inferenceMs: message.inferenceMs,
      diagnostics: message.diagnostics
    }
    console.info(
      `[omniparser] detected ${payload.diagnostics?.faceDetections ?? 0} faces and ` +
      `${payload.detections.length - (payload.diagnostics?.faceDetections ?? 0)} controls in ${payload.inferenceMs ?? 0}ms ` +
      `(${payload.diagnostics?.faceInferenceMs ?? 0}ms faces, ` +
      `${payload.diagnostics?.fullDetections ?? 0} full-frame controls, ` +
      `${payload.diagnostics?.tileDetections ?? 0} native-tile candidates across ` +
      `${payload.diagnostics?.tileCount ?? 0} tiles).`
    )
    request.resolve(payload)
  }

  private reportSidecarStderr(chunk: string): void {
    const message = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
    if (message) console.warn(`[omniparser] ${message.slice(-2_000)}`)
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

  private throwIfCancelled(analysisId: string): void {
    if (!this.cancelled.delete(analysisId)) return
    throw new Error('OmniParser detection was stopped.')
  }
}

export function mapDetectorPayload(payload: DetectorPayload): CaptureFeature[] {
  const indexes = { control: 0, face: 0 }
  return payload.detections
    .slice(0, MAX_DETECTIONS)
    .flatMap<CaptureFeature>((detection) => {
      if (
        !Array.isArray(detection.bounds) ||
        detection.bounds.length !== 4 ||
        detection.bounds.some((value) => typeof value !== 'number' || !Number.isFinite(value))
      ) return []
      const [rawX, rawY, rawWidth, rawHeight] = detection.bounds
      const x = roundCoordinate(clamp(rawX))
      const y = roundCoordinate(clamp(rawY))
      const width = roundCoordinate(Math.min(1 - x, Math.max(0, rawWidth)))
      const height = roundCoordinate(Math.min(1 - y, Math.max(0, rawHeight)))
      if (width <= 0 || height <= 0) return []
      const confidence = typeof detection.confidence === 'number'
        ? clamp(detection.confidence)
        : 0
      const detectionKind = detection.kind === 'face' ? 'face' : 'control'
      const index = ++indexes[detectionKind]
      if (detectionKind === 'face') {
        return [{
          id: `yunet-face-${Math.round(x * 100_000)}-${Math.round(y * 100_000)}-${index}`,
          kind: 'face' as const,
          label: `Face ${index}`,
          bounds: { x, y, width, height },
          source: 'visual' as const,
          detector: 'yunet' as const,
          role: 'face',
          description: 'Human face detected on the frozen screen',
          enabled: true,
          visibility: confidence,
          visibilityVerified: true
        }]
      }
      return [{
        id: `omniparser-${Math.round(x * 100_000)}-${Math.round(y * 100_000)}-${index}`,
        kind: 'control' as const,
        label: 'Unlabelled button',
        bounds: { x, y, width, height },
        source: 'visual' as const,
        detector: 'omniparser' as const,
        role: 'button',
        description: 'Visible interactive control detected from the frozen screen',
        enabled: true,
        visibility: confidence
      }]
    })
}

export function mergeScreenshotElementFeatures(...groups: CaptureFeature[][]): CaptureFeature[] {
  const output: CaptureFeature[] = []
  const features = groups
    .flat()
    .sort((left, right) =>
      screenshotDetectorPriority(right) - screenshotDetectorPriority(left) ||
      (right.visibility ?? 0) - (left.visibility ?? 0) ||
      boundsArea(right) - boundsArea(left)
    )
  for (const feature of features) {
    const duplicateIndex = output.findIndex((candidate) => {
      if ((feature.kind === 'face') !== (candidate.kind === 'face')) return false
      const intersection = intersectionArea(feature, candidate)
      const featureArea = boundsArea(feature)
      const candidateArea = boundsArea(candidate)
      const union = featureArea + candidateArea - intersection
      const iou = union > 0 ? intersection / union : 0
      const containment = Math.min(featureArea, candidateArea) > 0
        ? intersection / Math.min(featureArea, candidateArea)
        : 0
      return iou >= 0.5 || containment >= 0.88
    })
    if (duplicateIndex < 0) {
      output.push(feature)
      continue
    }
    const current = output[duplicateIndex]!
    const preferred = preferScreenshotFeature(current, feature)
    const other = preferred === current ? feature : current
    output[duplicateIndex] = {
      ...preferred,
      ...(
        isGenericLabel(preferred.label) && !isGenericLabel(other.label)
          ? { label: other.label }
          : {}
      )
    }
  }
  return output
}

function preferScreenshotFeature(left: CaptureFeature, right: CaptureFeature): CaptureFeature {
  if (left.detector !== right.detector) {
    return screenshotDetectorPriority(left) >= screenshotDetectorPriority(right) ? left : right
  }
  const confidenceDifference = (left.visibility ?? 0) - (right.visibility ?? 0)
  if (Math.abs(confidenceDifference) > 0.08) return confidenceDifference > 0 ? left : right
  return boundsArea(left) >= boundsArea(right) ? left : right
}

function screenshotDetectorPriority(feature: CaptureFeature): number {
  return feature.detector === 'yunet' ? 3 : feature.detector === 'omniparser' ? 2 : 1
}

function isGenericLabel(value: string): boolean {
  return /^(?:unl(?:abelled|abeled) (?:button|control)|button|control|interface element)$/i.test(value.trim())
}

function intersectionArea(left: CaptureFeature, right: CaptureFeature): number {
  const width = Math.max(
    0,
    Math.min(left.bounds.x + left.bounds.width, right.bounds.x + right.bounds.width) -
      Math.max(left.bounds.x, right.bounds.x)
  )
  const height = Math.max(
    0,
    Math.min(left.bounds.y + left.bounds.height, right.bounds.y + right.bounds.height) -
      Math.max(left.bounds.y, right.bounds.y)
  )
  return width * height
}

function boundsArea(feature: CaptureFeature): number {
  return Math.max(0, feature.bounds.width) * Math.max(0, feature.bounds.height)
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function roundCoordinate(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000
}
