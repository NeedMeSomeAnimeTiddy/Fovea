import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { release } from 'node:os'
import { promisify } from 'node:util'
import {
  BrowserWindow,
  desktopCapturer,
  nativeImage,
  screen,
  type DesktopCapturerSource,
  type Display,
  type DisplayMediaRequestHandlerHandlerRequest,
  type NativeImage,
  type Session,
  type Streams
} from 'electron'
import type { CaptureContext, CaptureFreezeReason, CaptureVideoFrameMetadata, FrozenCaptureContext } from '@shared/contracts/ipc'
import type { CaptureAnalysis, CaptureFeature, CaptureMode, ImageEditOperation, OcrEntity, OcrRegion, OcrResult } from '@shared/types/app'
import type { Rectangle } from '@shared/types/geometry'
import { clampCropRectangle, logicalToPhysical } from './geometry'
import type { ImageEditorService } from './image-editor-service'
import { buildCaptureAnalysis, buildCaptureAnalysisStage, detectVisualControlFeatures, validateCaptureAnalysis } from './screen-feature-analysis'
import { mergeScreenshotElementFeatures, type ScreenshotElementDetector } from './screenshot-element-detector-service'
import { mapUiAutomationFeatures, type UiAutomationSnapshotService } from './windows-ui-automation-service'
import type { OcrService } from '../ocr/ocr-service'
import { loadRenderer, secureWindow } from '../windows/window-factory'
import { WINDOW_BACKGROUND_COLOR } from '../windows/window-appearance'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'

const execFileAsync = promisify(execFile)
const CAPTURE_STARTUP_TIMEOUT_MS = 20_000
const CAPTURE_FRAME_READY_TIMEOUT_MS = 5_000
const WINDOWS_CAPTURE_EXCLUSION_BUILD = 19_041
const LIVE_WINDOW_PRESENTATION_DELAY_MS = 180
const CAPTURE_OVERLAY_PARTITION = 'fovea-capture'
const VIDEO_STREAM_GRANT_TIMEOUT_MS = 3_000
const VIDEO_FRAME_DELIVERY_TIMEOUT_MS = 5_000
const MAX_VIDEO_FRAME_BYTES = 64 * 1024 * 1024

type CaptureSurface = CaptureContext['surface']

interface PendingDisplay {
  display: Display
  frameAcknowledged: boolean
  frameReady: Promise<void>
  image: NativeImage | null
  imageBounds: Rectangle | null
  imageDataUrl: string | null
  viewport: Rectangle | null
  window: BrowserWindow
  ready: Promise<void>
  resolveFrameReady(): void
  resolveReady(): void
  readinessError: Error | null
  semanticStarted: boolean
  streamImage: NativeImage | null
  streamImageBounds: Rectangle | null
  surface: CaptureSurface
  uiFeatures: CaptureFeature[]
  uiFeaturesReady: Promise<void>
  videoFrameExpiresAt: number
  videoGrantEpoch: number
  videoGrantExpiresAt: number
}
interface PrewarmedOverlay {
  displayKey: string
  surface: CaptureSurface
  window: BrowserWindow
  rendererReady: Promise<void>
  activation: ReturnType<typeof createDeferred>
  claimed: boolean
}
interface CaptureDescriptor { mode: CaptureMode; displayId?: number; rectangle?: Rectangle; sourceId?: string }
interface PendingCapture { candidates: Map<number, PendingDisplay>; topology: string; destination?: CaptureDestination }
export interface CaptureRuntime {
  liveSelection: boolean
  presentationDelayMs?: number
}

export interface CompletedCapture { imagePath: string; selectedBounds: Rectangle; display: Display; edited?: boolean; preferWebSearch?: boolean; extractText?: boolean; ocrLanguageCode?: string; initialQuestion?: string }
export interface CaptureDestination {
  onCompleted(capture: CompletedCapture): Promise<void>
  onCancelled?(): void
}

export class CaptureService {
  private pending: PendingCapture | null = null
  private lastDescriptor: CaptureDescriptor | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private rejectStartup: ((error: Error) => void) | null = null
  private readonly analysisIds = new Map<number, string>()
  private readonly prewarmedOverlays = new Map<number, PrewarmedOverlay>()
  private displayMediaSession: Session | null = null
  private liveSelectionUnavailable = false
  private disposed = false

  constructor(
    private readonly screenshots: TempScreenshotStore,
    private readonly onCompleted: (capture: CompletedCapture) => Promise<void>,
    private readonly onError: (message: string) => void,
    private readonly imageEditor?: Pick<ImageEditorService, 'createDerivative'>,
    private readonly ocr?: Pick<OcrService, 'recognise' | 'cancel'>,
    private readonly uiAutomation?: UiAutomationSnapshotService,
    private readonly screenshotDetector?: ScreenshotElementDetector,
    private readonly runtime: CaptureRuntime = { liveSelection: false }
  ) {
    screen.on('display-added', this.cancelForTopologyChange)
    screen.on('display-removed', this.cancelForTopologyChange)
    screen.on('display-metrics-changed', this.cancelForTopologyChange)
  }

  async begin(mode: CaptureMode = 'region', destination?: CaptureDestination): Promise<void> {
    if (this.pending) {
      if (destination) throw new Error('Another screen capture is already in progress.')
      return
    }
    try {
      if (mode === 'repeat-last') {
        if (!this.lastDescriptor) throw new Error('There is no previous capture to repeat.')
        return this.dispatchDescriptor(this.lastDescriptor, destination)
      }
      if (mode === 'display') return this.captureDisplay(undefined, destination)
      if (mode === 'window') return this.captureFocusedWindow(undefined, destination)
      return this.beginRegion(undefined, destination)
    } catch (error) {
      if (mode === 'display' || mode === 'window') destination?.onCancelled?.()
      throw error
    }
  }

  async getContext(senderWebContentsId?: number): Promise<CaptureContext> {
    const candidate = await this.findCandidateAfterActivation(senderWebContentsId)
    await candidate.ready
    if (candidate.readinessError) throw candidate.readinessError
    return this.captureContext(candidate)
  }

  readyToShow(senderWebContentsId: number): void {
    const candidate = this.findCandidate(senderWebContentsId)
    if (!candidate.viewport) throw new Error('The capture surface is unavailable.')
    if (candidate.surface === 'frozen' && (!candidate.image || !candidate.imageDataUrl)) throw new Error('The frozen display image is unavailable.')
    if (candidate.frameAcknowledged) return
    if (candidate.window.isDestroyed()) throw new Error('The screen selection overlay is unavailable.')
    candidate.frameAcknowledged = true
    candidate.resolveFrameReady()
  }

