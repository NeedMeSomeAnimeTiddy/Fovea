import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Listener = (...arguments_: any[]) => void

  class FakeEmitter {
    private readonly listeners = new Map<string, Set<Listener>>()

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set<Listener>()
      listeners.add(listener)
      this.listeners.set(event, listeners)
      return this
    }

    once(event: string, listener: Listener): this {
      const onceListener: Listener = (...arguments_) => {
        this.off(event, onceListener)
        listener(...arguments_)
      }
      return this.on(event, onceListener)
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener)
      return this
    }

    emit(event: string, ...arguments_: any[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...arguments_)
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.size ?? 0
    }

    removeAllListeners(): void {
      this.listeners.clear()
    }
  }

  let nextWindowId = 1
  class FakeWindow extends FakeEmitter {
    readonly id = nextWindowId++
    readonly options: Record<string, any>
    readonly webContents: FakeEmitter & {
      id: number
      isDestroyed(): boolean
      send(): void
      setWindowOpenHandler(): void
    }
    bounds: { x: number; y: number; width: number; height: number }
    destroyed = false
    showCalls = 0
    hideCalls = 0
    focusCalls = 0
    readonly setBoundsCalls: Array<{ x: number; y: number; width: number; height: number }> = []

    constructor(options: Record<string, any>) {
      super()
      this.options = options
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height }
      const contents = new FakeEmitter() as FakeWindow['webContents']
      contents.id = this.id + 100
      contents.isDestroyed = () => this.destroyed
      contents.send = () => undefined
      contents.setWindowOpenHandler = () => undefined
      this.webContents = contents
    }

    getBounds(): typeof this.bounds {
      return { ...this.bounds }
    }

    setBounds(bounds: typeof this.bounds): void {
      this.bounds = { ...bounds }
      this.setBoundsCalls.push({ ...bounds })
    }

    setMinimumSize(): void {}
    setMovable(): void {}
    minimize(): void {}
    maximize(): void {}
    unmaximize(): void {}

    close(): void {
      this.destroy()
    }

    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.webContents.emit('destroyed')
      this.emit('closed')
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    show(): void {
      this.showCalls += 1
    }

    hide(): void {
      this.hideCalls += 1
    }

    focus(): void {
      this.focusCalls += 1
    }
  }

  const screen = new FakeEmitter() as FakeEmitter & {
    workArea: { x: number; y: number; width: number; height: number }
    getPrimaryDisplay(): { workArea: { x: number; y: number; width: number; height: number } }
    getCursorScreenPoint(): { x: number; y: number }
    getDisplayMatching(): { workArea: { x: number; y: number; width: number; height: number } }
    getAllDisplays(): Array<{ workArea: { x: number; y: number; width: number; height: number } }>
  }
  screen.workArea = { x: 0, y: 0, width: 1920, height: 1040 }
  screen.getPrimaryDisplay = () => ({ workArea: { ...screen.workArea } })
  screen.getCursorScreenPoint = () => ({ x: 0, y: 0 })
  screen.getDisplayMatching = () => ({ workArea: { ...screen.workArea } })
  screen.getAllDisplays = () => [{ workArea: { ...screen.workArea } }]

  const windows: FakeWindow[] = []
  const secureWindow = vi.fn((options: Record<string, any>) => {
    const window = new FakeWindow(options)
    windows.push(window)
    return window
  })
  const loadRenderer = vi.fn(async () => undefined)
  const hasSwitch = vi.fn(() => false)

  return {
    FakeWindow,
    hasSwitch,
    loadRenderer,
    reset: () => {
      windows.length = 0
      nextWindowId = 1
      secureWindow.mockClear()
      loadRenderer.mockClear()
      hasSwitch.mockReset()
      hasSwitch.mockReturnValue(false)
      screen.workArea = { x: 0, y: 0, width: 1920, height: 1040 }
      screen.removeAllListeners()
    },
    screen,
    secureWindow,
    windows
  }
})

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: mocks.hasSwitch } },
  screen: mocks.screen
}))

vi.mock('../src/main/windows/window-factory', () => ({
  loadRenderer: mocks.loadRenderer,
  secureWindow: mocks.secureWindow
}))

