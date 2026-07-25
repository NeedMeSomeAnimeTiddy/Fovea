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
    alwaysOnTop: boolean
    readonly sent: Array<[string, ...unknown[]]> = []

    constructor(options: Record<string, any>) {
      super()
      this.options = options
      this.alwaysOnTop = Boolean(options.alwaysOnTop)
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

    setAlwaysOnTop(alwaysOnTop: boolean): void {
      this.alwaysOnTop = alwaysOnTop
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
    getDisplayMatching(): { bounds: { x: number; y: number; width: number; height: number }; workArea: { x: number; y: number; width: number; height: number } }
    getAllDisplays(): Array<{ workArea: { x: number; y: number; width: number; height: number } }>
  }
  screen.cursor = { x: -1200, y: 0 }
  screen.workArea = { x: -1600, y: -120, width: 1600, height: 900 }
  screen.getCursorScreenPoint = () => ({ ...screen.cursor })
  screen.getDisplayMatching = () => ({ bounds: { ...screen.workArea }, workArea: { ...screen.workArea } })
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
  const sendMessage = vi.fn((conversationId?: string, input?: unknown): AsyncIterable<{ type: string; [key: string]: unknown }> => { void conversationId; void input; return (async function* () {
    yield { type: 'started' as const }
    yield { type: 'delta' as const, text: 'answer' }
    yield { type: 'completed' as const }
  })() })
  const listModels = vi.fn(async () => [{ id: 'vision-1', displayName: 'Vision', provider: 'chatgpt', inputModalities: ['text', 'image'], supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low', isDefault: true }])
  const startNewCapture = vi.fn(async () => undefined)
  const readImage = vi.fn(async () => Buffer.from('original-png-bytes'))

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
    readImage,
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
      readImage.mockClear()
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
    mocks.startNewCapture,
    mocks.readImage
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
      alwaysOnTop: false,
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
    expect(firstChrome.getState()).toMatchObject({ maximized: false, canMaximize: false, canResize: false })
    expect(secondChrome.getState().maximized).toBe(false)
    expect(first!.movable).toBe(true)

    mocks.screen.cursor = { x: second!.bounds.x, y: second!.bounds.y }
    expect(secondChrome.beginResize('bottom-right')).toBe(false)
    expect(firstChrome.getSnapshot().resizeSession).toBeNull()
    expect(secondChrome.getSnapshot().resizeSession).toBeNull()
    secondChrome.endResize()

    firstChrome.closeWindow()
    await vi.waitFor(() => expect(mocks.deleteScreenshot).toHaveBeenCalledTimes(1))
    await expect(sessions.get(firstId)).rejects.toThrow(/already closed/)
    await expect(sessions.get(secondId)).resolves.toMatchObject({ sessionId: secondId })
    expect(windowChromeRegistry.get(first!.webContents.id)).toBeNull()
    expect(windowChromeRegistry.get(second!.webContents.id)).toBe(secondChrome)
  })

  it('pins only the requested question window and exposes the state to its renderer', async () => {
    const sessions = await createSessions()
    const firstOpening = sessions.open(capture(150))
    const firstId = await finishOpening(firstOpening, 0)
    const secondOpening = sessions.open(capture(900))
    const secondId = await finishOpening(secondOpening, 1)
    const [first, second] = mocks.windows

    expect(first!.alwaysOnTop).toBe(false)
    expect(second!.alwaysOnTop).toBe(false)
    await expect(sessions.setPinned(firstId, true)).resolves.toBeUndefined()
    expect(first!.alwaysOnTop).toBe(true)
    expect(second!.alwaysOnTop).toBe(false)
    await expect(sessions.get(firstId)).resolves.toMatchObject({ pinned: true })
    await expect(sessions.get(secondId)).resolves.toMatchObject({ pinned: false })

    await expect(sessions.setPinned(firstId, false)).resolves.toBeUndefined()
    expect(first!.alwaysOnTop).toBe(false)
  })

  it('opens the original PNG in an isolated borderless monitor preview', async () => {
    const sessions = await createSessions()
    const firstOpening = sessions.open(capture(150))
    const firstId = await finishOpening(firstOpening, 0)
    const secondOpening = sessions.open(capture(900))
    await finishOpening(secondOpening, 1)
    const [first, second] = mocks.windows
    const originalBounds = first!.getBounds()

    await expect(sessions.getFullImage(firstId)).resolves.toBe(`data:image/png;base64,${Buffer.from('original-png-bytes').toString('base64')}`)
    expect(mocks.readImage).toHaveBeenCalledWith(capture(150).imagePath)
    await sessions.setPreviewOpen(firstId, true)
    expect(mocks.windows).toHaveLength(3)
    const preview = mocks.windows[2]!
    expect(preview.options).toMatchObject({
      x: -1600,
      y: -120,
      width: 1600,
      height: 900,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      fullscreen: true,
      fullscreenable: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true
    })
    expect(mocks.loadRenderer).toHaveBeenLastCalledWith(preview, 'preview', { session: firstId })
    expect(preview.showCalls).toBe(0)
    preview.emit('ready-to-show')
    expect(preview.showCalls).toBe(1)
    expect(preview.focusCalls).toBe(1)
    expect(first!.getBounds()).toEqual(originalBounds)
    expect(second!.destroyed).toBe(false)

    await sessions.setPreviewOpen(firstId, true)
    expect(mocks.windows).toHaveLength(3)
    expect(preview.focusCalls).toBe(2)

    await sessions.setPreviewOpen(firstId, false)
    expect(preview.destroyed).toBe(true)
    expect(first!.getBounds()).toEqual(originalBounds)

    await sessions.setPreviewOpen(firstId, true)
    const replacementPreview = mocks.windows[3]!
    expect(replacementPreview.destroyed).toBe(false)
    await sessions.close(firstId)
    expect(replacementPreview.destroyed).toBe(true)
    expect(second!.destroyed).toBe(false)
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
      resizable: false,
      maximizable: false,
      thickFrame: false
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

  it('regenerates a failed response in an auditable fresh context and cleans up both conversations', async () => {
    mocks.sendMessage.mockImplementationOnce(() => (async function* () {
      yield { type: 'started' as const, turnId: 'failed-turn' }
      yield { type: 'error' as const, error: { code: 'offline' as const, title: 'Offline', message: 'Connection lost.', recovery: 'retry' as const } }
    })())
    const sessions = await createSessions()
    const opening = sessions.open(capture())
    const sessionId = await finishOpening(opening, 0)

    await sessions.send(sessionId, 'Explain this')
    const failed = await sessions.get(sessionId)
    expect(failed).toMatchObject({ busy: false, phase: 'failed' })
    expect(failed.exchanges[0]).toMatchObject({ question: 'Explain this', phase: 'failed' })

    await sessions.retry(sessionId, failed.exchanges[0]!.id)
    const regenerated = await sessions.get(sessionId)
    expect(mocks.createConversation).toHaveBeenCalledTimes(2)
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2)
    expect(mocks.sendMessage.mock.calls[1]?.[0]).toBe('conversation-2')
    expect(mocks.sendMessage.mock.calls[1]?.[1]).toMatchObject({
      text: expect.stringMatching(/^\[FOVEA_REGENERATE\][\s\S]*Final user request:\nExplain this$/),
      imagePath: capture().imagePath
    })
    expect(regenerated).toMatchObject({
      busy: false,
      phase: 'completed',
      disclosure: expect.stringMatching(/fresh provider context/i)
    })
    expect(regenerated.exchanges).toHaveLength(2)
    expect(regenerated.exchanges[1]).toMatchObject({
      question: 'Explain this',
      answer: 'answer',
      phase: 'completed',
      retryOf: failed.exchanges[0]!.id
    })
    expect(regenerated.segments).toHaveLength(2)

    await sessions.close(sessionId)
    await vi.waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledWith('conversation-1'))
    await vi.waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledWith('conversation-2'))
    await vi.waitFor(() => expect(mocks.deleteScreenshot).toHaveBeenCalledWith(capture().imagePath))
  })

  it('stops an active regeneration through the new provider conversation', async () => {
    const sessions = await createSessions()
    const opening = sessions.open(capture())
    const sessionId = await finishOpening(opening, 0)
    await sessions.send(sessionId, 'Explain this')
    const original = await sessions.get(sessionId)
    let releaseRegeneration!: () => void
    const regenerationGate = new Promise<void>((resolve) => { releaseRegeneration = resolve })
    mocks.sendMessage.mockImplementationOnce(() => (async function* () {
      yield { type: 'started' as const, turnId: 'retry-turn' }
      await regenerationGate
      yield { type: 'cancelled' as const }
    })())

    const retrying = sessions.retry(sessionId, original.exchanges[0]!.id)
    await vi.waitFor(async () => expect((await sessions.get(sessionId)).busy).toBe(true))
    await sessions.stop(sessionId)
    expect(mocks.cancel).toHaveBeenCalledWith('conversation-2')
    releaseRegeneration()
    await retrying
    await expect(sessions.get(sessionId)).resolves.toMatchObject({ busy: false, phase: 'stopped' })
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
