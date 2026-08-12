import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Rectangle = { x: number; y: number; width: number; height: number }

  const displays = [
    {
      id: 7,
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      workArea: { x: 0, y: 0, width: 100, height: 50 },
      scaleFactor: 1
    },
    {
      id: 8,
      bounds: { x: 100, y: 0, width: 120, height: 60 },
      workArea: { x: 100, y: 0, width: 120, height: 60 },
      scaleFactor: 1
    }
  ]

  const createImage = (displayId: number) => ({
    getSize: () => ({ width: displays.find(({ id }) => id === displayId)!.bounds.width, height: displays.find(({ id }) => id === displayId)!.bounds.height }),
    isEmpty: () => false,
    resize: () => ({ toBitmap: () => Buffer.from([0, 0, 0, 255, 1, 1, 1, 255]) }),
    toPNG: () => Buffer.from(`display-${displayId}`)
  })
  const sources = displays.map(({ id }) => ({
    id: `screen:${id}:0`,
    name: `Display ${id}`,
    display_id: String(id),
    thumbnail: createImage(id),
    appIcon: null
  }))
  const getSources = vi.fn(async () => sources)
  const captureSession = { setDisplayMediaRequestHandler: vi.fn() }

  const windows = displays.map((display, index) => {
    let contentBounds: Rectangle = { ...display.workArea }
    let visible = false
    return {
      close: vi.fn(() => { visible = false }),
      focus: vi.fn(),
      isDestroyed: () => false,
      isContentProtected: vi.fn(() => true),
      isVisible: vi.fn(() => visible),
      getContentBounds: vi.fn(() => ({ ...contentBounds })),
      setContentBounds: vi.fn((bounds: Rectangle) => { contentBounds = { ...bounds } }),
      setAlwaysOnTop: vi.fn(),
      setContentProtection: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      showInactive: vi.fn(() => { visible = true }),
      webContents: {
        id: 42 + index,
        mainFrame: { id: 42 + index },
        session: captureSession,
        on: vi.fn(),
        once: vi.fn(),
        setWindowOpenHandler: vi.fn()
      }
    }
  })
  const secureWindow = vi.fn((options: Rectangle) => {
    const window = windows.find((_candidate, index) => displays[index]!.bounds.x === options.x)
    if (!window) throw new Error(`Unexpected overlay bounds: ${JSON.stringify(options)}`)
    return window
  })
  const loadRenderer = vi.fn(async () => undefined)
  const screen = {
    getAllDisplays: () => displays,
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    getDisplayNearestPoint: () => displays[0],
    screenToDipRect: (_window: unknown, bounds: Rectangle) => bounds,
    on: vi.fn(),
    off: vi.fn()
  }

  return { displays, getSources, loadRenderer, screen, secureWindow, sources, windows }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: mocks.getSources },
  nativeImage: { createFromBuffer: vi.fn() },
  screen: mocks.screen
}))

vi.mock('../src/main/windows/window-factory', () => ({
  loadRenderer: mocks.loadRenderer,
  secureWindow: mocks.secureWindow
}))

describe('multi-display frozen-frame readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps every overlay hidden until every display reports a rendered frozen frame', async () => {
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save: vi.fn() } as never, vi.fn(), vi.fn())
    const firstWindow = mocks.windows[0]!
    const secondWindow = mocks.windows[1]!

    const opening = service.begin('region')
    await expect(Promise.all([
      service.getContext(42),
      service.getContext(43)
    ])).resolves.toEqual([
      expect.objectContaining({ displayId: '7' }),
      expect.objectContaining({ displayId: '8' })
    ])

    service.readyToShow(42)
    await Promise.resolve()

    expect(firstWindow.showInactive).not.toHaveBeenCalled()
    expect(secondWindow.showInactive).not.toHaveBeenCalled()

    service.readyToShow(43)
    await opening

    expect(firstWindow.showInactive).toHaveBeenCalledTimes(1)
    expect(secondWindow.showInactive).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('fails the whole capture when any requested display image is missing', async () => {
    mocks.getSources.mockResolvedValueOnce([mocks.sources[0]!])
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save: vi.fn() } as never, vi.fn(), vi.fn())

    await expect(service.begin('region')).rejects.toThrow('usable image for every requested display')

    for (const window of mocks.windows) {
      expect(window.showInactive).not.toHaveBeenCalled()
      expect(window.close).toHaveBeenCalledTimes(1)
    }
    service.dispose()
  })

  it('fails the whole capture when any requested display image is empty', async () => {
    const emptySource = {
      ...mocks.sources[1]!,
      thumbnail: { ...mocks.sources[1]!.thumbnail, isEmpty: () => true }
    }
    mocks.getSources.mockResolvedValueOnce([mocks.sources[0]!, emptySource])
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save: vi.fn() } as never, vi.fn(), vi.fn())

    await expect(service.begin('region')).rejects.toThrow('usable image for every requested display')

    for (const window of mocks.windows) {
      expect(window.showInactive).not.toHaveBeenCalled()
      expect(window.close).toHaveBeenCalledTimes(1)
    }
    service.dispose()
  })

  it('keeps both displays live until Edit holds one frame, then closes the other overlay', async () => {
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService(
      { save: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { liveSelection: true, presentationDelayMs: 0 }
    )
    const firstWindow = mocks.windows[0]!
    const secondWindow = mocks.windows[1]!

    service.prewarm()
    await vi.waitFor(() => {
      expect(firstWindow.showInactive).toHaveBeenCalledOnce()
      expect(secondWindow.showInactive).toHaveBeenCalledOnce()
    })
    expect(mocks.getSources).not.toHaveBeenCalled()

    const firstContext = service.getContext(42)
    const secondContext = service.getContext(43)
    const opening = service.begin('region')
    await expect(Promise.all([firstContext, secondContext])).resolves.toEqual([
      expect.objectContaining({ displayId: '7', surface: 'live', imageDataUrl: null }),
      expect.objectContaining({ displayId: '8', surface: 'live', imageDataUrl: null })
    ])
    service.readyToShow(42)
    service.readyToShow(43)
    await opening

    await expect(service.freeze(42, 'edit')).resolves.toMatchObject({
      displayId: '7',
      surface: 'frozen'
    })
    expect(mocks.getSources).toHaveBeenCalledOnce()
    expect(firstWindow.close).not.toHaveBeenCalled()
    expect(secondWindow.close).toHaveBeenCalledOnce()
    service.dispose()
  })
})