  armVideoFrame(senderWebContentsId: number): void {
    const candidate = this.findCandidate(senderWebContentsId)
    if (candidate.surface !== 'live' || !candidate.viewport || candidate.window.isDestroyed()) {
      throw new Error('A live capture surface is not available.')
    }
    candidate.streamImage = null
    candidate.streamImageBounds = null
    candidate.videoFrameExpiresAt = 0
    candidate.videoGrantEpoch += 1
    candidate.videoGrantExpiresAt = Date.now() + VIDEO_STREAM_GRANT_TIMEOUT_MS
  }

  provideVideoFrame(senderWebContentsId: number, png: Uint8Array, metadata: CaptureVideoFrameMetadata): boolean {
    const candidate = this.findCandidate(senderWebContentsId)
    if (candidate.surface !== 'live' || candidate.videoFrameExpiresAt < Date.now()) return false
    candidate.videoFrameExpiresAt = 0
    if (!candidate.viewport) throw new Error('The live capture surface is not ready.')
    if (
      metadata.viewport.width !== candidate.viewport.width ||
      metadata.viewport.height !== candidate.viewport.height
    ) throw new Error('The live video frame viewport did not match this display.')
    let imageBounds: Rectangle | null = null
    if (metadata.rectangle) {
      imageBounds = boundRectangle(metadata.rectangle, candidate.viewport.width, candidate.viewport.height)
      if (!sameRectangle(imageBounds, metadata.rectangle) || imageBounds.width < 1 || imageBounds.height < 1) {
        throw new Error('The live video frame selection was invalid.')
      }
    }
    const buffer = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
    const dimensions = pngDimensions(buffer)
    if (!dimensions || buffer.byteLength > MAX_VIDEO_FRAME_BYTES) throw new Error('The live video frame was invalid.')
    if (!isPlausibleVideoFrame(dimensions, candidate, imageBounds)) throw new Error('The live video frame did not match this display.')
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) throw new Error('The live video frame was empty.')
    const decoded = image.getSize()
    if (decoded.width !== dimensions.width || decoded.height !== dimensions.height) {
      throw new Error('The live video frame dimensions were inconsistent.')
    }
    candidate.streamImage = image
    candidate.streamImageBounds = imageBounds
    return true
  }

  cancelVideoFrame(senderWebContentsId: number): void {
    const candidate = this.pending?.candidates.get(senderWebContentsId)
    if (!candidate) return
    candidate.videoFrameExpiresAt = 0
    candidate.videoGrantEpoch += 1
    candidate.videoGrantExpiresAt = 0
  }

  async freeze(senderWebContentsId: number, reason: CaptureFreezeReason): Promise<FrozenCaptureContext> {
    const candidate = this.findCandidate(senderWebContentsId)
    await candidate.ready
    if (candidate.readinessError) throw candidate.readinessError
    try {
      if (candidate.surface === 'live') await this.captureLiveFrame(candidate, true)
      this.retainOnlyCandidate(candidate)
      if (reason === 'analyze') this.startSemanticSnapshot(candidate)
      const context = this.captureContext(candidate)
      if (context.surface !== 'frozen') throw new Error('The screen could not be held for this action.')
      return context
    } catch (error) {
      if (!this.shouldUseFrozenFallback(error)) throw error
      await this.activateFrozenFallback(error)
      throw new Error('Live selection was unavailable, so Fovea switched to compatibility capture. Select the area again.')
    }
  }

  async analyze(senderWebContentsId?: number, onProgress?: (analysis: CaptureAnalysis) => void): Promise<CaptureAnalysis> {
    const analysisStartedAt = Date.now()
    const candidate = this.findCandidate(senderWebContentsId)
    await candidate.ready
    if (candidate.readinessError) throw candidate.readinessError
    if (candidate.surface !== 'frozen') throw new Error('Hold the current screen before starting Analyze.')
    if (!candidate.image || !candidate.viewport) throw new Error('The frozen display image is unavailable.')
    let uiFeatures = candidate.uiFeatures
    const ownerId = senderWebContentsId ?? candidate.window.webContents.id
    const pending = this.pending
    const analysisId = `capture-analysis-${randomUUID()}`
    const png = candidate.image.toPNG()
    let screenshotAnchored = Boolean(this.screenshotDetector)
    onProgress?.(await validateCaptureAnalysis(
      png,
      buildCaptureAnalysisStage({ lines: [], uiFeatures, screenshotAnchored }, 'semantic')
    ))
    const imagePath = await this.screenshots.save(png)
    this.analysisIds.set(ownerId, analysisId)
    try {
      let regions: OcrRegion[] = []
      let words: OcrRegion[] = []
      let entities: OcrEntity[] = []
      let visualFeatures: CaptureFeature[] = []
      let partialOcrResult: OcrResult | null = null
      let progressTail = Promise.resolve()
      const queueProgress = (progress: CaptureAnalysis): void => {
        if (!onProgress) return
        progressTail = progressTail.then(async () => {
          if (this.analysisIds.get(ownerId) !== analysisId || this.pending !== pending) return
          onProgress(await validateCaptureAnalysis(png, progress))
        })
      }
      const uiFeaturesReady = candidate.uiFeaturesReady.then(() => {
        uiFeatures = candidate.uiFeatures
        const availablePartial = partialOcrResult as OcrResult | null
        queueProgress(availablePartial
          ? buildCaptureAnalysisStage({
              lines: availablePartial.regions,
              words: availablePartial.words ?? [],
              entities: availablePartial.entities ?? [],
              uiFeatures,
              visualFeatures,
              screenshotAnchored
            }, 'text')
          : buildCaptureAnalysisStage({
              lines: [],
              uiFeatures,
              visualFeatures,
              screenshotAnchored
            }, 'semantic'))
        return uiFeatures
      })
      let heuristicFeatures: CaptureFeature[] = []
      const heuristicFeaturesReady = uiFeaturesReady
        .then((features) => detectVisualControlFeatures(png, { lines: [], uiFeatures: features }))
        .then((features) => {
          heuristicFeatures = features
          return features
        })
      const visualFeaturesReady = this.screenshotDetector
        ? this.screenshotDetector.detect(
            analysisId,
            png,
            candidate.image.getSize(),
            (progress) => {
              visualFeatures = mergeScreenshotElementFeatures(progress.features, heuristicFeatures)
              const availablePartial = partialOcrResult as OcrResult | null
              queueProgress(availablePartial
                ? buildCaptureAnalysisStage({
                    lines: availablePartial.regions,
                    words: availablePartial.words ?? [],
                    entities: availablePartial.entities ?? [],
                    uiFeatures,
                    visualFeatures,
                    screenshotAnchored
                  }, 'text')
                : buildCaptureAnalysisStage({
                    lines: [],
                    uiFeatures,
                    visualFeatures,
                    screenshotAnchored
                  }, 'semantic'))
            },
            { sourcePath: imagePath }
          ).then(async (features) =>
            mergeScreenshotElementFeatures(features, await heuristicFeaturesReady)
          ).catch(async (error) => {
            screenshotAnchored = false
            console.warn(
              `[capture] OmniParser unavailable during Analyze: ` +
              `${error instanceof Error ? error.message : String(error)}`
            )
            return heuristicFeaturesReady
          })
        : heuristicFeaturesReady
      const ocrReady = (async (): Promise<void> => {
        if (this.ocr) {
          try {
            const result = await this.ocr.recognise(
              analysisId,
              png,
              candidate.image!.getSize(),
              (progress) => {
                if (!progress.result) return
                partialOcrResult = structuredClone(progress.result)
                queueProgress(buildCaptureAnalysisStage({
                  lines: partialOcrResult.regions,
                  words: partialOcrResult.words ?? [],
                  entities: partialOcrResult.entities ?? [],
                  uiFeatures,
                  visualFeatures,
                  screenshotAnchored
                }, 'text'))
              },
              {
                sourcePath: imagePath,
                preserveGeometry: true,
                refinementRegions: uiFeatures.map(({ bounds }) => bounds)
              }
            )
            regions = result.regions
            words = result.words ?? []
            entities = result.entities ?? []
            console.info(
              `[capture] OCR selected ${result.engine ?? 'unknown'} with ${regions.length} lines, ` +
              `${words.length} words, ${result.text.length} characters, and ${result.confidence}% confidence.`
            )
          } catch (error) {
            console.warn(`[capture] OCR unavailable during Analyze: ${error instanceof Error ? error.message : String(error)}`)
            // Keep Analyze available with no targets when local text recognition is unavailable.
          }
        }
      })()
      visualFeatures = await visualFeaturesReady
      if (visualFeatures.length) {
        const availablePartial = partialOcrResult as OcrResult | null
        queueProgress(availablePartial
          ? buildCaptureAnalysisStage({
              lines: availablePartial.regions,
              words: availablePartial.words ?? [],
              entities: availablePartial.entities ?? [],
              uiFeatures,
              visualFeatures,
              screenshotAnchored
            }, 'text')
          : buildCaptureAnalysisStage({ lines: [], uiFeatures, visualFeatures, screenshotAnchored }, 'semantic'))
      }
      await ocrReady
      await progressTail
      onProgress?.(await validateCaptureAnalysis(
        png,
        buildCaptureAnalysisStage({
          lines: regions,
          words,
          entities,
          uiFeatures,
          visualFeatures,
          screenshotAnchored
        }, 'text')
      ))
      const analysis = await buildCaptureAnalysis(png, {
        lines: regions,
        words,
        entities,
        uiFeatures,
        visualFeatures,
        screenshotAnchored
      })
      if (this.pending !== pending || !pending?.candidates.has(ownerId)) throw new Error('Screen analysis was cancelled.')
      console.info(`[capture] Analyze completed in ${Date.now() - analysisStartedAt}ms with ${analysis.features.length} features.`)
      return analysis
    } finally {
      if (this.analysisIds.get(ownerId) === analysisId) this.analysisIds.delete(ownerId)
      await this.screenshots.delete(imagePath)
    }
  }

  async cancelAnalysis(senderWebContentsId?: number): Promise<void> {
    if (!senderWebContentsId) return
    const analysisId = this.analysisIds.get(senderWebContentsId)
    if (!analysisId) return
    this.analysisIds.delete(senderWebContentsId)
    await Promise.allSettled([
      this.ocr?.cancel?.(analysisId),
      this.screenshotDetector?.cancel?.(analysisId)
    ])
  }

  async select(rectangle: Rectangle, senderWebContentsId?: number, operations: ImageEditOperation[] = [], preferWebSearch = false, extractText = false, ocrLanguageCode?: string, initialQuestion?: string): Promise<void> {
    const candidate = this.findCandidate(senderWebContentsId)
    if (!candidate.viewport) throw new Error('The capture surface is not ready.')
    const bounded = boundRectangle(rectangle, candidate.viewport.width, candidate.viewport.height)
    if (bounded.width < 24 || bounded.height < 24) throw new Error('Select an area at least 24 × 24 pixels.')
    if (candidate.surface === 'live') {
      try {
        await this.captureLiveFrame(candidate, false, bounded)
      } catch (error) {
        if (!this.shouldUseFrozenFallback(error)) throw error
        await this.activateFrozenFallback(error)
        return
      }
    }
    const allowedOperations = this.pending?.destination ? [] : operations
    this.lastDescriptor = { mode: 'region', displayId: candidate.display.id, rectangle: bounded }
    await this.complete(candidate, bounded, allowedOperations, preferWebSearch, extractText, ocrLanguageCode, initialQuestion)
  }

  cancel(): void {
    this.clearPending(true)
  }

  prewarm(): void {
    if (this.disposed || this.pending) return
    const displays = screen.getAllDisplays()
    const requestedSurface = this.captureSurface()
    try {
      this.prewarmSurface(displays, requestedSurface)
    } catch (error) {
      if (requestedSurface !== 'live') throw error
      this.liveSelectionUnavailable = true
      this.releaseAllPrewarmedOverlays()
      console.warn(`[capture] Live overlay prewarm unavailable; using frozen capture: ${error instanceof Error ? error.message : String(error)}`)
      this.prewarmSurface(displays, 'frozen')
    }
  }

  private prewarmSurface(displays: Display[], surface: CaptureSurface): void {
    for (const display of displays) {
      const current = this.prewarmedOverlays.get(display.id)
      if (current && current.displayKey === displayKey(display) && current.surface === surface && !current.window.isDestroyed()) continue
      if (current) this.releasePrewarmedOverlay(display.id, current)
      const window = this.createOverlay(display, surface)
      const entry: PrewarmedOverlay = {
        displayKey: displayKey(display),
        surface,
        window,
        rendererReady: Promise.resolve(),
        activation: createDeferred(),
        claimed: false
      }
      this.prewarmedOverlays.set(display.id, entry)
      const rendererReady = loadRenderer(window, 'overlay')
      entry.rendererReady = (surface === 'live'
        ? this.prepareLiveOverlay(window, rendererReady)
        : rendererReady
      ).catch((error) => {
        if (this.prewarmedOverlays.get(display.id) === entry) {
          this.prewarmedOverlays.delete(display.id)
          entry.activation.resolve()
        }
        if (!window.isDestroyed()) window.close()
        throw error
      })
      void entry.rendererReady.catch(() => undefined)
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
    this.releaseAllPrewarmedOverlays()
    this.displayMediaSession?.setDisplayMediaRequestHandler(null)
    this.displayMediaSession = null
    void this.screenshotDetector?.dispose?.().catch((error) => {
      console.warn(`[capture] Screenshot detector shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    screen.off('display-added', this.cancelForTopologyChange)
    screen.off('display-removed', this.cancelForTopologyChange)
    screen.off('display-metrics-changed', this.cancelForTopologyChange)
  }

  private async beginRegion(descriptor?: CaptureDescriptor, destination?: CaptureDestination): Promise<void> {
    if (this.captureSurface() === 'frozen') return this.beginFrozenRegion(descriptor, destination)
    try {
      return await this.beginLiveRegion(descriptor, destination)
    } catch (error) {
      if (!this.shouldUseFrozenFallback(error)) {
        if (this.pending) this.clearPending(false)
        throw error
      }
      this.liveSelectionUnavailable = true
      console.warn(`[capture] Live selection unavailable; using frozen compatibility mode: ${error instanceof Error ? error.message : String(error)}`)
      if (this.pending) this.clearPending(false)
      return this.beginFrozenRegion(descriptor, destination)
    }
  }

  private async beginLiveRegion(descriptor?: CaptureDescriptor, destination?: CaptureDestination): Promise<void> {
    const startupStartedAt = Date.now()
    const displays = screen.getAllDisplays()
    const topology = captureTopology(displays)
    const candidates = new Map<number, PendingDisplay>()
    const rendererReadiness: Promise<void>[] = []
    this.pending = { candidates, topology, destination }
    for (const display of displays) {
      if (descriptor?.displayId && descriptor.displayId !== display.id) continue
      const prewarmed = this.claimPrewarmedOverlay(display, 'live')
      const overlay = prewarmed?.window ?? this.createOverlay(display, 'live')
      rendererReadiness.push(prewarmed?.rendererReady ?? this.prepareLiveOverlay(overlay, loadRenderer(overlay, 'overlay')))
      const contextReady = createDeferred()
      const frameReady = createDeferred()
      candidates.set(overlay.webContents.id, {
        display,
        frameAcknowledged: false,
        frameReady: frameReady.promise,
        image: null,
        imageBounds: null,
        imageDataUrl: null,
        viewport: null,
        window: overlay,
        ready: contextReady.promise,
        resolveFrameReady: frameReady.resolve,
        resolveReady: contextReady.resolve,
        readinessError: null,
        semanticStarted: false,
        streamImage: null,
        streamImageBounds: null,
        surface: 'live',
        uiFeatures: [],
        uiFeaturesReady: Promise.resolve(),
        videoFrameExpiresAt: 0,
        videoGrantEpoch: 0,
        videoGrantExpiresAt: 0
      })
      if (prewarmed) {
        prewarmed.activation.resolve()
        if (this.prewarmedOverlays.get(display.id) === prewarmed) this.prewarmedOverlays.delete(display.id)
      }
    }
    if (!candidates.size) throw new Error('Windows did not provide any displays for live capture.')
    await this.awaitCaptureStartup((async () => {
      await Promise.all(rendererReadiness)
      if (this.pending?.candidates !== candidates) throw new Error('Screen capture was cancelled.')
      if (topology !== this.currentTopology()) throw new Error('Display configuration changed; capture was cancelled.')
      for (const candidate of candidates.values()) {
        if (!candidate.window.isContentProtected()) throw new Error('Windows did not enable capture exclusion for the live overlay.')
        candidate.viewport = this.alignOverlayToDisplay(candidate)
        candidate.resolveReady()
      }
      await withTimeout(
        Promise.all([...candidates.values()].map(({ frameReady }) => frameReady)),
        CAPTURE_FRAME_READY_TIMEOUT_MS,
        'The live capture controls did not finish rendering in time. Please try again.'
      )
    })())
    if (this.pending?.candidates !== candidates) throw new Error('Screen capture was cancelled.')
    if (topology !== this.currentTopology()) throw new Error('Display configuration changed; capture was cancelled.')
    if ([...candidates.values()].some(({ window }) => window.isDestroyed())) throw new Error('A screen selection overlay became unavailable.')
    for (const candidate of candidates.values()) candidate.window.setIgnoreMouseEvents(false)
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const focused = [...candidates.values()].find(({ display }) => display.id === cursorDisplay.id) ?? [...candidates.values()][0]
    if (focused && !focused.window.isDestroyed()) focused.window.focus()
    console.info(`[capture] Live selection controls displayed in ${Date.now() - startupStartedAt}ms.`)
    if (descriptor?.rectangle) await this.select(descriptor.rectangle, [...candidates.keys()][0])
  }

  private async beginFrozenRegion(descriptor?: CaptureDescriptor, destination?: CaptureDestination): Promise<void> {
    const startupStartedAt = Date.now()
    const displays = screen.getAllDisplays()
    const semanticStartedAt = Date.now()
    const semanticSnapshot = this.uiAutomation
      ? this.uiAutomation.snapshot([], false, true).catch(() => [])
      : Promise.resolve([])
    const topology = captureTopology(displays)
    const maxWidth = Math.max(...displays.map((display) => Math.round(display.bounds.width * display.scaleFactor)))
    const maxHeight = Math.max(...displays.map((display) => Math.round(display.bounds.height * display.scaleFactor)))
    const candidates = new Map<number, PendingDisplay>()
    const rendererReadiness: Promise<void>[] = []
    const claimedPrewarmed: Array<[number, PrewarmedOverlay]> = []
    for (const display of displays) {
      if (descriptor?.displayId && descriptor.displayId !== display.id) continue
      const prewarmed = this.claimPrewarmedOverlay(display, 'frozen')
      const overlay = prewarmed?.window ?? this.createOverlay(display, 'frozen')
      rendererReadiness.push(prewarmed?.rendererReady ?? loadRenderer(overlay, 'overlay'))
      if (prewarmed) claimedPrewarmed.push([display.id, prewarmed])
      const contextReady = createDeferred()
      const frameReady = createDeferred()
      candidates.set(overlay.webContents.id, {
        display,
        frameAcknowledged: false,
        frameReady: frameReady.promise,
        image: null,
        imageBounds: null,
        imageDataUrl: null,
        viewport: null,
        window: overlay,
        ready: contextReady.promise,
        resolveFrameReady: frameReady.resolve,
        resolveReady: contextReady.resolve,
        readinessError: null,
        semanticStarted: true,
        streamImage: null,
        streamImageBounds: null,
        surface: 'frozen',
        uiFeatures: [],
        uiFeaturesReady: Promise.resolve(),
        videoFrameExpiresAt: 0,
        videoGrantEpoch: 0,
        videoGrantExpiresAt: 0
      })
    }
    if (!candidates.size) throw new Error('Windows did not provide any screen images to capture.')
    this.pending = { candidates, topology, destination }
    for (const [displayId, prewarmed] of claimedPrewarmed) {
      prewarmed.activation.resolve()
      if (this.prewarmedOverlays.get(displayId) === prewarmed) this.prewarmedOverlays.delete(displayId)
    }
    try {
      const preparationStartedAt = Date.now()
      const rendererLoads = Promise.all(rendererReadiness).then((value) => {
        console.info(`[capture] Overlay renderer prepared in ${Date.now() - preparationStartedAt}ms.`)
        return value
      })
      const screenImages = desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: maxWidth, height: maxHeight },
        fetchWindowIcons: false
      }).then((value) => {
        console.info(`[capture] Screen bitmap acquired in ${Date.now() - preparationStartedAt}ms.`)
        return value
      })
      let semanticReady: Promise<void> = Promise.resolve()
      await this.awaitCaptureStartup((async () => {
        const [sources] = await Promise.all([
          screenImages,
          rendererLoads
        ] as const)
        if (this.pending?.candidates !== candidates) throw new Error('Screen capture was cancelled.')
        if (topology !== this.currentTopology()) throw new Error('Display configuration changed; capture was cancelled.')
        const imagePreparationStartedAt = Date.now()
        const displaySources = new Map<number, DesktopCapturerSource>()
        for (const candidate of candidates.values()) {
          const source = sources.find((entry) => entry.display_id === String(candidate.display.id))
          if (!source || source.thumbnail.isEmpty()) {
            const error = new Error('Windows did not provide a usable image for every requested display.')
            for (const pendingCandidate of candidates.values()) pendingCandidate.readinessError = error
            throw error
          }
          displaySources.set(candidate.display.id, source)
        }
        for (const candidate of candidates.values()) {
          const source = displaySources.get(candidate.display.id)!
          candidate.image = source.thumbnail
          candidate.imageDataUrl = pngDataUrl(source.thumbnail)
          candidate.viewport = this.alignOverlayToDisplay(candidate)
        }
        console.info(`[capture] Frozen bitmap encoded in ${Date.now() - imagePreparationStartedAt}ms.`)
        if (!candidates.size) throw new Error('Windows did not provide any screen images to capture.')
        semanticReady = semanticSnapshot.then((uiElements) => {
          if (this.pending?.candidates !== candidates) return
          for (const candidate of candidates.values()) {
            candidate.uiFeatures = mapUiAutomationFeatures(
              uiElements,
              candidate.display.bounds,
              (bounds) => typeof screen.screenToDipRect === 'function' ? screen.screenToDipRect(null, bounds) : bounds
            )
          }
          console.info(
            `[capture] Semantic scan completed in ${Date.now() - semanticStartedAt}ms ` +
            `with ${uiElements.length} visible controls.`
          )
        })
        for (const candidate of candidates.values()) {
          candidate.uiFeaturesReady = semanticReady
          candidate.resolveReady()
        }
        await withTimeout(
          Promise.all([...candidates.values()].map(({ frameReady }) => frameReady)),
          CAPTURE_FRAME_READY_TIMEOUT_MS,
          'The frozen screen did not finish rendering in time. Please try again.'
        )
      })())
      if (this.pending?.candidates !== candidates) throw new Error('Screen capture was cancelled.')
      if (topology !== this.currentTopology()) throw new Error('Display configuration changed; capture was cancelled.')
      if ([...candidates.values()].some(({ window }) => window.isDestroyed())) throw new Error('A screen selection overlay became unavailable.')
      for (const candidate of candidates.values()) candidate.window.showInactive()
      console.info(`[capture] Frozen frame prepared and displayed in ${Date.now() - startupStartedAt}ms.`)
      void semanticReady.finally(() => {
        if (this.pending?.candidates !== candidates) return
        for (const candidate of candidates.values()) {
          if (!candidate.window.isDestroyed()) candidate.window.focus()
        }
      })
      // Loading a large detector must never delay the frozen bitmap. Start it
      // only after the overlay is visible, then keep it resident for Analyze.
      void this.screenshotDetector?.prepare?.().catch((error) => {
        console.warn(
          `[capture] Screenshot detector prewarm failed: ` +
          `${error instanceof Error ? error.message : String(error)}`
        )
      })
      if (descriptor?.rectangle) await this.select(descriptor.rectangle, [...candidates.keys()][0])
    } catch (error) { this.cancel(); throw error }
  }

  private async captureDisplay(descriptor?: CaptureDescriptor, destination?: CaptureDestination): Promise<void> {
    const display = descriptor?.displayId ? screen.getAllDisplays().find((item) => item.id === descriptor.displayId) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    if (!display) throw new Error('The previous display is no longer connected.')
    const image = await this.captureScreenImage(display)
    const selectedBounds = { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height }
    this.lastDescriptor = { mode: 'display', displayId: display.id }
    await this.saveCompleted(display, image, selectedBounds, destination)
  }

  private async captureFocusedWindow(descriptor?: CaptureDescriptor, destination?: CaptureDestination): Promise<void> {
    const target = descriptor?.sourceId ? { sourceId: descriptor.sourceId, processId: 0 } : await getForegroundTarget()
    if (target.processId === process.pid) throw new Error('Fovea cannot capture one of its own windows.')
    const ownHandles = new Set(BrowserWindow.getAllWindows().map((window) => window.getNativeWindowHandle().toString('hex').replace(/^0+/, '').toLowerCase()))
    const targetHandle = target.sourceId.split(':')[1]?.replace(/^0+/, '').toLowerCase()
    if (!targetHandle || ownHandles.has(targetHandle)) throw new Error('Fovea cannot capture one of its own windows.')
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 3840, height: 2160 }, fetchWindowIcons: false })
    const source = sources.find((candidate) => sourceHandle(candidate) === targetHandle)
    if (!source || source.thumbnail.isEmpty() || isBlank(source.thumbnail)) throw new Error('The focused window is minimized, protected, empty, or unavailable.')
    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    const size = source.thumbnail.getSize()
    const selectedBounds = { x: 0, y: 0, width: size.width, height: size.height }
    this.lastDescriptor = { mode: 'window', sourceId: source.id }
    await this.saveCompleted(display, source.thumbnail, selectedBounds, destination)
  }

  private async dispatchDescriptor(descriptor: CaptureDescriptor, destination?: CaptureDestination): Promise<void> {
    if (descriptor.mode === 'region') return this.beginRegion(descriptor, destination)
    if (descriptor.mode === 'display') return this.captureDisplay(descriptor, destination)
    if (descriptor.mode === 'window') return this.captureFocusedWindow(descriptor, destination)
  }

  private createOverlay(display: Display, surface: CaptureSurface): BrowserWindow {
    const live = surface === 'live'
    const overlay = secureWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      useContentSize: true,
      frame: false,
      transparent: live,
      backgroundColor: live ? '#00000000' : WINDOW_BACKGROUND_COLOR,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: true,
      show: false,
      paintWhenInitiallyHidden: true,
      hasShadow: false,
      ...(live ? { webPreferences: { partition: CAPTURE_OVERLAY_PARTITION } } : {})
    })
    if (live) {
      try {
        this.installDisplayMediaHandler(overlay.webContents.session)
        overlay.setContentProtection(true)
        if (!overlay.isContentProtected()) throw new Error('Capture exclusion was not accepted by Windows.')
        overlay.setIgnoreMouseEvents(true)
      } catch (error) {
        if (!overlay.isDestroyed()) overlay.close()
        throw error
      }
    }
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    overlay.webContents.on('will-navigate', (event) => { event.preventDefault() })
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    overlay.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); this.cancel() } })
    overlay.webContents.once('render-process-gone', () => { this.cancel(); this.onError('The screen selection overlay stopped responding.') })
    return overlay
  }

  private async prepareLiveOverlay(overlay: BrowserWindow, rendererReady: Promise<void>): Promise<void> {
    await rendererReady
    if (overlay.isDestroyed()) throw new Error('The live capture overlay became unavailable during startup.')
    if (!overlay.isContentProtected()) throw new Error('Windows did not enable capture exclusion for the live overlay.')
    // Let Windows present the empty, transparent native window before a shortcut is pressed.
    // Activation then paints only Fovea's controls and cannot expose a window-opening transition.
    overlay.setIgnoreMouseEvents(true)
    if (overlay.isVisible()) return
    overlay.showInactive()
    const presentationDelay = this.runtime.presentationDelayMs ?? LIVE_WINDOW_PRESENTATION_DELAY_MS
    if (presentationDelay > 0) await delay(presentationDelay)
  }

  private installDisplayMediaHandler(captureSession: Session): void {
    if (this.displayMediaSession === captureSession) return
    this.displayMediaSession?.setDisplayMediaRequestHandler(null)
    this.displayMediaSession = captureSession
    captureSession.setDisplayMediaRequestHandler(this.handleDisplayMediaRequest)
  }

  private readonly handleDisplayMediaRequest = (
    request: DisplayMediaRequestHandlerHandlerRequest,
    callback: (streams: Streams) => void
  ): void => {
    let responded = false
    const respond = (streams: Streams): void => {
      if (responded) return
      responded = true
      callback(streams)
    }
    const activeCandidates = this.pending ? [...this.pending.candidates.values()] : []
    const candidate = request.frame
      ? activeCandidates.find(({ window }) => window.webContents.mainFrame === request.frame)
      : undefined
    const expectedOrigin = captureRendererSecurityOrigin()
    if (
      !candidate ||
      candidate.surface !== 'live' ||
      !request.videoRequested ||
      request.audioRequested ||
      !request.userGesture ||
      expectedOrigin === null ||
      request.securityOrigin !== expectedOrigin ||
      candidate.videoGrantExpiresAt < Date.now()
    ) {
      respond({})
      return
    }

    // Consume the renderer's grant before any asynchronous source enumeration.
    const grantEpoch = candidate.videoGrantEpoch
    const grantExpiresAt = candidate.videoGrantExpiresAt
    candidate.videoGrantExpiresAt = 0
    const pending = this.pending
    void desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    }).then((sources) => {
      if (
        this.pending !== pending ||
        !pending?.candidates.has(candidate.window.webContents.id) ||
        candidate.videoGrantEpoch !== grantEpoch ||
        grantExpiresAt < Date.now() ||
        candidate.window.isDestroyed()
      ) {
        respond({})
        return
      }
      const source = sources.find(({ display_id: displayId }) => displayId === String(candidate.display.id))
      if (!source) {
        respond({})
        return
      }
      candidate.videoFrameExpiresAt = Date.now() + VIDEO_FRAME_DELIVERY_TIMEOUT_MS
      respond({ video: { id: source.id, name: source.name } })
    }).catch((error) => {
      console.warn(`[capture] Live display stream could not start: ${error instanceof Error ? error.message : String(error)}`)
      respond({})
    })
  }

  private alignOverlayToDisplay(candidate: PendingDisplay): Rectangle {
    const requested = { ...candidate.display.bounds }
    candidate.window.setContentBounds(requested, false)
    const actual = candidate.window.getContentBounds()
    if (!sameRectangle(actual, requested)) {
      throw new Error(`Windows could not create a full-display capture surface (${actual.width} × ${actual.height} instead of ${requested.width} × ${requested.height}).`)
    }
    return { x: 0, y: 0, width: actual.width, height: actual.height }
  }

  private async captureScreenImage(display: Display): Promise<NativeImage> {
    const width = Math.max(1, Math.round(display.bounds.width * display.scaleFactor))
    const height = Math.max(1, Math.round(display.bounds.height * display.scaleFactor))
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false })
    const source = sources.find((entry) => entry.display_id === String(display.id))
    if (!source || source.thumbnail.isEmpty() || isBlank(source.thumbnail)) throw new Error('Windows did not provide a usable display image.')
    return source.thumbnail
  }

  private captureContext(candidate: PendingDisplay): CaptureContext {
    if (!candidate.viewport) throw new Error('The capture surface is unavailable.')
    const base = {
      width: candidate.viewport.width,
      height: candidate.viewport.height,
      minSelectionSize: 24,
      displayId: String(candidate.display.id),
      canEditBeforeSending: !this.pending?.destination
    }
    if (candidate.surface === 'live') return { ...base, surface: 'live', imageDataUrl: null }
    if (!candidate.image || !candidate.imageDataUrl) throw new Error('The frozen display image is unavailable.')
    return { ...base, surface: 'frozen', imageDataUrl: candidate.imageDataUrl }
  }

  private captureSurface(): CaptureSurface {
    return this.runtime.liveSelection && !this.liveSelectionUnavailable ? 'live' : 'frozen'
  }

  private async captureLiveFrame(candidate: PendingDisplay, exposeFrozenFrame: boolean, expectedBounds?: Rectangle): Promise<void> {
    if (candidate.surface === 'frozen') return
    const pending = this.pending
    if (!pending || !pending.candidates.has(candidate.window.webContents.id)) throw new Error('Screen capture was cancelled.')
    if (pending.topology !== this.currentTopology()) throw new Error('Display configuration changed; capture was cancelled.')
    const suppliedImage = candidate.streamImage
    const suppliedBounds = candidate.streamImageBounds
    candidate.streamImage = null
    candidate.streamImageBounds = null
    const suppliedFrameMatches = Boolean(suppliedImage) && (
      exposeFrozenFrame
        ? suppliedBounds === null
        : suppliedBounds === null || Boolean(expectedBounds && suppliedBounds && sameRectangle(expectedBounds, suppliedBounds))
    )
    const image = suppliedFrameMatches ? suppliedImage! : await this.captureScreenImage(candidate.display)
    if (this.pending !== pending || !pending.candidates.has(candidate.window.webContents.id)) throw new Error('Screen capture was cancelled.')
    if (pending.topology !== this.currentTopology()) throw new Error('Display configuration changed; capture was cancelled.')
    candidate.image = image
    candidate.imageBounds = suppliedFrameMatches ? suppliedBounds : null
    if (exposeFrozenFrame) {
      // Standard selection crops the NativeImage directly. Only Edit/Analyze pay the cost of
      // encoding and transferring a full-display image to the renderer.
      candidate.imageDataUrl = pngDataUrl(image)
      candidate.surface = 'frozen'
    }
  }

  private startSemanticSnapshot(candidate: PendingDisplay): void {
    if (candidate.semanticStarted) return
    candidate.semanticStarted = true
    const pending = this.pending
    const startedAt = Date.now()
    candidate.uiFeaturesReady = (this.uiAutomation
      ? this.uiAutomation.snapshot([], false, true).catch(() => [])
      : Promise.resolve([])
    ).then((uiElements) => {
      if (this.pending !== pending || !pending?.candidates.has(candidate.window.webContents.id)) return
      candidate.uiFeatures = mapUiAutomationFeatures(
        uiElements,
        candidate.display.bounds,
        (bounds) => typeof screen.screenToDipRect === 'function' ? screen.screenToDipRect(null, bounds) : bounds
      )
      console.info(`[capture] On-demand semantic scan completed in ${Date.now() - startedAt}ms with ${uiElements.length} visible controls.`)
    })
  }

  private retainOnlyCandidate(activeCandidate: PendingDisplay): void {
    const candidates = this.pending?.candidates
    if (!candidates) return
    for (const [webContentsId, candidate] of candidates) {
      if (candidate === activeCandidate) continue
      candidates.delete(webContentsId)
      candidate.streamImage = null
      candidate.streamImageBounds = null
      candidate.videoFrameExpiresAt = 0
      candidate.videoGrantEpoch += 1
      candidate.videoGrantExpiresAt = 0
      candidate.readinessError ??= new Error('Capture continued on another display.')
      candidate.resolveReady()
      candidate.resolveFrameReady()
      if (!candidate.window.isDestroyed()) candidate.window.close()
    }
  }

  private async activateFrozenFallback(error: unknown): Promise<void> {
    const destination = this.pending?.destination
    this.liveSelectionUnavailable = true
    console.warn(`[capture] Live frame acquisition failed; reopening frozen compatibility capture: ${error instanceof Error ? error.message : String(error)}`)
    this.clearPending(false)
    await this.beginFrozenRegion(undefined, destination)
  }

  private shouldUseFrozenFallback(error: unknown): boolean {
    if (this.disposed) return false
    const message = error instanceof Error ? error.message : String(error)
    return !/cancelled|configuration changed/i.test(message)
  }

  private findCandidate(senderWebContentsId?: number): PendingDisplay {
    if (!this.pending) throw new Error('There is no active screen capture.')
    const candidate = senderWebContentsId ? this.pending.candidates.get(senderWebContentsId) : [...this.pending.candidates.values()][0]
    if (!candidate) throw new Error('This overlay does not own a captured display.')
    return candidate
  }

  private async findCandidateAfterActivation(senderWebContentsId?: number): Promise<PendingDisplay> {
    if (this.pending) return this.findCandidate(senderWebContentsId)
    if (!senderWebContentsId) throw new Error('There is no active screen capture.')
    const prewarmed = [...this.prewarmedOverlays.values()].find(
      ({ window }) => window.webContents.id === senderWebContentsId
    )
    if (!prewarmed) throw new Error('There is no active screen capture.')
    await prewarmed.activation.promise
    return this.findCandidate(senderWebContentsId)
  }

  private claimPrewarmedOverlay(display: Display, surface: CaptureSurface): PrewarmedOverlay | null {
    const candidate = this.prewarmedOverlays.get(display.id)
    if (
      !candidate ||
      candidate.claimed ||
      candidate.surface !== surface ||
      candidate.displayKey !== displayKey(display) ||
      candidate.window.isDestroyed()
    ) return null
    candidate.claimed = true
    return candidate
  }

  private releasePrewarmedOverlay(displayId: number, candidate: PrewarmedOverlay): void {
    if (this.prewarmedOverlays.get(displayId) === candidate) this.prewarmedOverlays.delete(displayId)
    candidate.activation.resolve()
    if (!candidate.window.isDestroyed()) candidate.window.close()
  }

  private releaseAllPrewarmedOverlays(): void {
    for (const [displayId, candidate] of this.prewarmedOverlays) {
      this.releasePrewarmedOverlay(displayId, candidate)
    }
  }

  private async complete(candidate: PendingDisplay, bounded: Rectangle, operations: ImageEditOperation[], preferWebSearch = false, extractText = false, ocrLanguageCode?: string, initialQuestion?: string): Promise<void> {
    if (!candidate.image || !candidate.viewport) throw new Error('The frozen display image is unavailable.')
    let completedImage = candidate.image
    if (!candidate.imageBounds || !sameRectangle(candidate.imageBounds, bounded)) {
      const imageSize = candidate.image.getSize()
      const physical = logicalToPhysical(bounded, imageSize.width / candidate.viewport.width, imageSize.height / candidate.viewport.height)
      const crop = clampCropRectangle(physical, imageSize)
      if (crop.width < 1 || crop.height < 1) throw new Error('The selected area was outside the captured image.')
      completedImage = candidate.image.crop(crop)
    }
    const destination = this.pending?.destination
    this.clearPending(false)
    await this.saveCompleted(candidate.display, completedImage, bounded, destination, operations, preferWebSearch, extractText, ocrLanguageCode, initialQuestion)
  }

  private async saveCompleted(display: Display, image: NativeImage, selectedBounds: Rectangle, destination?: CaptureDestination, operations: ImageEditOperation[] = [], preferWebSearch = false, extractText = false, ocrLanguageCode?: string, initialQuestion?: string): Promise<void> {
    const sourcePath = await this.screenshots.save(image.toPNG())
    let imagePath = sourcePath
    try {
      if (operations.length) {
        if (!this.imageEditor) throw new Error('Screenshot editing is unavailable.')
        imagePath = await this.imageEditor.createDerivative(sourcePath, operations)
        await this.screenshots.delete(sourcePath)
      }
      await (destination?.onCompleted ?? this.onCompleted)({ imagePath, selectedBounds, display, edited: operations.length > 0, preferWebSearch, extractText, ...(ocrLanguageCode ? { ocrLanguageCode } : {}), ...(initialQuestion ? { initialQuestion } : {}) })
    } catch (error) {
      await this.screenshots.delete(imagePath)
      if (imagePath !== sourcePath) await this.screenshots.delete(sourcePath)
      throw error
    }
  }

  private clearPending(notifyCancelled: boolean): void {
    const pending = this.pending
    this.pending = null
    this.cancelCaptureStartup(new Error('Screen capture was cancelled.'))
    for (const candidate of pending?.candidates.values() ?? []) {
      candidate.streamImage = null
      candidate.streamImageBounds = null
      candidate.videoFrameExpiresAt = 0
      candidate.videoGrantEpoch += 1
      candidate.videoGrantExpiresAt = 0
      const analysisId = this.analysisIds.get(candidate.window.webContents.id)
      if (analysisId) {
        this.analysisIds.delete(candidate.window.webContents.id)
        void this.ocr?.cancel?.(analysisId).catch(() => undefined)
        void this.screenshotDetector?.cancel?.(analysisId).catch(() => undefined)
      }
      if (!candidate.image && !candidate.readinessError) candidate.readinessError = new Error('Screen capture was cancelled.')
      candidate.resolveReady()
      candidate.resolveFrameReady()
      if (!candidate.window.isDestroyed()) candidate.window.close()
    }
    if (notifyCancelled) pending?.destination?.onCancelled?.()
    this.prewarm()
  }

  private readonly cancelForTopologyChange = (): void => {
    this.releaseAllPrewarmedOverlays()
    if (this.pending && this.pending.topology !== this.currentTopology()) {
      this.cancel()
      this.onError('Display configuration changed; capture was cancelled cleanly.')
      return
    }
    this.prewarm()
  }
  private currentTopology(): string { return captureTopology(screen.getAllDisplays()) }
  private awaitCaptureStartup<T>(operation: Promise<T>): Promise<T> {
    this.cancelCaptureStartup(new Error('A newer screen capture replaced this startup request.'))
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        this.clearCaptureStartup()
        callback()
      }
      this.rejectStartup = (error) => settle(() => reject(error))
      this.startupTimer = setTimeout(() => {
        this.rejectStartup?.(new Error('The capture surface could not be prepared in time. Please try again.'))
      }, CAPTURE_STARTUP_TIMEOUT_MS)
      operation.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error))
      )
    })
  }
  private cancelCaptureStartup(error: Error): void {
    if (this.rejectStartup) this.rejectStartup(error)
    else this.clearCaptureStartup()
  }
  private clearCaptureStartup(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    this.rejectStartup = null
  }
}

function boundRectangle(rectangle: Rectangle, width: number, height: number): Rectangle {
  if (
    rectangle.x >= 0 &&
    rectangle.y >= 0 &&
    rectangle.width >= 0 &&
    rectangle.height >= 0 &&
    rectangle.x + rectangle.width <= width &&
    rectangle.y + rectangle.height <= height
  ) return { ...rectangle }
  const left = Math.max(0, Math.min(width, rectangle.x))
  const top = Math.max(0, Math.min(height, rectangle.y))
  const right = Math.max(left, Math.min(width, rectangle.x + rectangle.width))
  const bottom = Math.max(top, Math.min(height, rectangle.y + rectangle.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}
function sameRectangle(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}
function displayKey(display: Display): string {
  return `${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}:${display.scaleFactor}:${display.rotation ?? 0}`
}
function captureTopology(displays: Display[]): string {
  return displays.map((display) => `${display.id}:${displayKey(display)}`).sort().join('|')
}
function withTimeout<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((resolve, reject) => {
    void resolve
    timer = setTimeout(() => reject(new Error(message)), milliseconds)
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
function pngDataUrl(image: NativeImage): string { return `data:image/png;base64,${image.toPNG().toString('base64')}` }
function sourceHandle(source: DesktopCapturerSource): string { return source.id.split(':')[1]?.replace(/^0+/, '').toLowerCase() ?? '' }
function isBlank(image: NativeImage): boolean { const bitmap = image.resize({ width: 8, height: 8 }).toBitmap(); if (bitmap.length < 4) return true; const first = bitmap.subarray(0, 3).toString('hex'); for (let offset = 4; offset < bitmap.length; offset += 4) if (bitmap.subarray(offset, offset + 3).toString('hex') !== first) return false; return true }

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.byteLength < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

function isPlausibleVideoFrame(
  dimensions: { width: number; height: number },
  candidate: PendingDisplay,
  imageBounds: Rectangle | null
): boolean {
  if (!candidate.viewport || dimensions.width < 24 || dimensions.height < 24) return false
  const logicalBounds = imageBounds ?? candidate.viewport
  const expectedAspect = logicalBounds.width / logicalBounds.height
  const actualAspect = dimensions.width / dimensions.height
  if (Math.abs(actualAspect / expectedAspect - 1) > 0.05) return false
  const physicalScaleX = Math.max(1, candidate.display.bounds.width * candidate.display.scaleFactor / candidate.viewport.width)
  const physicalScaleY = Math.max(1, candidate.display.bounds.height * candidate.display.scaleFactor / candidate.viewport.height)
  const expectedWidth = Math.max(logicalBounds.width, Math.round(logicalBounds.width * physicalScaleX))
  const expectedHeight = Math.max(logicalBounds.height, Math.round(logicalBounds.height * physicalScaleY))
  const minWidth = Math.max(24, Math.floor(logicalBounds.width * 0.75))
  const minHeight = Math.max(24, Math.floor(logicalBounds.height * 0.75))
  const maxWidth = Math.min(16_384, Math.ceil(expectedWidth * 2))
  const maxHeight = Math.min(16_384, Math.ceil(expectedHeight * 2))
  return dimensions.width >= minWidth && dimensions.height >= minHeight && dimensions.width <= maxWidth && dimensions.height <= maxHeight && dimensions.width * dimensions.height <= 67_108_864
}

function captureRendererSecurityOrigin(): string | null {
  const configuredRenderer = process.env.ELECTRON_RENDERER_URL
  if (!configuredRenderer) return 'file://'
  try {
    const origin = new URL(configuredRenderer).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

export function supportsLiveRegionCapture(platform: NodeJS.Platform = process.platform, systemVersion: string = release()): boolean {
  if (platform !== 'win32') return false
  const build = Number(systemVersion.split('.')[2])
  return Number.isInteger(build) && build >= WINDOWS_CAPTURE_EXCLUSION_BUILD
}

async function getForegroundTarget(): Promise<{ sourceId: string; processId: number }> {
  const script = '$s=@"\nusing System;using System.Runtime.InteropServices;public static class F{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}\n"@;Add-Type $s;$h=[F]::GetForegroundWindow();[uint32]$p=0;[void][F]::GetWindowThreadProcessId($h,[ref]$p);@{sourceId=("window:{0:x}:0" -f $h.ToInt64());processId=$p}|ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout: 3_000, maxBuffer: 8_192 })
  const result = JSON.parse(stdout) as { sourceId?: unknown; processId?: unknown }
  if (typeof result.sourceId !== 'string' || !/^window:[0-9a-f]+:0$/i.test(result.sourceId) || typeof result.processId !== 'number') throw new Error('Could not resolve the focused window.')
  return { sourceId: result.sourceId, processId: result.processId }
}
