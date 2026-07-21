import { describe, expect, it, vi } from 'vitest'
import { isWindowResizeEdge, WINDOW_RESIZE_EDGES, type WindowMaterial } from '../src/shared/contracts/ipc'
import type { Point, Rectangle } from '../src/shared/types/geometry'
import {
  resolveWindowChromeController,
  WindowChromeController,
  WindowChromeRegistry,
  type WindowChromeAdapter,
  type WindowChromeControllerOptions
} from '../src/main/windows/window-chrome'
import { getWorkAreaMaximizedBounds } from '../src/main/windows/window-geometry'

class FakeWindowAdapter implements WindowChromeAdapter {
  readonly windowId: number
  readonly webContentsId: number
  bounds: Rectangle = { x: -1200, y: 60, width: 674, height: 784 }
  cursor: Point = { x: -1200, y: 60 }
  workAreas: Rectangle[] = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: -1600, y: -120, width: 1600, height: 900 }
  ]
  destroyed = false
  readonly setBoundsCalls: Rectangle[] = []
  readonly minimumSizeCalls: Array<{ width: number; height: number }> = []
  readonly movableCalls: boolean[] = []
  readonly broadcasts: Array<ReturnType<WindowChromeController['getState']>> = []
  minimizeCalls = 0
  maximizeCalls = 0
  unmaximizeCalls = 0
  closeCalls = 0

  constructor(webContentsId = 101, windowId = 11) {
    this.webContentsId = webContentsId
    this.windowId = windowId
  }

  getBounds(): Rectangle {
    return { ...this.bounds }
  }

  setBounds(bounds: Rectangle): void {
    this.bounds = { ...bounds }
    this.setBoundsCalls.push({ ...bounds })
  }

  setMinimumSize(size: { width: number; height: number }): void {
    this.minimumSizeCalls.push({ ...size })
  }

  setMovable(movable: boolean): void {
    this.movableCalls.push(movable)
  }

  minimize(): void {
    this.minimizeCalls += 1
  }

  maximize(): void {
    this.maximizeCalls += 1
  }

  unmaximize(): void {
    this.unmaximizeCalls += 1
  }

  close(): void {
    this.closeCalls += 1
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getCursorPoint(): Point {
    return { ...this.cursor }
  }

  getWorkAreaForBounds(bounds: Rectangle): Rectangle {
    return getWorkAreaMaximizedBounds(bounds, this.workAreas)
  }

  getWorkAreas(): Rectangle[] {
    return this.workAreas.map((workArea) => ({ ...workArea }))
  }

  broadcastState(state: ReturnType<WindowChromeController['getState']>): void {
    this.broadcasts.push({ ...state })
  }
}

function createController(
  material: WindowMaterial = 'transparent',
  overrides: Partial<WindowChromeControllerOptions> = {},
  adapter = new FakeWindowAdapter()
): { controller: WindowChromeController; adapter: FakeWindowAdapter } {
  const options: WindowChromeControllerOptions = {
    kind: 'settings',
    material,
    surfaceSize: { width: 650, height: 760 },
    minimumSurfaceSize: { width: 560, height: 640 },
    ...overrides
  }
  return { controller: new WindowChromeController(adapter, options), adapter }
}

