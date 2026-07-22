import type { BrowserWindow } from 'electron'
import {
  IPC,
  isWindowResizeEdge,
  type WindowChromeState,
  type WindowMaterial,
  type WindowResizeEdge
} from '../../shared/contracts/ipc'
import type { Point, Rectangle, Size } from '@shared/types/geometry'
import { getWindowAppearanceSizes } from './window-appearance'
import {
  createResizeSession,
  fitWindowSizesToWorkArea,
  recoverRestoreBounds,
  refitBoundsToWorkAreas,
  resizeBoundsFromCursor,
  type ResizeSession
} from './window-geometry'

export type WindowChromeKind = 'settings' | 'question'
export type WindowPlacement = 'floating' | 'maximized'

export const WINDOW_CHROME_READY_TIMEOUT_MS = 10_000
export const WINDOW_CHROME_RESIZE_INTERVAL_MS = 16

export interface WindowChromeControllerOptions {
  kind: WindowChromeKind
  material: WindowMaterial
  surfaceSize: Size
  minimumSurfaceSize: Size
  canMinimize?: boolean
  canMaximize?: boolean
  canResize?: boolean
  fallbackRetryEligible?: boolean
  initiallyFocused?: boolean
  initiallyMaximized?: boolean
  onReady?: () => void
}

export interface WindowChromeAdapter {
  readonly windowId: number
  readonly webContentsId: number
  getBounds(): Rectangle
  setBounds(bounds: Rectangle): void
  setMinimumSize(size: Size): void
  setMovable(movable: boolean): void
  minimize(): void
  maximize(): void
  unmaximize(): void
  close(): void
  isDestroyed(): boolean
  getCursorPoint(): Point
  getWorkAreaForBounds(bounds: Rectangle): Rectangle
  getWorkAreas(): Rectangle[]
  broadcastState(state: WindowChromeState): void
}

export interface WindowChromeControllerSnapshot {
  windowId: number
  webContentsId: number
  kind: WindowChromeKind
  placement: WindowPlacement
  surfaceSize: Size
  minimumSurfaceSize: Size
  restoreBounds: Rectangle | null
  resizeSession: ResizeSession | null
  readyToShow: boolean
  rendererReady: boolean
  fallbackRetryEligible: boolean
  resizeUpdatePending: boolean
  disposed: boolean
}

export interface WindowChromeScreenSource {
  getCursorScreenPoint(): Point
  getDisplayMatching(bounds: Rectangle): { workArea: Rectangle }
  getAllDisplays(): Array<{ workArea: Rectangle }>
}

export interface OpenBrowserWindowWithChromeOptions {
  kind: WindowChromeKind
  label: string
  initialMaterial: WindowMaterial
  surfaceSize: Size
  minimumSurfaceSize: Size
  screenSource: WindowChromeScreenSource
  timeoutMs?: number
  canMinimize?: boolean
  canMaximize?: boolean
  canResize?: boolean
  createWindow(material: WindowMaterial): BrowserWindow
  loadRenderer(window: BrowserWindow): Promise<void>
  isWindowCurrent?(window: BrowserWindow): boolean
  beforeRetry?(window: BrowserWindow): void
}

export interface OpenedBrowserWindowWithChrome {
  window: BrowserWindow
  material: WindowMaterial
}

interface RegisteredSender {
  id: number
  mainFrame: unknown
}

export interface WindowChromeIpcEvent {
  sender: RegisteredSender
  senderFrame: unknown | null
}

interface ActiveResizeSession extends ResizeSession {
  lastAppliedBounds: Rectangle
  minimumSize: Size
}

export class WindowChromeController {
  readonly windowId: number
  readonly webContentsId: number
  readonly kind: WindowChromeKind

  private readonly material: WindowMaterial
  private readonly surfaceSize: Size
  private readonly minimumSurfaceSize: Size
  private readonly minimumOuterSize: Size
  private readonly canMinimize: boolean
  private readonly canMaximize: boolean
  private readonly canResize: boolean
  private readonly onReady?: () => void
  private focused: boolean
  private placement: WindowPlacement
  private restoreBounds: Rectangle | null
  private resizeSession: ActiveResizeSession | null = null
  private resizeUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private resizeUpdateQueued = false
  private lastResizeUpdateAt: number | null = null
  private appliedMinimumSize: Size | null = null
  private readyToShow = false
  private rendererReady = false
  private readySignalled = false
  private fallbackRetryEligible: boolean
  private disposed = false

