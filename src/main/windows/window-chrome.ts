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
  recoverRestoreBounds,
  resizeBoundsFromCursor,
  type ResizeSession
} from './window-geometry'

export type WindowChromeKind = 'settings' | 'question'
export type WindowPlacement = 'floating' | 'maximized'

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
  disposed: boolean
}

export interface WindowChromeScreenSource {
  getCursorScreenPoint(): Point
  getDisplayMatching(bounds: Rectangle): { workArea: Rectangle }
  getAllDisplays(): Array<{ workArea: Rectangle }>
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
    this.restoreBounds = copyRectangle(this.adapter.getBounds())
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
      this.setPlacement('maximized')
      this.adapter.setMovable(false)
      this.adapter.setBounds(copyRectangle(this.adapter.getWorkAreaForBounds(currentBounds)))
      return
    }

    const restoreBounds = this.restoreBounds ?? this.adapter.getBounds()
    const recoveredBounds = recoverRestoreBounds(restoreBounds, this.adapter.getWorkAreas())
    this.adapter.setBounds(recoveredBounds)
    this.restoreBounds = copyRectangle(recoveredBounds)
    this.adapter.setMovable(true)
    this.setPlacement('floating')
  }

  refitMaximizedBounds(): void {
    if (this.disposed || this.material !== 'transparent' || this.placement !== 'maximized') return
    const currentBounds = this.adapter.getBounds()
    this.adapter.setBounds(copyRectangle(this.adapter.getWorkAreaForBounds(currentBounds)))
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
      this.adapter.isDestroyed()
    ) {
      return false
    }

    const startBounds = this.adapter.getBounds()
    const session = createResizeSession(edge, startBounds, this.adapter.getCursorPoint())
    this.resizeSession = { ...session, lastAppliedBounds: copyRectangle(startBounds) }
    return true
  }

  updateResize(): boolean {
    if (this.disposed || !this.resizeSession || this.adapter.isDestroyed()) return false
    const nextBounds = resizeBoundsFromCursor(
      this.resizeSession,
      this.adapter.getCursorPoint(),
      this.minimumOuterSize
    )
    if (!nextBounds || rectanglesEqual(nextBounds, this.resizeSession.lastAppliedBounds)) return false
    this.adapter.setBounds(nextBounds)
    this.resizeSession.lastAppliedBounds = copyRectangle(nextBounds)
    return true
  }

  endResize(): boolean {
    if (!this.resizeSession) return false
    this.resizeSession = null
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
  let cleanedUp = false

  const cleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    unregister()
    controller.dispose()
  }

  window.on('ready-to-show', () => controller.markReadyToShow())
  window.on('focus', () => controller.setFocused(true))
  window.on('blur', () => {
    controller.endResize()
    controller.setFocused(false)
  })
  window.on('minimize', () => controller.handleMinimize())
  window.on('restore', () => controller.handleRestore())
  window.on('maximize', () => controller.handleNativeMaximize())
  window.on('unmaximize', () => controller.handleNativeUnmaximize())
  window.on('move', () => controller.handleBoundsChanged())
  window.on('resize', () => controller.handleBoundsChanged())
  window.once('closed', cleanup)
  window.webContents.once('destroyed', cleanup)
  controller.broadcastState()
  return controller
}

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