describe('Settings window startup lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const window of mocks.windows) window.destroy()
  })

  it('stays hidden until both ready-to-show and renderer readiness arrive', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { showSettingsWindow } = await import('../src/main/windows/settings-window')
    const { windowChromeRegistry } = await import('../src/main/windows/window-chrome')
    const opening = showSettingsWindow()
    const window = mocks.windows[0]!

    window.emit('ready-to-show')
    await Promise.resolve()
    expect(window.showCalls).toBe(0)

    windowChromeRegistry.get(window.webContents.id)!.markRendererReady()
    await expect(opening).resolves.toBe(window)
    expect(window.showCalls).toBe(1)
  })

  it('destroys a timed-out transparent attempt and retries once in solid mode', async () => {
    vi.useFakeTimers()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { SETTINGS_WINDOW_READY_TIMEOUT_MS, showSettingsWindow } = await import(
      '../src/main/windows/settings-window'
    )
    const opening = showSettingsWindow()

    expect(mocks.windows).toHaveLength(1)
    expect(mocks.windows[0]!.options).toMatchObject({ transparent: true, resizable: false })
    await vi.advanceTimersByTimeAsync(SETTINGS_WINDOW_READY_TIMEOUT_MS)
    expect(mocks.windows).toHaveLength(2)
    expect(mocks.windows[0]!.destroyed).toBe(true)
    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(
        /Settings readiness timed out \(kind=settings, attempt=1, material=transparent, window=1, web-contents=101, elapsed=10000ms, ready-to-show=false, renderer-ready=false, current=true, destroyed=false\)/
      )
    )
    expect(warn).toHaveBeenNthCalledWith(
      2,
      '[window] Settings retrying once in solid mode after transparent readiness timeout.'
    )

    const solid = mocks.windows[1]!
    expect(solid.options).toMatchObject({ transparent: false, resizable: false, maximizable: false, minimizable: false, thickFrame: false })
    const { windowChromeRegistry } = await import('../src/main/windows/window-chrome')
    solid.emit('ready-to-show')
    windowChromeRegistry.get(solid.webContents.id)!.markRendererReady()
    await expect(opening).resolves.toBe(solid)
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/Settings solid mode ready \(kind=settings, attempt=2, fallback=true/))

    await vi.advanceTimersByTimeAsync(SETTINGS_WINDOW_READY_TIMEOUT_MS * 2)
    expect(mocks.windows).toHaveLength(2)
    expect(solid.showCalls).toBe(1)
  })

  it('uses compact fixed geometry and hides to the tray when focus moves away', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { showSettingsWindow } = await import('../src/main/windows/settings-window')
    const opening = showSettingsWindow()
    const window = mocks.windows[0]!
    const { windowChromeRegistry } = await import('../src/main/windows/window-chrome')
    expect(window.options).toMatchObject({
      width: 624,
      height: 664,
      minWidth: 624,
      minHeight: 664,
      resizable: false,
      maximizable: false,
      minimizable: false,
      thickFrame: false,
      skipTaskbar: true
    })
    window.emit('ready-to-show')
    const controller = windowChromeRegistry.get(window.webContents.id)!
    controller.markRendererReady()
    await opening
    expect(controller.getState()).toMatchObject({ canMinimize: false, canMaximize: false, canResize: false })

    window.emit('blur')
    expect(window.hideCalls).toBe(1)
    expect(window.destroyed).toBe(false)

    await expect(showSettingsWindow()).resolves.toBe(window)
    expect(window.showCalls).toBe(2)
    expect(window.focusCalls).toBe(1)
  })

  it('does not retry a readiness timeout when solid mode was selected explicitly', async () => {
    vi.useFakeTimers()
    mocks.hasSwitch.mockReturnValue(true)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { SETTINGS_WINDOW_READY_TIMEOUT_MS, showSettingsWindow } = await import(
      '../src/main/windows/settings-window'
    )
    const opening = showSettingsWindow()
    const rejection = expect(opening).rejects.toThrow(
      /Settings readiness timed out in solid mode \(ready-to-show=false, renderer-ready=false\)/
    )

    await vi.advanceTimersByTimeAsync(SETTINGS_WINDOW_READY_TIMEOUT_MS)
    await rejection
    expect(mocks.windows).toHaveLength(1)
    expect(mocks.windows[0]!.options).toMatchObject({ transparent: false, resizable: false, maximizable: false })
    expect(mocks.windows[0]!.destroyed).toBe(true)
  })
})