  constructor(
    private readonly adapter: WindowChromeAdapter,
    options: WindowChromeControllerOptions
  ) {
    this.windowId = adapter.windowId
    this.webContentsId = adapter.webContentsId
    this.kind = options.kind
    this.material = options.material
    this.surfaceSize = copySize(options.surfaceSize)
    this.minimumSurfaceSize = copySize(options.minimumSurfaceSize)
    this.minimumOuterSize = getWindowAppearanceSizes(
      { surfaceSize: options.surfaceSize, minimumSurfaceSize: options.minimumSurfaceSize },
      options.material
    ).minimumSize
    this.canMinimize = options.canMinimize ?? true
    this.canMaximize = options.canMaximize ?? true
    this.canResize = options.canResize ?? true
    this.focused = options.initiallyFocused ?? false
    this.placement = options.initiallyMaximized ? 'maximized' : 'floating'
    this.restoreBounds = this.placement === 'floating' ? copyRectangle(adapter.getBounds()) : null
    this.fallbackRetryEligible = options.fallbackRetryEligible ?? options.material === 'transparent'
    this.onReady = options.onReady
  }

  getState(): WindowChromeState {
    return {
      focused: this.focused,
      maximized: this.placement === 'maximized',
      material: this.material,
      canMinimize: this.canMinimize,
      canMaximize: this.canMaximize,
      canResize: this.canResize && this.placement === 'floating'
    }
  }

  getSnapshot(): WindowChromeControllerSnapshot {
    return {
      windowId: this.windowId,
      webContentsId: this.webContentsId,
      kind: this.kind,
      placement: this.placement,
      surfaceSize: copySize(this.surfaceSize),
      minimumSurfaceSize: copySize(this.minimumSurfaceSize),
      restoreBounds: this.restoreBounds ? copyRectangle(this.restoreBounds) : null,
      resizeSession: this.resizeSession ? copyResizeSession(this.resizeSession) : null,
      readyToShow: this.readyToShow,
      rendererReady: this.rendererReady,
      fallbackRetryEligible: this.fallbackRetryEligible,
      resizeUpdatePending: this.resizeUpdateQueued,
      disposed: this.disposed
    }
  }

  broadcastState(): void {
    if (this.disposed || this.adapter.isDestroyed()) return
    this.adapter.broadcastState(this.getState())
  }

  setFocused(focused: boolean): void {
    if (this.disposed || this.focused === focused) return
    this.focused = focused
    this.broadcastState()
  }

  handleBoundsChanged(): void {
    if (this.disposed || this.placement !== 'floating' || this.adapter.isDestroyed()) return
    const bounds = this.adapter.getBounds()
    this.restoreBounds = copyRectangle(bounds)
    this.syncMinimumSize(bounds)
  }

  handleMinimize(): void {
    this.endResize()
  }

  handleRestore(): void {
    // BrowserWindow's restore event is a taskbar-minimize transition. It must not
    // be treated as leaving application-owned maximized state.
  }

  handleNativeMaximize(): void {
    if (this.material !== 'solid' || this.disposed) return
    this.setPlacement('maximized')
  }

  handleNativeUnmaximize(): void {
    if (this.material !== 'solid' || this.disposed) return
    this.setPlacement('floating')
    this.handleBoundsChanged()
  }

  minimizeWindow(): void {
    if (this.disposed || !this.canMinimize || this.adapter.isDestroyed()) return
    this.endResize()
    this.adapter.minimize()
  }

  toggleMaximize(): void {
    if (this.disposed || !this.canMaximize || this.adapter.isDestroyed()) return
    this.endResize()
    if (this.material === 'solid') {
      this.toggleNativeMaximize()
      return
    }

    if (this.placement === 'floating') {
      const currentBounds = this.adapter.getBounds()
      this.restoreBounds = copyRectangle(currentBounds)
      const maximizedBounds = this.adapter.getWorkAreaForBounds(currentBounds)
      this.syncMinimumSize(maximizedBounds)
      this.setPlacement('maximized')
      this.adapter.setMovable(false)
      this.adapter.setBounds(copyRectangle(maximizedBounds))
      return
    }

    const restoreBounds = this.restoreBounds ?? this.adapter.getBounds()
    const recoveredBounds = recoverRestoreBounds(restoreBounds, this.adapter.getWorkAreas())
    this.syncMinimumSize(recoveredBounds)
    this.adapter.setBounds(recoveredBounds)
    this.restoreBounds = copyRectangle(recoveredBounds)
    this.adapter.setMovable(true)
    this.setPlacement('floating')
  }

