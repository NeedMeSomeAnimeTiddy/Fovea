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
  const deleteConversation = vi.fn(async (conversationId?: string) => { void conversationId })
  const cancel = vi.fn(async (conversationId?: string) => { void conversationId })
  let nextConversation = 1
  const createConversation = vi.fn(async (selection?: unknown) => { void selection; return `conversation-${nextConversation++}` })
  const sendMessage = vi.fn((conversationId?: string, input?: unknown) => { void conversationId; void input; return (async function* () {
    yield { type: 'started' as const }
    yield { type: 'delta' as const, text: 'answer' }
    yield { type: 'completed' as const }
  })() })
  const listModels = vi.fn(async () => [{ id: 'vision-1', displayName: 'Vision', provider: 'chatgpt', inputModalities: ['text', 'image'], supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low', isDefault: true }])
  const startNewCapture = vi.fn(async () => undefined)

  return {
    FakeWindow,
    cancel,
    createConversation,
    deleteConversation,
    deleteScreenshot,
    hasSwitch,
    listModels,
    loadRenderer,
    provider: {
      listProfiles: () => [{ id: 'profile-1', name: 'ChatGPT', provider: 'chatgpt', authentication: 'chatgpt-oauth', authenticationState: 'signed-in', defaultModelId: 'vision-1', defaultReasoningEffort: 'low', health: 'available', isDefault: true }],
      listModels,
      validateSelection: async () => undefined,
      createConversation,
      send: (conversationId: string, _selection: unknown, input: unknown) => sendMessage(conversationId, input),
      cancel: (conversationId: string) => cancel(conversationId),
      deleteConversation: (conversationId: string) => deleteConversation(conversationId)
    },
    reset: () => {
      windows.length = 0
      nextWindowId = 1
      nextConversation = 1
      secureWindow.mockClear()
      loadRenderer.mockReset()
      loadRenderer.mockResolvedValue(undefined)
      listModels.mockReset()
      listModels.mockResolvedValue([{ id: 'vision-1', displayName: 'Vision', provider: 'chatgpt', inputModalities: ['text', 'image'], supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low', isDefault: true }])
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
    await expect(sessions.get(sessionId)).resolves.toMatchObject({ sessionId, busy: false })
  })

  it('starts renderer navigation before initial model discovery completes', async () => {
    let resolveModels!: (models: any[]) => void
    mocks.listModels.mockImplementationOnce(() => new Promise((resolve) => { resolveModels = resolve }))
    const sessions = await createSessions()
    const opening = sessions.open(capture())

    expect(mocks.loadRenderer).toHaveBeenCalledTimes(1)
    const sessionId = mocks.loadRenderer.mock.calls[0]![2]!.session
    const window = mocks.windows[0]!
    window.emit('ready-to-show')
    const { windowChromeRegistry } = await import('../src/main/windows/window-chrome')
    windowChromeRegistry.get(window.webContents.id)!.markRendererReady()
    await opening
    expect(window.showCalls).toBe(1)

    resolveModels([{ id: 'vision-1', displayName: 'Vision', provider: 'chatgpt', inputModalities: ['text', 'image'], supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low', isDefault: true }])
    await expect(sessions.get(sessionId)).resolves.toMatchObject({ sessionId, selection: { modelId: 'vision-1' } })
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
    await expect(sessions.get(firstId)).rejects.toThrow(/already closed/)
    await expect(sessions.get(secondId)).resolves.toMatchObject({ sessionId: secondId })
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
      backgroundColor: '#f3f6fa',
      hasShadow: true,
      resizable: true,
      maximizable: true,
      thickFrame: true
    })
    expect(mocks.deleteScreenshot).not.toHaveBeenCalled()
    expect(mocks.loadRenderer.mock.calls[0]![2]).toEqual(mocks.loadRenderer.mock.calls[1]![2])

    const sessionId = await finishOpening(opening, 1)
    await expect(sessions.get(sessionId)).resolves.toMatchObject({ sessionId })
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
    await expect(sessions.get(sessionId)).rejects.toThrow(/already closed/)
  })

  it('holds an uncertain answer for explicit web-search approval and can decline locally', async () => {
    mocks.sendMessage.mockImplementationOnce(() => (async function* () {
      yield { type: 'started' as const }
      yield { type: 'delta' as const, text: '<fovea-web-' }
      yield { type: 'delta' as const, text: 'search-request>{"query":"latest object details"}</fovea-web-search-request>' }
      yield { type: 'completed' as const }
    })())
    const sessions = await createSessions()
    const opening = sessions.open(capture())
    const sessionId = await finishOpening(opening, 0)

    await sessions.send(sessionId, 'What is this?')
    const pending = await sessions.get(sessionId)
    expect(pending).toMatchObject({ busy: false, phase: 'awaiting-approval' })
    expect(pending.exchanges[0]).toMatchObject({ answer: '', webSearch: { query: 'latest object details', status: 'requested' } })
    const providerEvents = mocks.windows[0]!.sent.filter(([channel]) => channel === 'question:event').map(([, , event]) => event)
    expect(providerEvents).toEqual([
      expect.objectContaining({ type: 'started' }),
      expect.objectContaining({ type: 'web-search-requested', query: 'latest object details' })
    ])

    const requestId = pending.exchanges[0]!.webSearch!.id
    const declined = await sessions.resolveWebSearch(sessionId, requestId, false)
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(declined.exchanges[0]).toMatchObject({ phase: 'completed', webSearch: { status: 'declined' } })
  })

  it('retries an approved search with explicit network permission and the screenshot', async () => {
    mocks.sendMessage.mockImplementationOnce(() => (async function* () {
      yield { type: 'started' as const }
      yield { type: 'delta' as const, text: '<fovea-web-search-request>{"query":"identify unfamiliar device"}</fovea-web-search-request>' }
      yield { type: 'completed' as const }
    })())
    mocks.sendMessage.mockImplementationOnce(() => (async function* () {
      yield { type: 'started' as const }
      yield { type: 'delta' as const, text: 'Verified answer with a source.' }
      yield { type: 'completed' as const }
    })())
    const sessions = await createSessions()
    const opening = sessions.open(capture())
    const sessionId = await finishOpening(opening, 0)

    await sessions.send(sessionId, 'What is this?')
    const pending = await sessions.get(sessionId)
    const approved = await sessions.resolveWebSearch(sessionId, pending.exchanges[0]!.webSearch!.id, true)

    expect(mocks.sendMessage).toHaveBeenCalledTimes(2)
    expect(mocks.sendMessage.mock.calls[1]?.[1]).toMatchObject({
      text: expect.stringMatching(/^\[FOVEA_WEB_SEARCH_APPROVED\]/),
      imagePath: capture().imagePath,
      webSearchAllowed: true
    })
    expect(approved).toMatchObject({ busy: false, phase: 'completed' })
    expect(approved.exchanges[0]).toMatchObject({ answer: 'Verified answer with a source.', webSearch: { status: 'completed' } })
  })

  it('keeps New snip session-scoped and starts a fresh capture after cleanup', async () => {
    const sessions = await createSessions()
    const opening = sessions.open(capture())
    const sessionId = await finishOpening(opening, 0)

    await sessions.newSnip(sessionId)
    await vi.waitFor(() => expect(mocks.deleteScreenshot).toHaveBeenCalledTimes(1))
    expect(mocks.startNewCapture).toHaveBeenCalledTimes(1)
    await expect(sessions.get(sessionId)).rejects.toThrow(/already closed/)
  })
})
