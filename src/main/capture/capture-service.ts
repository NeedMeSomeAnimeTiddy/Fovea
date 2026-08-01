import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { BrowserWindow, desktopCapturer, screen, type DesktopCapturerSource, type Display, type NativeImage } from 'electron'
import type { CaptureContext } from '@shared/contracts/ipc'
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

interface PendingDisplay {
  display: Display
  image: NativeImage | null
  imageDataUrl: string | null
  viewport: Rectangle | null
  window: BrowserWindow
  ready: Promise<void>
  resolveReady(): void
  readinessError: Error | null
  uiFeatures: CaptureFeature[]
  uiFeaturesReady: Promise<void>
}
interface PrewarmedOverlay {
  displayKey: string
  window: BrowserWindow
  rendererReady: Promise<void>
  activation: ReturnType<typeof createDeferred>
  claimed: boolean
}
interface CaptureDescriptor { mode: CaptureMode; displayId?: number; rectangle?: Rectangle; sourceId?: string }
interface PendingCapture { candidates: Map<number, PendingDisplay>; topology: string; destination?: CaptureDestination }

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
  private disposed = false

  constructor(
    private readonly screenshots: TempScreenshotStore,
    private readonly onCompleted: (capture: CompletedCapture) => Promise<void>,
    private readonly onError: (message: string) => void,
    private readonly imageEditor?: Pick<ImageEditorService, 'createDerivative'>,
    private readonly ocr?: Pick<OcrService, 'recognise' | 'cancel'>,
    private readonly uiAutomation?: UiAutomationSnapshotService,
    private readonly screenshotDetector?: ScreenshotElementDetector
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
    if (!candidate.image || !candidate.imageDataUrl || !candidate.viewport) throw new Error('The frozen display image is unavailable.')
    return { width: candidate.viewport.width, height: candidate.viewport.height, minSelectionSize: 24, displayId: String(candidate.display.id), imageDataUrl: candidate.imageDataUrl, canEditBeforeSending: !this.pending?.destination }
  }

  async analyze(senderWebContentsId?: number, onProgress?: (analysis: CaptureAnalysis) => void): Promise<CaptureAnalysis> {
    const analysisStartedAt = Date.now()
    const candidate = this.findCandidate(senderWebContentsId)
    await candidate.ready
    if (candidate.readinessError) throw candidate.readinessError
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
    const allowedOperations = this.pending?.destination ? [] : operations
    this.lastDescriptor = { mode: 'region', displayId: candidate.display.id, rectangle: bounded }
    await this.complete(candidate, bounded, allowedOperations, preferWebSearch, extractText, ocrLanguageCode, initialQuestion)
  }

  cancel(): void {
    this.clearPending(true)
  }

  prewarm(): void {
    if (this.disposed || this.pending) return
    for (const display of screen.getAllDisplays()) {
      const current = this.prewarmedOverlays.get(display.id)
      if (current && current.displayKey === displayKey(display) && !current.window.isDestroyed()) continue
      if (current) this.releasePrewarmedOverlay(display.id, current)
      const window = this.createOverlay(display)
      const entry: PrewarmedOverlay = {
        displayKey: displayKey(display),
        window,
        rendererReady: Promise.resolve(),
        activation: createDeferred(),
        claimed: false
      }
      this.prewarmedOverlays.set(display.id, entry)
      entry.rendererReady = loadRenderer(window, 'overlay').catch((error) => {
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
    void this.screenshotDetector?.dispose?.().catch((error) => {
      console.warn(`[capture] Screenshot detector shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    screen.off('display-added', this.cancelForTopologyChange)
    screen.off('display-removed', this.cancelForTopologyChange)
    screen.off('display-metrics-changed', this.cancelForTopologyChange)
  }

  private async beginRegion(descriptor?: CaptureDescriptor, destination?: CaptureDestination): Promise<void> {
    const startupStartedAt = Date.now()
    const displays = screen.getAllDisplays()
    const semanticStartedAt = Date.now()
    const semanticSnapshot = this.uiAutomation
      ? this.uiAutomation.snapshot([], false, true).catch(() => [])
      : Promise.resolve([])
    const topology = displays.map((display) => `${display.id}:${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}:${display.scaleFactor}`).sort().join('|')
    const maxWidth = Math.max(...displays.map((display) => Math.round(display.bounds.width * display.scaleFactor)))
    const maxHeight = Math.max(...displays.map((display) => Math.round(display.bounds.height * display.scaleFactor)))
    const candidates = new Map<number, PendingDisplay>()
    const rendererReadiness: Promise<void>[] = []
    const claimedPrewarmed: Array<[number, PrewarmedOverlay]> = []
    for (const display of displays) {
      if (descriptor?.displayId && descriptor.displayId !== display.id) continue
      const prewarmed = this.claimPrewarmedOverlay(display)
      const overlay = prewarmed?.window ?? this.createOverlay(display)
      rendererReadiness.push(prewarmed?.rendererReady ?? loadRenderer(overlay, 'overlay'))
      if (prewarmed) claimedPrewarmed.push([display.id, prewarmed])
      const deferred = createDeferred()
      candidates.set(overlay.webContents.id, {
        display,
        image: null,
        imageDataUrl: null,
        viewport: null,
        window: overlay,
        ready: deferred.promise,
        resolveReady: deferred.resolve,
        readinessError: null,
        uiFeatures: [],
        uiFeaturesReady: Promise.resolve()
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
      const [sources] = await this.awaitCaptureStartup(Promise.all([
        screenImages,
        rendererLoads
      ] as const))
      if (this.pending?.candidates !== candidates) throw new Error('Screen capture was cancelled.')
      if (topology !== this.currentTopology()) throw new Error('Display configuration changed; capture was cancelled.')
      const imagePreparationStartedAt = Date.now()
      for (const [webContentsId, candidate] of candidates) {
        const source = sources.find((entry) => entry.display_id === String(candidate.display.id))
        if (!source || source.thumbnail.isEmpty()) {
          candidate.readinessError = new Error('Windows did not provide a usable image for this display.')
          candidate.resolveReady()
          if (!candidate.window.isDestroyed()) candidate.window.close()
          candidates.delete(webContentsId)
          continue
        }
        candidate.image = source.thumbnail
        candidate.imageDataUrl = jpegDataUrl(source.thumbnail)
        candidate.viewport = this.alignOverlayToDisplay(candidate)
      }
      console.info(`[capture] Frozen bitmap encoded in ${Date.now() - imagePreparationStartedAt}ms.`)
      if (!candidates.size) throw new Error('Windows did not provide any screen images to capture.')
      const semanticReady = semanticSnapshot.then((uiElements) => {
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
        if (!candidate.window.isDestroyed()) candidate.window.showInactive()
      }
      console.info(`[capture] Frozen screen displayed in ${Date.now() - startupStartedAt}ms.`)
      // Loading a large detector must never delay the frozen bitmap. Start it
      // only after the overlay is visible, then keep it resident for Analyze.
      void this.screenshotDetector?.prepare?.().catch((error) => {
        console.warn(
          `[capture] Screenshot detector prewarm failed: ` +
          `${error instanceof Error ? error.message : String(error)}`
        )
      })
      void semanticReady.finally(() => {
        if (this.pending?.candidates !== candidates) return
        for (const candidate of candidates.values()) {
          if (!candidate.window.isDestroyed()) candidate.window.focus()
        }
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

  private createOverlay(display: Display): BrowserWindow {
    const overlay = secureWindow({ x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height, useContentSize: true, frame: false, transparent: false, backgroundColor: WINDOW_BACKGROUND_COLOR, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, maximizable: false, fullscreenable: false, focusable: true, show: false, hasShadow: false })
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    overlay.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); this.cancel() } })
    overlay.webContents.once('render-process-gone', () => { this.cancel(); this.onError('The screen selection overlay stopped responding.') })
    return overlay
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

  private claimPrewarmedOverlay(display: Display): PrewarmedOverlay | null {
    const candidate = this.prewarmedOverlays.get(display.id)
    if (
      !candidate ||
      candidate.claimed ||
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
    const imageSize = candidate.image.getSize()
    const physical = logicalToPhysical(bounded, imageSize.width / candidate.viewport.width, imageSize.height / candidate.viewport.height)
    const crop = clampCropRectangle(physical, imageSize)
    if (crop.width < 1 || crop.height < 1) throw new Error('The selected area was outside the captured image.')
    const destination = this.pending?.destination
    this.clearPending(false)
    await this.saveCompleted(candidate.display, candidate.image.crop(crop), bounded, destination, operations, preferWebSearch, extractText, ocrLanguageCode, initialQuestion)
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
      const analysisId = this.analysisIds.get(candidate.window.webContents.id)
      if (analysisId) {
        this.analysisIds.delete(candidate.window.webContents.id)
        void this.ocr?.cancel?.(analysisId).catch(() => undefined)
        void this.screenshotDetector?.cancel?.(analysisId).catch(() => undefined)
      }
      if (!candidate.image && !candidate.readinessError) candidate.readinessError = new Error('Screen capture was cancelled.')
      candidate.resolveReady()
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
  private currentTopology(): string { return screen.getAllDisplays().map((display) => `${display.id}:${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}:${display.scaleFactor}`).sort().join('|') }
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
        this.rejectStartup?.(new Error('The frozen screen could not be prepared in time. Please try again.'))
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
  const x = Math.max(0, Math.min(width, rectangle.x)); const y = Math.max(0, Math.min(height, rectangle.y))
  return { x, y, width: Math.max(0, Math.min(rectangle.width, width - x)), height: Math.max(0, Math.min(rectangle.height, height - y)) }
}
function sameRectangle(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}
function displayKey(display: Display): string {
  return `${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}:${display.scaleFactor}`
}
function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}
function jpegDataUrl(image: NativeImage): string { return `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}` }
function sourceHandle(source: DesktopCapturerSource): string { return source.id.split(':')[1]?.replace(/^0+/, '').toLowerCase() ?? '' }
function isBlank(image: NativeImage): boolean { const bitmap = image.resize({ width: 8, height: 8 }).toBitmap(); if (bitmap.length < 4) return true; const first = bitmap.subarray(0, 3).toString('hex'); for (let offset = 4; offset < bitmap.length; offset += 4) if (bitmap.subarray(offset, offset + 3).toString('hex') !== first) return false; return true }

async function getForegroundTarget(): Promise<{ sourceId: string; processId: number }> {
  const script = '$s=@"\nusing System;using System.Runtime.InteropServices;public static class F{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}\n"@;Add-Type $s;$h=[F]::GetForegroundWindow();[uint32]$p=0;[void][F]::GetWindowThreadProcessId($h,[ref]$p);@{sourceId=("window:{0:x}:0" -f $h.ToInt64());processId=$p}|ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout: 3_000, maxBuffer: 8_192 })
  const result = JSON.parse(stdout) as { sourceId?: unknown; processId?: unknown }
  if (typeof result.sourceId !== 'string' || !/^window:[0-9a-f]+:0$/i.test(result.sourceId) || typeof result.processId !== 'number') throw new Error('Could not resolve the focused window.')
  return { sourceId: result.sourceId, processId: result.processId }
}
