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
    focusCalls = 0

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
    }

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

    focus(): void {
      this.focusCalls += 1
    }
  }

  const screen = new FakeEmitter() as FakeEmitter & {
    getPrimaryDisplay(): { workArea: { x: number; y: number; width: number; height: number } }
    getCursorScreenPoint(): { x: number; y: number }
    getDisplayMatching(): { workArea: { x: number; y: number; width: number; height: number } }
    getAllDisplays(): Array<{ workArea: { x: number; y: number; width: number; height: number } }>
  }
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
  screen.getPrimaryDisplay = () => ({ workArea: { ...workArea } })
  screen.getCursorScreenPoint = () => ({ x: 0, y: 0 })
  screen.getDisplayMatching = () => ({ workArea: { ...workArea } })
  screen.getAllDisplays = () => [{ workArea: { ...workArea } }]

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
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { SETTINGS_WINDOW_READY_TIMEOUT_MS, showSettingsWindow } = await import(
      '../src/main/windows/settings-window'
    )
    const opening = showSettingsWindow()

    expect(mocks.windows).toHaveLength(1)
    expect(mocks.windows[0]!.options).toMatchObject({ transparent: true, resizable: false })
    await vi.advanceTimersByTimeAsync(SETTINGS_WINDOW_READY_TIMEOUT_MS)
    expect(mocks.windows).toHaveLength(2)
    expect(mocks.windows[0]!.destroyed).toBe(true)

    const solid = mocks.windows[1]!
    expect(solid.options).toMatchObject({ transparent: false, resizable: true, maximizable: true })
    const { windowChromeRegistry } = await import('../src/main/windows/window-chrome')
    solid.emit('ready-to-show')
    windowChromeRegistry.get(solid.webContents.id)!.markRendererReady()
    await expect(opening).resolves.toBe(solid)

    await vi.advanceTimersByTimeAsync(SETTINGS_WINDOW_READY_TIMEOUT_MS * 2)
    expect(mocks.windows).toHaveLength(2)
    expect(solid.showCalls).toBe(1)
  })
})
