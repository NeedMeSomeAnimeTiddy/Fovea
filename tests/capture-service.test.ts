import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Listener = (...arguments_: unknown[]) => void
  const listeners = new Map<string, Set<Listener>>()
  const display = {
    id: 7,
    bounds: { x: -100, y: 20, width: 100, height: 50 },
    workArea: { x: -100, y: 20, width: 100, height: 40 },
    scaleFactor: 2
  }
  const crop = vi.fn(() => ({ toPNG: () => Buffer.from('cropped') }))
  const image = {
    crop,
    getSize: () => ({ width: 200, height: 100 }),
    isEmpty: () => false,
    toJPEG: () => Buffer.from('frozen-display')
  }
  const webListeners = new Map<string, Listener>()
  let contentBounds = { ...display.workArea }
  const window = {
    close: vi.fn(),
    focus: vi.fn(),
    isDestroyed: () => false,
    getContentBounds: vi.fn(() => ({ ...contentBounds })),
    setContentBounds: vi.fn((bounds: typeof contentBounds) => { contentBounds = { ...bounds } }),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    show: vi.fn(),
    webContents: {
      id: 42,
      on: vi.fn((event: string, listener: Listener) => { webListeners.set(event, listener) }),
      once: vi.fn((event: string, listener: Listener) => { webListeners.set(event, listener) })
    }
  }
  const secureWindow = vi.fn(() => window)
  const loadRenderer = vi.fn(async () => undefined)
  const source = { id: 'screen:7:0', name: 'Display 7', display_id: '7', thumbnail: image, appIcon: null }
  const getSources = vi.fn(async () => [source])
  const screen = {
    getAllDisplays: () => [display],
    getCursorScreenPoint: () => ({ x: -50, y: 30 }),
    getDisplayNearestPoint: () => display,
    on: vi.fn((event: string, listener: Listener) => {
      const bucket = listeners.get(event) ?? new Set<Listener>()
      bucket.add(listener)
      listeners.set(event, bucket)
    }),
    off: vi.fn((event: string, listener: Listener) => { listeners.get(event)?.delete(listener) })
  }

  const resetContentBounds = (): void => { contentBounds = { ...display.workArea } }
  return { crop, display, getSources, image, loadRenderer, resetContentBounds, screen, secureWindow, source, window }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: mocks.getSources },
  screen: mocks.screen
}))

vi.mock('../src/main/windows/window-factory', () => ({
  loadRenderer: mocks.loadRenderer,
  secureWindow: mocks.secureWindow
}))

describe('frozen region capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resetContentBounds()
  })

  it('shows and crops the same startup bitmap with physical-pixel scaling', async () => {
    const completed = vi.fn(async () => undefined)
    const save = vi.fn(async () => 'C:\\temp\\capture.png')
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save } as never, completed, vi.fn())

    await service.begin('region')

    expect(mocks.secureWindow).toHaveBeenCalledWith(expect.objectContaining({
      x: -100,
      y: 20,
      width: 100,
      height: 50,
      useContentSize: true,
      transparent: false,
      backgroundColor: '#101010'
    }))
    expect(mocks.window.setContentBounds).toHaveBeenCalledWith(mocks.display.bounds, false)
    await expect(service.getContext(42)).resolves.toEqual({
      width: 100,
      height: 50,
      minSelectionSize: 24,
      displayId: '7',
      imageDataUrl: `data:image/jpeg;base64,${Buffer.from('frozen-display').toString('base64')}`
    })

    await service.select({ x: 10, y: 5, width: 24, height: 24 }, 42)

    expect(mocks.crop).toHaveBeenCalledWith({ x: 20, y: 10, width: 48, height: 48 })
    expect(save).toHaveBeenCalledWith(Buffer.from('cropped'))
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      imagePath: 'C:\\temp\\capture.png',
      selectedBounds: { x: 10, y: 5, width: 24, height: 24 },
      display: mocks.display
    }))
    service.dispose()
  })

  it('loads the hidden overlay while Windows is capturing the screen', async () => {
    let finishRenderer!: () => void
    let finishCapture!: () => void
    mocks.loadRenderer.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishRenderer = () => resolve(undefined) }))
    mocks.getSources.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = () => resolve([mocks.source]) }))
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save: vi.fn() } as never, vi.fn(), vi.fn())

    const opening = service.begin('region')

    expect(mocks.loadRenderer).toHaveBeenCalledTimes(1)
    expect(mocks.getSources).toHaveBeenCalledTimes(1)
    expect(mocks.window.show).not.toHaveBeenCalled()

    finishRenderer()
    await Promise.resolve()
    expect(mocks.window.show).not.toHaveBeenCalled()

    finishCapture()
    await opening
    expect(mocks.window.show).toHaveBeenCalledTimes(1)
    service.dispose()
  })
})