  handleDisplayChange(): boolean {
    if (this.disposed || this.adapter.isDestroyed()) return false
    this.endResize()

    const workAreas = this.adapter.getWorkAreas()
    if (workAreas.length === 0) return false

    if (this.restoreBounds) {
      this.restoreBounds = refitBoundsToWorkAreas(this.restoreBounds, workAreas)
    }

    const currentBounds = this.adapter.getBounds()
    if (this.placement === 'maximized') {
      if (this.material !== 'transparent') {
        this.syncMinimumSize(this.restoreBounds ?? currentBounds)
        return false
      }

      const maximizedBounds = this.adapter.getWorkAreaForBounds(currentBounds)
      this.syncMinimumSize(maximizedBounds)
      if (rectanglesEqual(maximizedBounds, currentBounds)) return false
      this.adapter.setBounds(copyRectangle(maximizedBounds))
      return true
    }

    const fittedBounds = refitBoundsToWorkAreas(currentBounds, workAreas)
    this.syncMinimumSize(fittedBounds)
    this.restoreBounds = copyRectangle(fittedBounds)
    if (rectanglesEqual(fittedBounds, currentBounds)) return false
    this.adapter.setBounds(fittedBounds)
    return true
  }

  closeWindow(): void {
    if (this.disposed || this.adapter.isDestroyed()) return
    this.endResize()
    this.adapter.close()
  }

  beginResize(edge: WindowResizeEdge): boolean {
    if (
      this.disposed ||
      this.material !== 'transparent' ||
      this.placement !== 'floating' ||
      !this.canResize ||
      !isWindowResizeEdge(edge) ||
      this.adapter.isDestroyed() ||
      this.resizeSession !== null
    ) {
      return false
    }

    const startBounds = this.adapter.getBounds()
    const minimumSize = this.getEffectiveMinimumSize(startBounds)
    this.setMinimumSize(minimumSize)
    const session = createResizeSession(edge, startBounds, this.adapter.getCursorPoint())
    this.resizeSession = {
      ...session,
      lastAppliedBounds: copyRectangle(session.startBounds),
      minimumSize
    }
    this.lastResizeUpdateAt = null
    return true
  }

  updateResize(): boolean {
    return this.applyResizeUpdate()
  }

  requestResizeUpdate(): boolean {
    if (this.disposed || !this.resizeSession || this.adapter.isDestroyed()) return false
    this.resizeUpdateQueued = true
    const now = Date.now()
    const elapsed = this.lastResizeUpdateAt === null ? WINDOW_CHROME_RESIZE_INTERVAL_MS : now - this.lastResizeUpdateAt
    if (elapsed >= WINDOW_CHROME_RESIZE_INTERVAL_MS) {
      this.resizeUpdateQueued = false
      this.lastResizeUpdateAt = now
      this.applyResizeUpdate()
      return true
    }

    if (this.resizeUpdateTimer !== null) return true
    const delay = Math.max(1, WINDOW_CHROME_RESIZE_INTERVAL_MS - Math.max(0, elapsed))
    this.resizeUpdateTimer = setTimeout(() => {
      this.resizeUpdateTimer = null
      if (!this.resizeUpdateQueued) return
      this.resizeUpdateQueued = false
      this.lastResizeUpdateAt = Date.now()
      this.applyResizeUpdate()
    }, delay)
    return true
  }

  private applyResizeUpdate(): boolean {
    if (this.disposed || !this.resizeSession || this.adapter.isDestroyed()) return false
    const nextBounds = resizeBoundsFromCursor(
      this.resizeSession,
      this.adapter.getCursorPoint(),
      this.resizeSession.minimumSize
    )
    if (!nextBounds || rectanglesEqual(nextBounds, this.resizeSession.lastAppliedBounds)) return false
    this.adapter.setBounds(nextBounds)
    this.resizeSession.lastAppliedBounds = copyRectangle(nextBounds)
    return true
  }

