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
      send(channel: string, ...arguments_: unknown[]): void
      setWindowOpenHandler(): void
    }
    bounds: { x: number; y: number; width: number; height: number }
    destroyed = false
    showCalls = 0
    focusCalls = 0
    minimizeCalls = 0
    maximizeCalls = 0
    unmaximizeCalls = 0
    movable = true
    readonly sent: Array<[string, ...unknown[]]> = []

    constructor(options: Record<string, any>) {
      super()
      this.options = options
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      const contents = new FakeEmitter() as FakeWindow['webContents']
      contents.id = this.id + 100
      contents.isDestroyed = () => this.destroyed
      contents.send = (channel, ...arguments_) => this.sent.push([channel, ...arguments_])
      contents.setWindowOpenHandler = () => undefined
      this.webContents = contents
    }

    getBounds(): typeof this.bounds {
      return { ...this.bounds }
    }

    setBounds(bounds: typeof this.bounds): void {
      this.bounds = { ...bounds }
    }

    setMinimumSize(): void {}

    setMovable(movable: boolean): void {
      this.movable = movable
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
    cursor: { x: number; y: number }
    workArea: { x: number; y: number; width: number; height: number }
    getCursorScreenPoint(): { x: number; y: number }
    getDisplayMatching(): { workArea: { x: number; y: number; width: number; height: number } }
    getAllDisplays(): Array<{ workArea: { x: number; y: number; width: number; height: number } }>
  }
  screen.cursor = { x: -1200, y: 0 }
  screen.workArea = { x: -1600, y: -120, width: 1600, height: 900 }
  screen.getCursorScreenPoint = () => ({ ...screen.cursor })
  screen.getDisplayMatching = () => ({ workArea: { ...screen.workArea } })
  screen.getAllDisplays = () => [{ workArea: { ...screen.workArea } }]

  const windows: FakeWindow[] = []
  const secureWindow = vi.fn((options: Record<string, any>) => {
    const window = new FakeWindow(options)
    windows.push(window)
    return window
  })
  const loadRenderer = vi.fn<
    (window: unknown, page: string, query?: Record<string, string>) => Promise<void>
  >()
  loadRenderer.mockResolvedValue(undefined)
  const hasSwitch = vi.fn(() => false)
  const deleteScreenshot = vi.fn(async () => undefined)
  const deleteConversation = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  let nextConversation = 1
  const createConversation = vi.fn(async () => `conversation-${nextConversation++}`)
  const sendMessage = vi.fn(() => (async function* () {
    yield { type: 'started' as const }
    yield { type: 'delta' as const, text: 'answer' }
    yield { type: 'completed' as const }
  })())
  const startNewCapture = vi.fn(async () => undefined)

  return {
    FakeWindow,
    cancel,
    createConversation,
    deleteConversation,
    deleteScreenshot,
    hasSwitch,
    loadRenderer,
    provider: { cancel, createConversation, deleteConversation, sendMessage },
    reset: () => {
      windows.length = 0
      nextWindowId = 1
      nextConversation = 1
      secureWindow.mockClear()
      loadRenderer.mockReset()
      loadRenderer.mockResolvedValue(undefined)
      hasSwitch.mockReset()
      hasSwitch.mockReturnValue(false)
      deleteScreenshot.mockClear()
      deleteConversation.mockClear()
      cancel.mockClear()
      createConversation.mockClear()
      sendMessage.mockClear()
      startNewCapture.mockClear()
      screen.cursor = { x: -1200, y: 0 }
      screen.workArea = { x: -1600, y: -120, width: 1600, height: 900 }
      screen.removeAllListeners()
    },
    screen,
    secureWindow,
    sendMessage,
    startNewCapture,
    windows
  }
})

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: mocks.hasSwitch } },
  BrowserWindow: mocks.FakeWindow,
  nativeImage: {
    createFromPath: () => ({
      getSize: () => ({ width: 800, height: 600 }),
      resize: () => ({ toDataURL: () => 'data:image/png;base64,thumbnail' })
    })
  },
  screen: mocks.screen
}))

vi.mock('../src/main/windows/window-factory', () => ({
  loadRenderer: mocks.loadRenderer,
  secureWindow: mocks.secureWindow
}))

function capture(selectedX = 150): any {
  return {
    imagePath: `C:\\temp\\capture-${selectedX}.png`,
    selectedBounds: { x: selectedX, y: 80, width: 300, height: 240 },
    display: {
      bounds: { x: -1600, y: -120, width: 1600, height: 900 },
      workArea: { x: -1600, y: -120, width: 1600, height: 900 }
    }
  }
}

async function createSessions(): Promise<any> {
  const { QuestionSessions } = await import('../src/main/windows/question-sessions')
  return new QuestionSessions(
    mocks.provider as any,
    { delete: mocks.deleteScreenshot } as any,
    mocks.startNewCapture
  )
}

async function finishOpening(opening: Promise<void>, index: number): Promise<string> {
  const window = mocks.windows[index]!
  const { windowChromeRegistry } = await import('../src/main/windows/window-chrome')
  window.emit('ready-to-show')
  windowChromeRegistry.get(window.webContents.id)!.markRendererReady()
  await opening
  const query = mocks.loadRenderer.mock.calls[index]![2]! as { session: string }
  return query.session
}