describe('window chrome controller state', () => {
  it('owns window kind, material, configured sizes, placement, and copied state', () => {
    const { controller } = createController('transparent', { kind: 'question' })
    const snapshot = controller.getSnapshot()
    const state = controller.getState()

    expect(snapshot).toMatchObject({
      kind: 'question',
      placement: 'floating',
      surfaceSize: { width: 650, height: 760 },
      minimumSurfaceSize: { width: 560, height: 640 },
      readyToShow: false,
      rendererReady: false,
      fallbackRetryEligible: true
    })
    expect(state).toEqual({
      focused: false,
      maximized: false,
      material: 'transparent',
      canMinimize: true,
      canMaximize: true,
      canResize: true
    })

    snapshot.surfaceSize.width = 1
    state.focused = true
    expect(controller.getSnapshot().surfaceSize.width).toBe(650)
    expect(controller.getState().focused).toBe(false)
  })

  it('broadcasts copied state and only changes the focused field on focus and blur', () => {
    const { controller, adapter } = createController()
    const initial = controller.getState()

    controller.setFocused(true)
    expect(controller.getState()).toEqual({ ...initial, focused: true })
    expect(adapter.broadcasts).toEqual([{ ...initial, focused: true }])

    adapter.broadcasts[0]!.focused = false
    expect(controller.getState().focused).toBe(true)
    controller.setFocused(true)
    expect(adapter.broadcasts).toHaveLength(1)

    controller.setFocused(false)
    expect(controller.getState()).toEqual(initial)
  })

  it('saves exact floating bounds, application-maximizes to work area, and restores', () => {
    const { controller, adapter } = createController()
    const floatingBounds = { ...adapter.bounds }

    controller.toggleMaximize()
    expect(controller.getState()).toMatchObject({ maximized: true, canResize: false })
    expect(controller.getSnapshot().restoreBounds).toEqual(floatingBounds)
    expect(adapter.movableCalls).toEqual([false])
    expect(adapter.bounds).toEqual(adapter.workAreas[1])

    controller.toggleMaximize()
    expect(controller.getState()).toMatchObject({ maximized: false, canResize: true })
    expect(adapter.bounds).toEqual(floatingBounds)
    expect(adapter.movableCalls).toEqual([false, true])
  })

  it('recovers saved floating bounds when their display has been removed', () => {
    const { controller, adapter } = createController()
    controller.toggleMaximize()
    adapter.workAreas = [{ x: 0, y: 0, width: 1280, height: 720 }]

    controller.toggleMaximize()
    expect(adapter.bounds).toEqual({ x: 0, y: 0, width: 674, height: 720 })
    expect(controller.getSnapshot().restoreBounds).toEqual(adapter.bounds)
  })

  it('refits application-maximized and saved bounds after display removal', () => {
    const { controller, adapter } = createController()
    controller.toggleMaximize()
    adapter.workAreas = [{ x: 0, y: 0, width: 1280, height: 720 }]

    expect(controller.handleDisplayChange()).toBe(true)
    expect(adapter.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    expect(controller.getSnapshot().restoreBounds).toEqual({ x: 0, y: 0, width: 674, height: 720 })

    controller.toggleMaximize()
    expect(adapter.bounds).toEqual({ x: 0, y: 0, width: 674, height: 720 })
  })

  it('refits a maximized window when taskbar work-area metrics change', () => {
    const { controller, adapter } = createController()
    controller.toggleMaximize()
    adapter.workAreas[1] = { x: -1600, y: -80, width: 1600, height: 860 }

    expect(controller.handleDisplayChange()).toBe(true)
    expect(adapter.bounds).toEqual(adapter.workAreas[1])
    expect(controller.getState().maximized).toBe(true)
  })

  it('contains floating bounds and effective minimums after mixed-DPI work-area changes', () => {
    const { controller, adapter } = createController()
    adapter.bounds = { x: -1500.4, y: -100.4, width: 674.4, height: 784.4 }
    adapter.workAreas = [{ x: -1279.6, y: 39.6, width: 1279.6, height: 720.4 }]

    expect(controller.handleDisplayChange()).toBe(true)
    expect(adapter.bounds).toEqual({ x: -1279, y: 40, width: 674, height: 720 })
    expect(adapter.minimumSizeCalls.at(-1)).toEqual({ width: 584, height: 664 })
    expect(controller.getSnapshot().restoreBounds).toEqual(adapter.bounds)
  })

  it('uses native maximize in solid mode while exposing normalized state', () => {
    const { controller, adapter } = createController('solid')

    controller.toggleMaximize()
    expect(adapter.maximizeCalls).toBe(1)
    expect(adapter.setBoundsCalls).toHaveLength(0)
    expect(controller.getState()).toMatchObject({ material: 'solid', maximized: true, canResize: false })

    controller.toggleMaximize()
    expect(adapter.unmaximizeCalls).toBe(1)
    expect(controller.getState()).toMatchObject({ maximized: false, canResize: true })
  })

  it('preserves application-maximized state through minimize and taskbar restore', () => {
    const { controller, adapter } = createController()
    controller.toggleMaximize()

    controller.minimizeWindow()
    controller.handleMinimize()
    controller.handleRestore()

    expect(adapter.minimizeCalls).toBe(1)
    expect(controller.getState().maximized).toBe(true)
    expect(controller.getSnapshot().placement).toBe('maximized')
  })

  it('requires both readiness signals and invokes readiness once', () => {
    const onReady = vi.fn()
    const { controller } = createController('transparent', { onReady })

    expect(controller.markRendererReady()).toBe(false)
    expect(controller.getSnapshot()).toMatchObject({ rendererReady: true, readyToShow: false })
    expect(controller.markReadyToShow()).toBe(true)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(controller.markRendererReady()).toBe(true)
    expect(controller.markReadyToShow()).toBe(true)
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('permits only one solid-fallback retry', () => {
    const transparent = createController().controller
    const solid = createController('solid').controller

    expect(transparent.claimFallbackRetry()).toBe(true)
    expect(transparent.claimFallbackRetry()).toBe(false)
    expect(transparent.getSnapshot().fallbackRetryEligible).toBe(false)
    expect(solid.claimFallbackRetry()).toBe(false)
  })
})

describe('window chrome resize state', () => {
  it('samples cursor DIP in main-owned state and ignores stale updates after end', () => {
    const { controller, adapter } = createController()
    adapter.cursor = { x: -1200, y: 60 }
    expect(controller.beginResize('right')).toBe(true)
    expect(controller.getSnapshot().resizeSession).toMatchObject({ edge: 'right' })

    adapter.cursor = { x: -1100.4, y: 60 }
    expect(controller.updateResize()).toBe(true)
    expect(adapter.bounds).toEqual({ x: -1200, y: 60, width: 774, height: 784 })
    expect(controller.endResize()).toBe(true)

    const updatesAtEnd = adapter.setBoundsCalls.length
    adapter.cursor = { x: -900, y: 60 }
    expect(controller.updateResize()).toBe(false)
    expect(controller.endResize()).toBe(false)
    expect(adapter.setBoundsCalls).toHaveLength(updatesAtEnd)
  })

  it('coalesces main-process resize requests and flushes the final cursor on teardown', async () => {
    vi.useFakeTimers()
    try {
      const { controller, adapter } = createController()
      adapter.cursor = { x: -1200, y: 60 }
      expect(controller.beginResize('right')).toBe(true)

      for (const x of [-1180, -1140, -1100]) {
        adapter.cursor = { x, y: 60 }
        expect(controller.requestResizeUpdate()).toBe(true)
      }
      expect(adapter.setBoundsCalls).toEqual([{ x: -1200, y: 60, width: 694, height: 784 }])
      expect(controller.getSnapshot().resizeUpdatePending).toBe(true)

      await vi.advanceTimersByTimeAsync(16)
      expect(adapter.setBoundsCalls.at(-1)).toEqual({ x: -1200, y: 60, width: 774, height: 784 })

      adapter.cursor = { x: -1060, y: 60 }
      controller.requestResizeUpdate()
      expect(controller.endResize()).toBe(true)
      expect(adapter.setBoundsCalls.at(-1)).toEqual({ x: -1200, y: 60, width: 814, height: 784 })
      expect(controller.getSnapshot().resizeUpdatePending).toBe(false)

      await vi.advanceTimersByTimeAsync(32)
      expect(adapter.setBoundsCalls).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels queued resize work when the controller is disposed', async () => {
    vi.useFakeTimers()
    try {
      const { controller, adapter } = createController()
      expect(controller.beginResize('bottom')).toBe(true)
      adapter.cursor = { x: -1200, y: 160 }
      controller.requestResizeUpdate()
      adapter.cursor = { x: -1200, y: 260 }
      controller.requestResizeUpdate()
      expect(controller.getSnapshot().resizeUpdatePending).toBe(true)
      const appliedBeforeDispose = adapter.setBoundsCalls.length
      controller.dispose()

      await vi.advanceTimersByTimeAsync(32)
      expect(adapter.setBoundsCalls).toHaveLength(appliedBeforeDispose)
      expect(controller.getSnapshot()).toMatchObject({ resizeSession: null, resizeUpdatePending: false, disposed: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('enforces transparent outer minimums while keeping the opposite edge fixed', () => {
    const { controller, adapter } = createController()
    const fixedRight = adapter.bounds.x + adapter.bounds.width
    const fixedBottom = adapter.bounds.y + adapter.bounds.height
    adapter.cursor = { x: adapter.bounds.x, y: adapter.bounds.y }
    expect(controller.beginResize('top-left')).toBe(true)

    adapter.cursor = { x: 2000, y: 2000 }
    expect(controller.updateResize()).toBe(true)
    expect(adapter.bounds).toEqual({
      x: fixedRight - 584,
      y: fixedBottom - 664,
      width: 584,
      height: 664
    })
    expect(adapter.bounds.x + adapter.bounds.width).toBe(fixedRight)
    expect(adapter.bounds.y + adapter.bounds.height).toBe(fixedBottom)
  })

  it('reduces the custom-resize minimum to a smaller current work area', () => {
    const { controller, adapter } = createController()
    adapter.workAreas = [{ x: -1200, y: 60, width: 500, height: 600 }]
    adapter.cursor = { x: adapter.bounds.x, y: adapter.bounds.y }
    expect(controller.beginResize('top-left')).toBe(true)

    adapter.cursor = { x: 2000, y: 2000 }
    expect(controller.updateResize()).toBe(true)
    expect(adapter.bounds).toEqual({ x: -1026, y: 244, width: 500, height: 600 })
    expect(adapter.minimumSizeCalls.at(-1)).toEqual({ width: 500, height: 600 })
  })

  it('rejects custom resize in solid mode and while application-maximized', () => {
    expect(createController('solid').controller.beginResize('left')).toBe(false)

    const { controller } = createController()
    controller.toggleMaximize()
    expect(controller.beginResize('left')).toBe(false)
  })

  it('validates resize edges against the closed union', () => {
    for (const edge of WINDOW_RESIZE_EDGES) expect(isWindowResizeEdge(edge)).toBe(true)
    expect(isWindowResizeEdge('top-middle')).toBe(false)
    expect(isWindowResizeEdge({ edge: 'left' })).toBe(false)
  })
})

describe('window chrome sender registry', () => {
  it('requires a registered sender main frame and cleans up registry entries', () => {
    const registry = new WindowChromeRegistry()
    const adapter = new FakeWindowAdapter(501, 51)
    const { controller } = createController('solid', {}, adapter)
    const unregister = registry.register(controller)
    const mainFrame = {}

    expect(
      resolveWindowChromeController({ sender: { id: 501, mainFrame }, senderFrame: mainFrame }, registry)
    ).toBe(controller)
    expect(() =>
      resolveWindowChromeController({ sender: { id: 501, mainFrame }, senderFrame: {} }, registry)
    ).toThrow(/main frame/)

    unregister()
    unregister()
    expect(registry.size).toBe(0)
    expect(() =>
      resolveWindowChromeController({ sender: { id: 501, mainFrame }, senderFrame: mainFrame }, registry)
    ).toThrow(/unavailable/)
  })

  it('rejects unregistered capture-overlay and unknown senders', () => {
    const registry = new WindowChromeRegistry()
    const registeredAdapter = new FakeWindowAdapter(601, 61)
    registry.register(createController('solid', {}, registeredAdapter).controller)

    for (const id of [602, 999]) {
      const mainFrame = {}
      expect(() =>
        resolveWindowChromeController({ sender: { id, mainFrame }, senderFrame: mainFrame }, registry)
      ).toThrow(/unavailable/)
    }
  })
})