  endResize(): boolean {
    if (!this.resizeSession) return false
    if (this.resizeUpdateTimer !== null) {
      clearTimeout(this.resizeUpdateTimer)
      this.resizeUpdateTimer = null
    }
    this.resizeUpdateQueued = false
    this.applyResizeUpdate()
    this.resizeSession = null
    this.lastResizeUpdateAt = null
    return true
  }

  markReadyToShow(): boolean {
    if (!this.disposed) this.readyToShow = true
    return this.maybeSignalReady()
  }

  markRendererReady(): boolean {
    if (!this.disposed) this.rendererReady = true
    return this.maybeSignalReady()
  }

  claimFallbackRetry(): boolean {
    if (this.disposed || !this.fallbackRetryEligible) return false
    this.fallbackRetryEligible = false
    return true
  }

  dispose(): void {
    if (this.disposed) return
    if (this.resizeUpdateTimer !== null) clearTimeout(this.resizeUpdateTimer)
    this.resizeUpdateTimer = null
    this.resizeUpdateQueued = false
    this.lastResizeUpdateAt = null
    this.resizeSession = null
    this.disposed = true
  }

  private toggleNativeMaximize(): void {
    if (this.placement === 'maximized') {
      this.adapter.unmaximize()
      this.setPlacement('floating')
      this.handleBoundsChanged()
      return
    }

    this.restoreBounds = copyRectangle(this.adapter.getBounds())
    this.setPlacement('maximized')
    this.adapter.maximize()
  }

  private setPlacement(placement: WindowPlacement): void {
    if (this.placement === placement) return
    this.placement = placement
    this.broadcastState()
  }

  private getEffectiveMinimumSize(bounds: Rectangle): Size {
    const workArea = this.adapter.getWorkAreaForBounds(bounds)
    return fitWindowSizesToWorkArea(this.minimumOuterSize, this.minimumOuterSize, workArea).minimumSize
  }

  private syncMinimumSize(bounds: Rectangle): void {
    this.setMinimumSize(this.getEffectiveMinimumSize(bounds))
  }

  private setMinimumSize(size: Size): void {
    if (this.appliedMinimumSize && sizesEqual(this.appliedMinimumSize, size)) return
    this.appliedMinimumSize = copySize(size)
    this.adapter.setMinimumSize(size)
  }

  private maybeSignalReady(): boolean {
    const ready = !this.disposed && this.readyToShow && this.rendererReady
    if (ready && !this.readySignalled) {
      this.readySignalled = true
      this.onReady?.()
    }
    return ready
  }
}

export class WindowChromeRegistry {
  private readonly controllers = new Map<number, WindowChromeController>()

  register(controller: WindowChromeController): () => void {
    const existing = this.controllers.get(controller.webContentsId)
    if (existing && existing !== controller) {
      throw new Error('A window chrome controller is already registered for this sender.')
    }
    this.controllers.set(controller.webContentsId, controller)
    let registered = true
    return () => {
      if (!registered) return
      registered = false
      this.unregister(controller.webContentsId, controller)
    }
  }

  get(webContentsId: number): WindowChromeController | null {
    return this.controllers.get(webContentsId) ?? null
  }

  unregister(webContentsId: number, expectedController?: WindowChromeController): void {
    if (expectedController && this.controllers.get(webContentsId) !== expectedController) return
    this.controllers.delete(webContentsId)
  }

  get size(): number {
    return this.controllers.size
  }
}

export const windowChromeRegistry = new WindowChromeRegistry()