describe('question-session window migration', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const window of mocks.windows) window.destroy()
  })

  it('uses transparent outer dimensions and selection-adjacent placement', async () => {
    const sessions = await createSessions()
    const opening = sessions.open(capture())
    const window = mocks.windows[0]!

    expect(window.options).toMatchObject({
      x: -1138,
      y: -40,
      width: 504,
      height: 664,
      minWidth: 424,
      minHeight: 504,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      useContentSize: true,
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      closable: true,
      movable: true,
      fullscreenable: false,
      thickFrame: false,
      roundedCorners: false,
      alwaysOnTop: true,
      skipTaskbar: false
    })

    const sessionId = await finishOpening(opening, 0)
    expect(window.showCalls).toBe(1)
    expect(window.focusCalls).toBe(1)
    expect(sessions.get(sessionId)).toMatchObject({ sessionId, busy: false })
  })

  it('keeps simultaneous sessions and their chrome state independent', async () => {
    const sessions = await createSessions()
    const firstOpening = sessions.open(capture(150))
    const firstId = await finishOpening(firstOpening, 0)
    const secondOpening = sessions.open(capture(900))
    const secondId = await finishOpening(secondOpening, 1)
    const [first, second] = mocks.windows
    const { windowChromeRegistry } = await import('../src/main/windows/window-chrome')
    const firstChrome = windowChromeRegistry.get(first!.webContents.id)!
    const secondChrome = windowChromeRegistry.get(second!.webContents.id)!

    first!.emit('focus')
    expect(firstChrome.getState().focused).toBe(true)
    expect(secondChrome.getState().focused).toBe(false)
    first!.emit('blur')
    second!.emit('focus')
    expect(firstChrome.getState().focused).toBe(false)
    expect(secondChrome.getState().focused).toBe(true)

    firstChrome.toggleMaximize()
    expect(firstChrome.getState().maximized).toBe(true)
    expect(secondChrome.getState().maximized).toBe(false)
    expect(first!.movable).toBe(false)

    mocks.screen.cursor = { x: second!.bounds.x, y: second!.bounds.y }
    expect(secondChrome.beginResize('bottom-right')).toBe(true)
    expect(firstChrome.getSnapshot().resizeSession).toBeNull()
    expect(secondChrome.getSnapshot().resizeSession).not.toBeNull()
    secondChrome.endResize()

    firstChrome.closeWindow()
    await vi.waitFor(() => expect(mocks.deleteScreenshot).toHaveBeenCalledTimes(1))
    expect(() => sessions.get(firstId)).toThrow(/already closed/)
    expect(sessions.get(secondId).sessionId).toBe(secondId)
    expect(windowChromeRegistry.get(first!.webContents.id)).toBeNull()
    expect(windowChromeRegistry.get(second!.webContents.id)).toBe(secondChrome)
  })

  it('replaces one timed-out transparent attempt with one solid attempt without cleaning the session', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const sessions = await createSessions()
    const { QUESTION_WINDOW_READY_TIMEOUT_MS } = await import('../src/main/windows/question-sessions')
    const opening = sessions.open(capture())

    await vi.advanceTimersByTimeAsync(QUESTION_WINDOW_READY_TIMEOUT_MS)
    expect(mocks.windows).toHaveLength(2)
    expect(mocks.windows[0]!.destroyed).toBe(true)
    expect(mocks.windows[1]!.options).toMatchObject({
      width: 480,
      height: 640,
      minWidth: 400,
      minHeight: 480,
      transparent: false,
      backgroundColor: '#090b10',
      hasShadow: true,
      resizable: true,
      maximizable: true,
      thickFrame: true
    })
    expect(mocks.deleteScreenshot).not.toHaveBeenCalled()
    expect(mocks.loadRenderer.mock.calls[0]![2]).toEqual(mocks.loadRenderer.mock.calls[1]![2])

    const sessionId = await finishOpening(opening, 1)
    expect(sessions.get(sessionId).sessionId).toBe(sessionId)
    expect(mocks.windows[1]!.showCalls).toBe(1)
  })

  it('preserves provider events and cleans up after generic title-bar close', async () => {
    const sessions = await createSessions()
    const opening = sessions.open(capture())
    const sessionId = await finishOpening(opening, 0)
    const window = mocks.windows[0]!

    await sessions.send(sessionId, 'Explain this')
    expect(mocks.createConversation).toHaveBeenCalledTimes(1)
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(window.sent.filter(([channel]) => channel === 'question:event')).toHaveLength(3)
    await sessions.stop(sessionId)
    expect(mocks.cancel).toHaveBeenCalledWith('conversation-1')

    const { windowChromeRegistry } = await import('../src/main/windows/window-chrome')
    windowChromeRegistry.get(window.webContents.id)!.closeWindow()
    await vi.waitFor(() => expect(mocks.deleteScreenshot).toHaveBeenCalledWith(capture().imagePath))
    await vi.waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledWith('conversation-1'))
    expect(() => sessions.get(sessionId)).toThrow(/already closed/)
  })

  it('keeps New snip session-scoped and starts a fresh capture after cleanup', async () => {
    const sessions = await createSessions()
    const opening = sessions.open(capture())
    const sessionId = await finishOpening(opening, 0)

    await sessions.newSnip(sessionId)
    await vi.waitFor(() => expect(mocks.deleteScreenshot).toHaveBeenCalledTimes(1))
    expect(mocks.startNewCapture).toHaveBeenCalledTimes(1)
    expect(() => sessions.get(sessionId)).toThrow(/already closed/)
  })
})