export async function openBrowserWindowWithChrome(
  options: OpenBrowserWindowWithChromeOptions
): Promise<OpenedBrowserWindowWithChrome> {
  const openAttempt = async (
    material: WindowMaterial,
    fallbackRetryEligible: boolean,
    attempt: number
  ): Promise<OpenedBrowserWindowWithChrome> => {
    const startedAt = Date.now()
    const window = options.createWindow(material)
    let settled = false
    let readinessTimer: ReturnType<typeof setTimeout> | null = null
    let settleReadiness!: (outcome: WindowChromeReadinessOutcome) => void
    const readiness = new Promise<WindowChromeReadinessOutcome>((resolve) => {
      settleReadiness = (outcome): void => {
        if (settled) return
        settled = true
        if (readinessTimer) clearTimeout(readinessTimer)
        resolve(outcome)
      }
    })
    const controller = registerBrowserWindowChrome(window, options.screenSource, {
      kind: options.kind,
      material,
      surfaceSize: options.surfaceSize,
      minimumSurfaceSize: options.minimumSurfaceSize,
      canMinimize: options.canMinimize,
      canMaximize: options.canMaximize,
      canResize: options.canResize,
      fallbackRetryEligible,
      onReady: () => settleReadiness('ready')
    })

    window.once('closed', () => settleReadiness('closed'))
    readinessTimer = setTimeout(
      () => settleReadiness('timeout'),
      options.timeoutMs ?? WINDOW_CHROME_READY_TIMEOUT_MS
    )

    let outcome: WindowChromeReadinessOutcome
    try {
      const navigation = options.loadRenderer(window).then(() => readiness)
      outcome = await Promise.race([readiness, navigation])
    } catch (error) {
      if (readinessTimer) clearTimeout(readinessTimer)
      if (!window.isDestroyed()) window.destroy()
      throw error
    }

    const current = options.isWindowCurrent?.(window) ?? true
    if (outcome === 'ready' && current && !window.isDestroyed()) {
      window.show()
      if (material === 'solid') {
        console.info(
          `[window] ${options.label} solid mode ready (kind=${options.kind}, attempt=${attempt}, fallback=${attempt > 1}, ` +
          `window=${window.id}, web-contents=${window.webContents.id}, elapsed=${Date.now() - startedAt}ms).`
        )
      }
      return { window, material }
    }

    if (outcome === 'timeout') {
      const snapshot = controller.getSnapshot()
      const elapsed = Date.now() - startedAt
      console.warn(
        `[window] ${options.label} readiness timed out (kind=${options.kind}, attempt=${attempt}, material=${material}, ` +
        `window=${snapshot.windowId}, web-contents=${snapshot.webContentsId}, elapsed=${elapsed}ms, ` +
        `ready-to-show=${snapshot.readyToShow}, renderer-ready=${snapshot.rendererReady}, ` +
        `current=${current}, destroyed=${window.isDestroyed()}).`
      )
      const shouldRetrySolid = controller.claimFallbackRetry()
      if (shouldRetrySolid) {
        console.warn(`[window] ${options.label} retrying once in solid mode after transparent readiness timeout.`)
        options.beforeRetry?.(window)
      }
      if (!window.isDestroyed()) window.destroy()
      if (shouldRetrySolid) return openAttempt('solid', false, attempt + 1)
      throw new Error(
        `${options.label} readiness timed out in ${material} mode ` +
        `(ready-to-show=${snapshot.readyToShow}, renderer-ready=${snapshot.rendererReady}).`
      )
    }

    if (!window.isDestroyed()) window.destroy()
    throw new Error(
      `${options.label} closed before startup readiness completed ` +
      `(attempt=${attempt}, material=${material}, current=${current}).`
    )
  }

  return openAttempt(options.initialMaterial, options.initialMaterial === 'transparent', 1)
}

export function resolveWindowChromeController(
  event: WindowChromeIpcEvent,
  registry: WindowChromeRegistry = windowChromeRegistry
): WindowChromeController {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Window chrome requests must come from the sender main frame.')
  }
  const controller = registry.get(event.sender.id)
  if (!controller) throw new Error('Window chrome is unavailable for this sender.')
  return controller
}

export function registerBrowserWindowChrome(
  window: BrowserWindow,
  screenSource: WindowChromeScreenSource,
  options: WindowChromeControllerOptions,
  registry: WindowChromeRegistry = windowChromeRegistry
): WindowChromeController {
  const adapter = createBrowserWindowChromeAdapter(window, screenSource)
  const controller = new WindowChromeController(adapter, options)
  const unregister = registry.register(controller)
  const displayEvents = screenSource as WindowChromeScreenSource & {
    on?: (event: string, listener: (...arguments_: unknown[]) => void) => void
    off?: (event: string, listener: (...arguments_: unknown[]) => void) => void
  }
  const handleDisplayMetricsChanged = (
    _event: unknown,
    _display: unknown,
    changedMetrics?: unknown
  ): void => {
    if (
      Array.isArray(changedMetrics) &&
      !changedMetrics.some((metric) =>
        metric === 'bounds' || metric === 'workArea' || metric === 'scaleFactor'
      )
    ) {
      return
    }
    controller.handleDisplayChange()
  }
  const handleDisplayRemoved = (): void => {
    controller.handleDisplayChange()
  }
  const handleReadyToShow = (): void => {
    controller.markReadyToShow()
  }
  const handleFocus = (): void => {
    controller.setFocused(true)
  }
  const handleBlur = (): void => {
    controller.endResize()
    controller.setFocused(false)
  }
  const handleMinimize = (): void => {
    controller.handleMinimize()
  }
  const handleRestore = (): void => {
    controller.handleRestore()
  }
  const handleMaximize = (): void => {
    controller.handleNativeMaximize()
  }
  const handleUnmaximize = (): void => {
    controller.handleNativeUnmaximize()
  }
  const handleBoundsChanged = (): void => {
    controller.handleBoundsChanged()
  }

  displayEvents.on?.('display-metrics-changed', handleDisplayMetricsChanged)
  displayEvents.on?.('display-removed', handleDisplayRemoved)
  let cleanedUp = false

  const cleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    displayEvents.off?.('display-metrics-changed', handleDisplayMetricsChanged)
    displayEvents.off?.('display-removed', handleDisplayRemoved)
    window.off('ready-to-show', handleReadyToShow)
    window.off('focus', handleFocus)
    window.off('blur', handleBlur)
    window.off('minimize', handleMinimize)
    window.off('restore', handleRestore)
    window.off('maximize', handleMaximize)
    window.off('unmaximize', handleUnmaximize)
    window.off('move', handleBoundsChanged)
    window.off('resize', handleBoundsChanged)
    window.off('closed', cleanup)
    window.webContents.off('destroyed', cleanup)
    unregister()
    controller.dispose()
  }

  window.on('ready-to-show', handleReadyToShow)
  window.on('focus', handleFocus)
  window.on('blur', handleBlur)
  window.on('minimize', handleMinimize)
  window.on('restore', handleRestore)
  window.on('maximize', handleMaximize)
  window.on('unmaximize', handleUnmaximize)
  window.on('move', handleBoundsChanged)
  window.on('resize', handleBoundsChanged)
  window.once('closed', cleanup)
  window.webContents.once('destroyed', cleanup)
  controller.broadcastState()
  return controller
}

type WindowChromeReadinessOutcome = 'ready' | 'timeout' | 'closed'

function createBrowserWindowChromeAdapter(
  window: BrowserWindow,
  screenSource: WindowChromeScreenSource
): WindowChromeAdapter {
  const windowId = window.id
  const webContentsId = window.webContents.id
  return {
    windowId,
    webContentsId,
    getBounds: () => copyRectangle(window.getBounds()),
    setBounds: (bounds) => window.setBounds(copyRectangle(bounds)),
    setMinimumSize: (size) => window.setMinimumSize(size.width, size.height),
    setMovable: (movable) => window.setMovable(movable),
    minimize: () => window.minimize(),
    maximize: () => window.maximize(),
    unmaximize: () => window.unmaximize(),
    close: () => window.close(),
    isDestroyed: () => window.isDestroyed(),
    getCursorPoint: () => ({ ...screenSource.getCursorScreenPoint() }),
    getWorkAreaForBounds: (bounds) => copyRectangle(screenSource.getDisplayMatching(bounds).workArea),
    getWorkAreas: () => screenSource.getAllDisplays().map((display) => copyRectangle(display.workArea)),
    broadcastState: (state) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(IPC.windowChromeStateChanged, { ...state })
      }
    }
  }
}

function rectanglesEqual(first: Rectangle, second: Rectangle): boolean {
  return (
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height
  )
}

function sizesEqual(first: Size, second: Size): boolean {
  return first.width === second.width && first.height === second.height
}

function copyRectangle(rectangle: Rectangle): Rectangle {
  return { ...rectangle }
}

function copySize(size: Size): Size {
  return { ...size }
}

function copyResizeSession(session: ResizeSession): ResizeSession {
  return {
    edge: session.edge,
    startBounds: copyRectangle(session.startBounds),
    startCursor: { ...session.startCursor }
  }
}
