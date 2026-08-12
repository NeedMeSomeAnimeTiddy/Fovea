import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureDestination, CaptureService } from '../src/main/capture/capture-service'
import type { OcrService } from '../src/main/ocr/ocr-service'

const mocks = vi.hoisted(() => {
  type Listener = (...arguments_: unknown[]) => void
  const listeners = new Map<string, Set<Listener>>()
  const display = {
    id: 7,
    bounds: { x: -100, y: 20, width: 100, height: 50 },
    workArea: { x: -100, y: 20, width: 100, height: 40 },
    scaleFactor: 2,
    rotation: 0
  }
  const crop = vi.fn(() => ({ toPNG: () => Buffer.from('cropped') }))
  const toPNG = vi.fn(() => Buffer.from('whole-display'))
  const image = {
    crop,
    getSize: () => ({ width: 200, height: 100 }),
    isEmpty: () => false,
    resize: () => ({ toBitmap: () => Buffer.from([0, 0, 0, 255, 1, 1, 1, 255]) }),
    toPNG
  }
  const webListeners = new Map<string, Listener>()
  let displayMediaHandler: ((request: Record<string, unknown>, callback: (streams: unknown) => void) => void) | null = null
  const setDisplayMediaRequestHandler = vi.fn((handler: typeof displayMediaHandler) => { displayMediaHandler = handler })
  const captureSession = { setDisplayMediaRequestHandler }
  const mainFrame = { id: 42 }
  const setWindowOpenHandler = vi.fn()
  let contentBounds = { ...display.workArea }
  let contentProtected = true
  let visible = false
  const window = {
    close: vi.fn(() => { visible = false }),
    focus: vi.fn(),
    isDestroyed: () => false,
    isContentProtected: vi.fn(() => contentProtected),
    isVisible: vi.fn(() => visible),
    getContentBounds: vi.fn(() => ({ ...contentBounds })),
    setContentBounds: vi.fn((bounds: typeof contentBounds) => { contentBounds = { ...bounds } }),
    setAlwaysOnTop: vi.fn(),
    setContentProtection: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    show: vi.fn(),
    showInactive: vi.fn(() => { visible = true }),
    webContents: {
      id: 42,
      mainFrame,
      session: captureSession,
      on: vi.fn((event: string, listener: Listener) => { webListeners.set(event, listener) }),
      once: vi.fn((event: string, listener: Listener) => { webListeners.set(event, listener) }),
      setWindowOpenHandler
    }
  }
  const secureWindow = vi.fn<(options?: unknown) => typeof window>(() => window)
  const loadRenderer = vi.fn(async () => undefined)
  const source = { id: 'screen:7:0', name: 'Display 7', display_id: '7', thumbnail: image, appIcon: null }
  const getSources = vi.fn(async () => [source])
  const screen = {
    getAllDisplays: () => [display],
    getCursorScreenPoint: () => ({ x: -50, y: 30 }),
    getDisplayNearestPoint: () => display,
    screenToDipRect: (_window: unknown, bounds: typeof display.bounds) => bounds,
    on: vi.fn((event: string, listener: Listener) => {
      const bucket = listeners.get(event) ?? new Set<Listener>()
      bucket.add(listener)
      listeners.set(event, bucket)
    }),
    off: vi.fn((event: string, listener: Listener) => { listeners.get(event)?.delete(listener) })
  }

  const resetWindowState = (): void => {
    contentBounds = { ...display.workArea }
    contentProtected = true
    visible = false
    displayMediaHandler = null
  }
  const setContentProtected = (value: boolean): void => { contentProtected = value }
  const getDisplayMediaHandler = (): NonNullable<typeof displayMediaHandler> => {
    if (!displayMediaHandler) throw new Error('Display media handler was not installed.')
    return displayMediaHandler
  }
  const getWebListener = (event: string): Listener => {
    const listener = webListeners.get(event)
    if (!listener) throw new Error(`WebContents listener was not registered: ${event}`)
    return listener
  }
  return { crop, display, getDisplayMediaHandler, getSources, getWebListener, image, loadRenderer, mainFrame, resetWindowState, screen, secureWindow, setContentProtected, setDisplayMediaRequestHandler, setWindowOpenHandler, source, toPNG, window }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: mocks.getSources },
  nativeImage: { createFromBuffer: vi.fn((buffer: Buffer) => ({
    ...mocks.image,
    getSize: () => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) })
  })) },
  screen: mocks.screen
}))

vi.mock('../src/main/windows/window-factory', () => ({
  loadRenderer: mocks.loadRenderer,
  secureWindow: mocks.secureWindow
}))

async function beginPaintedRegion(service: CaptureService, destination?: CaptureDestination): Promise<void> {
  const opening = service.begin('region', destination)
  await service.getContext(42)
  service.readyToShow(42)
  await opening
}

async function beginPaintedLiveRegion(service: CaptureService): Promise<void> {
  const opening = service.begin('region')
  await expect(service.getContext(42)).resolves.toMatchObject({ surface: 'live', imageDataUrl: null })
  service.readyToShow(42)
  await opening
}

function videoPng(width: number, height: number): Uint8Array {
  const png = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.write('IHDR', 12, 'ascii')
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  return png
}

beforeEach(() => {
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('frozen region capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resetWindowState()
    mocks.display.rotation = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows and crops the same startup bitmap with physical-pixel scaling', async () => {
    const completed = vi.fn(async () => undefined)
    const save = vi.fn(async () => 'C:\\temp\\capture.png')
    const remove = vi.fn(async () => undefined)
    const createDerivative = vi.fn(async () => 'C:\\temp\\capture-edited.png')
    const operations = [{ id: 'arrow-1', tool: 'arrow' as const, points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }], strokeWidth: 4 }]
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save, delete: remove } as never, completed, vi.fn(), { createDerivative })

    await beginPaintedRegion(service)

    expect(mocks.secureWindow).toHaveBeenCalledWith(expect.objectContaining({
      x: -100,
      y: 20,
      width: 100,
      height: 50,
      useContentSize: true,
      transparent: false,
      backgroundColor: '#0b0c10',
      paintWhenInitiallyHidden: true
    }))
    expect(mocks.window.setContentBounds).toHaveBeenCalledWith(mocks.display.bounds, false)
    await expect(service.getContext(42)).resolves.toEqual({
      width: 100,
      height: 50,
      minSelectionSize: 24,
      displayId: '7',
      surface: 'frozen',
      imageDataUrl: `data:image/png;base64,${Buffer.from('whole-display').toString('base64')}`,
      canEditBeforeSending: true
    })

    await service.select({ x: 10, y: 5, width: 24, height: 24 }, 42, operations, true)

    expect(mocks.crop).toHaveBeenCalledWith({ x: 20, y: 10, width: 48, height: 48 })
    expect(save).toHaveBeenCalledWith(Buffer.from('cropped'))
    expect(createDerivative).toHaveBeenCalledWith('C:\\temp\\capture.png', operations)
    expect(remove).toHaveBeenCalledWith('C:\\temp\\capture.png')
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      imagePath: 'C:\\temp\\capture-edited.png',
      selectedBounds: { x: 10, y: 5, width: 24, height: 24 },
      display: mocks.display,
      edited: true,
      preferWebSearch: true,
      extractText: false
    }))
    service.dispose()
  })

  it('marks a selected region for local text extraction', async () => {
    const completed = vi.fn(async () => undefined)
    const save = vi.fn(async () => 'C:\\temp\\capture.png')
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save } as never, completed, vi.fn())

    await beginPaintedRegion(service)
    await service.select({ x: 10, y: 5, width: 24, height: 24 }, 42, [], false, true, 'en-GB')

    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      preferWebSearch: false,
      extractText: true,
      ocrLanguageCode: 'en-GB'
    }))
    service.dispose()
  })

  it('analyzes the full frozen bitmap locally and removes its temporary source', async () => {
    const save = vi.fn(async () => 'C:\\temp\\analysis.png')
    const remove = vi.fn(async () => undefined)
    const ocrResult = {
      attachmentId: 'analysis',
      text: 'Save',
      confidence: 100,
      quality: 'normal' as const,
      language: { code: 'en-GB', label: 'English', source: 'configured' as const },
      regions: [{ id: 'line-1', text: 'Save', confidence: 100, bounds: { x: 0.1, y: 0.2, width: 0.12, height: 0.08 } }],
      words: [{ id: 'word-1', text: 'Save', confidence: 100, bounds: { x: 0.1, y: 0.2, width: 0.12, height: 0.08 } }],
      truncated: false
    }
    const recognise = vi.fn<OcrService['recognise']>(async (_attachmentId, _image, _size, onProgress) => {
      onProgress?.({ progress: 0.45, stage: 'Fast screen text ready', result: ocrResult })
      return ocrResult
    })
    const snapshot = vi.fn(async () => [{
      name: 'Save',
      controlType: 'Button',
      localizedControlType: 'button',
      automationId: 'save',
      helpText: 'Save the current document',
      enabled: true,
      focusable: true,
      visibleRatio: 1,
      centerVisible: true,
      bounds: { x: -92, y: 28, width: 20, height: 10 }
    }])
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService(
      { save, delete: remove } as never,
      vi.fn(),
      vi.fn(),
      undefined,
      { recognise },
      { snapshot }
    )

    await beginPaintedRegion(service)
    const onProgress = vi.fn()
    await expect(service.analyze(42, onProgress)).resolves.toMatchObject({
      features: [expect.objectContaining({
        kind: 'control',
        label: 'Save',
        source: 'hybrid',
        role: 'button',
        description: 'Save the current document'
      })],
      stage: 'text',
      complete: true,
      truncated: false
    })

    expect(onProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({
      stage: 'semantic',
      complete: false,
      features: [expect.objectContaining({ label: 'Save', source: 'uia', role: 'button' })]
    }))
    expect(onProgress).toHaveBeenNthCalledWith(2, expect.objectContaining({
      stage: 'text',
      complete: false,
      features: expect.arrayContaining([expect.objectContaining({ label: 'Save', source: 'hybrid' })])
    }))
    expect(onProgress).toHaveBeenNthCalledWith(3, expect.objectContaining({
      stage: 'text',
      complete: false,
      features: expect.arrayContaining([expect.objectContaining({ label: 'Save', source: 'hybrid' })])
    }))
    expect(snapshot).toHaveBeenCalledWith([], false, true)
    expect(mocks.getSources).toHaveBeenCalledTimes(1)
    expect(mocks.getSources).toHaveBeenCalledWith(expect.objectContaining({ types: ['screen'] }))
    expect(recognise).toHaveBeenCalledWith(
      expect.stringMatching(/^capture-analysis-/),
      Buffer.from('whole-display'),
      { width: 200, height: 100 },
      expect.any(Function),
      {
        sourcePath: 'C:\\temp\\analysis.png',
        preserveGeometry: true,
        refinementRegions: [{ x: 0.08, y: 0.16, width: 0.2, height: 0.2 }]
      }
    )
    expect(remove).toHaveBeenCalledWith('C:\\temp\\analysis.png')
    service.dispose()
  })

  it('progressively anchors semantic metadata to frozen-screen detector boxes', async () => {
    const save = vi.fn(async () => 'C:\\temp\\analysis.png')
    const remove = vi.fn(async () => undefined)
    const detectorFeature = {
      id: 'omniparser-save',
      kind: 'control' as const,
      label: 'Unlabelled button',
      source: 'visual' as const,
      detector: 'omniparser' as const,
      role: 'button',
      visibility: 0.92,
      bounds: { x: 0.08, y: 0.16, width: 0.2, height: 0.2 }
    }
    const prepare = vi.fn(async () => undefined)
    const detect = vi.fn(async (
      _analysisId: string,
      _image: Buffer,
      _size: { width: number; height: number },
      onProgress?: (progress: {
        features: typeof detectorFeature[]
        stage: 'full-frame' | 'tiles'
      }) => void
    ) => {
      onProgress?.({ features: [detectorFeature], stage: 'full-frame' })
      return [detectorFeature]
    })
    const snapshot = vi.fn(async () => [{
      name: 'Save',
      controlType: 'Button',
      localizedControlType: 'button',
      automationId: 'save',
      helpText: 'Save the current document',
      enabled: true,
      focusable: true,
      visibleRatio: 1,
      centerVisible: true,
      topmostVerified: true,
      bounds: { x: -92, y: 28, width: 20, height: 10 }
    }])
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService(
      { save, delete: remove } as never,
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      { snapshot },
      { prepare, detect }
    )

    await beginPaintedRegion(service)
    const onProgress = vi.fn()
    const analysis = await service.analyze(42, onProgress)

    expect(prepare).toHaveBeenCalledTimes(1)
    expect(detect).toHaveBeenCalledWith(
      expect.stringMatching(/^capture-analysis-/),
      Buffer.from('whole-display'),
      { width: 200, height: 100 },
      expect.any(Function),
      { sourcePath: 'C:\\temp\\analysis.png' }
    )
    expect(onProgress.mock.calls[0]?.[0]).toMatchObject({
      stage: 'semantic',
      features: []
    })
    expect(onProgress.mock.calls.some(([progress]) =>
      progress.features.some((feature: { id: string }) => feature.id === 'uia-1')
    )).toBe(true)
    expect(analysis.features).toEqual([
      expect.objectContaining({
        id: 'uia-1',
        label: 'Save',
        source: 'hybrid',
        detector: 'omniparser',
        description: 'Save the current document',
        bounds: detectorFeature.bounds
      })
    ])
    expect(remove).toHaveBeenCalledWith('C:\\temp\\analysis.png')
    service.dispose()
  })

  it('loads the hidden overlay while Windows is capturing the screen', async () => {
    let finishRenderer!: () => void
    let finishCapture!: () => void
    mocks.loadRenderer.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishRenderer = () => resolve(undefined) }))
    mocks.getSources.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = () => resolve([mocks.source]) }))
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService(
      { save: vi.fn() } as never,
      vi.fn(),
      vi.fn()
    )

    const opening = service.begin('region')

    expect(mocks.loadRenderer).toHaveBeenCalledTimes(1)
    expect(mocks.getSources).toHaveBeenCalledTimes(1)
    expect(mocks.window.showInactive).not.toHaveBeenCalled()

    finishRenderer()
    await Promise.resolve()
    expect(mocks.window.showInactive).not.toHaveBeenCalled()

    finishCapture()
    await expect(service.getContext(42)).resolves.toMatchObject({ displayId: '7' })
    expect(mocks.window.showInactive).not.toHaveBeenCalled()

    service.readyToShow(42)
    service.readyToShow(42)
    await opening
    expect(mocks.window.showInactive).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it.each([
    {
      edge: 'top-left',
      rectangle: { x: -10, y: -5, width: 34, height: 29 },
      bounded: { x: 0, y: 0, width: 24, height: 24 },
      physical: { x: 0, y: 0, width: 48, height: 48 }
    },
    {
      edge: 'bottom-right',
      rectangle: { x: 76, y: 26, width: 34, height: 29 },
      bounded: { x: 76, y: 26, width: 24, height: 24 },
      physical: { x: 152, y: 52, width: 48, height: 48 }
    }
  ])('intersects a drag crossing the $edge display edge with the visible selection', async ({ rectangle, bounded, physical }) => {
    const completed = vi.fn(async () => undefined)
    const save = vi.fn(async () => 'C:\\temp\\bounded-capture.png')
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save } as never, completed, vi.fn())

    await beginPaintedRegion(service)
    await service.select(rectangle, 42)

    expect(mocks.crop).toHaveBeenCalledWith(physical)
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ selectedBounds: bounded }))
    service.dispose()
  })

  it('abandons a stalled first frame within five seconds without covering the desktop', async () => {
    vi.useFakeTimers()
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save: vi.fn() } as never, vi.fn(), vi.fn())
    const opening = service.begin('region')

    await expect(service.getContext(42)).resolves.toMatchObject({ displayId: '7' })
    const rejection = expect(opening).rejects.toThrow('The frozen screen did not finish rendering in time')
    expect(mocks.window.showInactive).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)

    await rejection
    expect(mocks.window.showInactive).not.toHaveBeenCalled()
    expect(mocks.window.close).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('rechecks display topology after the hidden renderer becomes ready', async () => {
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save: vi.fn() } as never, vi.fn(), vi.fn())
    const opening = service.begin('region')

    await expect(service.getContext(42)).resolves.toMatchObject({ displayId: '7' })
    mocks.display.rotation = 90
    service.readyToShow(42)

    await expect(opening).rejects.toThrow('Display configuration changed')
    expect(mocks.window.showInactive).not.toHaveBeenCalled()
    expect(mocks.window.close).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('uses one startup deadline across bitmap acquisition and renderer paint', async () => {
    vi.useFakeTimers()
    let finishRenderer!: () => void
    let finishCapture!: () => void
    mocks.loadRenderer.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishRenderer = () => resolve(undefined) }))
    mocks.getSources.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = () => resolve([mocks.source]) }))
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save: vi.fn() } as never, vi.fn(), vi.fn())
    const opening = service.begin('region')
    const rejection = expect(opening).rejects.toThrow('The capture surface could not be prepared in time')

    await vi.advanceTimersByTimeAsync(15_000)
    finishRenderer()
    finishCapture()
    await expect(service.getContext(42)).resolves.toMatchObject({ displayId: '7' })
    await vi.advanceTimersByTimeAsync(5_000)

    await rejection
    expect(mocks.window.showInactive).not.toHaveBeenCalled()
    expect(mocks.window.close).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('cancels promptly without showing an overlay that is still waiting to paint', async () => {
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save: vi.fn() } as never, vi.fn(), vi.fn())
    const opening = service.begin('region')

    await expect(service.getContext(42)).resolves.toMatchObject({ displayId: '7' })
    const rejection = expect(opening).rejects.toThrow('Screen capture was cancelled')
    service.cancel()

    await rejection
    expect(mocks.window.showInactive).not.toHaveBeenCalled()
    expect(mocks.window.close).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('reuses a prewarmed overlay for the first capture', async () => {
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService(
      { save: vi.fn() } as never,
      vi.fn(),
      vi.fn()
    )

    service.prewarm()
    const waitingContext = service.getContext(42)
    await Promise.resolve()

    expect(mocks.secureWindow).toHaveBeenCalledTimes(1)
    expect(mocks.loadRenderer).toHaveBeenCalledTimes(1)

    const opening = service.begin('region')
    await expect(waitingContext).resolves.toMatchObject({ displayId: '7' })
    expect(mocks.window.showInactive).not.toHaveBeenCalled()
    service.readyToShow(42)
    await opening
    expect(mocks.secureWindow).toHaveBeenCalledTimes(1)
    expect(mocks.loadRenderer).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('displays the frozen screen without waiting for semantic analysis', async () => {
    let finishSemantic!: () => void
    const snapshot = vi.fn(() => new Promise<never[]>((resolve) => {
      finishSemantic = () => resolve([])
    }))
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService(
      { save: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      { snapshot }
    )

    await beginPaintedRegion(service)

    expect(snapshot).toHaveBeenCalledWith([], false, true)
    expect(mocks.window.showInactive).toHaveBeenCalledTimes(1)
    await expect(service.getContext(42)).resolves.toMatchObject({ displayId: '7' })

    finishSemantic()
    await Promise.resolve()
    service.dispose()
  })

  it('does not cancel an active frozen-screen session after sixty seconds', async () => {
    vi.useFakeTimers()
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save: vi.fn() } as never, vi.fn(), vi.fn())

    await beginPaintedRegion(service)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.window.close).not.toHaveBeenCalled()
    await expect(service.getContext(42)).resolves.toMatchObject({ imageDataUrl: expect.stringContaining('data:image/png') })
    service.dispose()
  })

  it('uses a startup-only watchdog when the frozen screen cannot be prepared', async () => {
    vi.useFakeTimers()
    mocks.loadRenderer.mockImplementationOnce(() => new Promise<undefined>(() => undefined))
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save: vi.fn() } as never, vi.fn(), vi.fn())

    const opening = expect(service.begin('region')).rejects.toThrow('The capture surface could not be prepared in time')
    await vi.advanceTimersByTimeAsync(20_000)

    await opening
    expect(mocks.window.close).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('routes one capture to its explicit destination and clears it on cancellation', async () => {
    const defaultCompleted = vi.fn(async () => undefined)
    const destinationCompleted = vi.fn(async () => undefined)
    const destinationCancelled = vi.fn()
    const save = vi.fn(async () => 'C:\\temp\\capture.png')
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save, delete: vi.fn() } as never, defaultCompleted, vi.fn())

    await beginPaintedRegion(service, { onCompleted: destinationCompleted, onCancelled: destinationCancelled })
    await expect(service.getContext(42)).resolves.toMatchObject({ canEditBeforeSending: false })
    service.cancel()
    expect(destinationCancelled).toHaveBeenCalledTimes(1)
    expect(destinationCompleted).not.toHaveBeenCalled()

    await beginPaintedRegion(service)
    await service.select({ x: 10, y: 5, width: 24, height: 24 }, 42)
    expect(defaultCompleted).toHaveBeenCalledTimes(1)
    expect(destinationCompleted).not.toHaveBeenCalled()
    service.dispose()
  })
})

describe('live region capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resetWindowState()
    mocks.display.rotation = 0
  })

  it('activates an already-visible transparent overlay without a native window opening transition', async () => {
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

    service.prewarm()
    await vi.waitFor(() => expect(mocks.window.showInactive).toHaveBeenCalledOnce())
    expect(mocks.window.setContentProtection).toHaveBeenCalledWith(true)
    expect(mocks.window.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(mocks.getSources).not.toHaveBeenCalled()

    const waitingContext = service.getContext(42)
    const opening = service.begin('region')
    await expect(waitingContext).resolves.toMatchObject({
      displayId: '7',
      surface: 'live',
      imageDataUrl: null
    })
    service.readyToShow(42)
    await opening

    expect(mocks.window.showInactive).toHaveBeenCalledOnce()
    expect(mocks.window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    expect(mocks.getSources).not.toHaveBeenCalled()
    service.dispose()
  })

  it('blocks overlay navigation and new windows before exposing capture controls', async () => {
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

    await beginPaintedLiveRegion(service)
    const navigation = { preventDefault: vi.fn() }
    mocks.getWebListener('will-navigate')(navigation)
    const openHandler = mocks.setWindowOpenHandler.mock.calls.at(-1)?.[0] as (() => { action: string }) | undefined

    expect(navigation.preventDefault).toHaveBeenCalledOnce()
    expect(openHandler?.()).toEqual({ action: 'deny' })
    service.dispose()
  })

  it('takes the screen bitmap only when the user releases the selection', async () => {
    const completed = vi.fn(async () => undefined)
    const save = vi.fn(async () => 'C:\\temp\\live-capture.png')
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService(
      { save } as never,
      completed,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { liveSelection: true, presentationDelayMs: 0 }
    )

    await beginPaintedLiveRegion(service)
    expect(mocks.getSources).not.toHaveBeenCalled()

    await service.select({ x: 10, y: 5, width: 24, height: 24 }, 42)

    expect(mocks.getSources).toHaveBeenCalledTimes(1)
    expect(mocks.toPNG).not.toHaveBeenCalled()
    expect(mocks.crop).toHaveBeenCalledWith({ x: 20, y: 10, width: 48, height: 48 })
    expect(save).toHaveBeenCalledWith(Buffer.from('cropped'))
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      imagePath: 'C:\\temp\\live-capture.png',
      selectedBounds: { x: 10, y: 5, width: 24, height: 24 }
    }))
    service.dispose()
  })

  it('uses one sender-bound video stream frame before falling back to a thumbnail', async () => {
    const completed = vi.fn(async () => undefined)
    const save = vi.fn(async () => 'C:\\temp\\video-frame.png')
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService(
      { save } as never,
      completed,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { liveSelection: true, presentationDelayMs: 0 }
    )

    await beginPaintedLiveRegion(service)
    service.armVideoFrame(42)
    const callback = vi.fn()
    mocks.getDisplayMediaHandler()({
      frame: mocks.mainFrame,
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: false,
      userGesture: true
    }, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({
      video: { id: mocks.source.id, name: mocks.source.name }
    }))
    const replayCallback = vi.fn()
    mocks.getDisplayMediaHandler()({
      frame: mocks.mainFrame,
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: false,
      userGesture: true
    }, replayCallback)
    expect(replayCallback).toHaveBeenCalledWith({})

    expect(mocks.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    })
    expect(service.provideVideoFrame(42, videoPng(48, 48), {
      viewport: { width: 100, height: 50 },
      rectangle: { x: 10, y: 5, width: 24, height: 24 }
    })).toBe(true)
    // The preload stops and disarms its stream before invoking select. The already
    // delivered one-shot frame must survive that cleanup.
    service.cancelVideoFrame(42)
    await service.select({ x: 10, y: 5, width: 24, height: 24 }, 42)

    expect(mocks.getSources).toHaveBeenCalledTimes(1)
    expect(mocks.crop).not.toHaveBeenCalled()
    expect(completed).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('accepts an in-bounds fractional-DPI selection without changing its metadata', async () => {
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
    const rectangle = { x: 10.4, y: 5.2, width: 24.8, height: 24.8 }

    await beginPaintedLiveRegion(service)
    service.armVideoFrame(42)
    const callback = vi.fn()
    mocks.getDisplayMediaHandler()({
      frame: mocks.mainFrame,
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: false,
      userGesture: true
    }, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())

    expect(service.provideVideoFrame(42, videoPng(50, 50), {
      viewport: { width: 100, height: 50 },
      rectangle
    })).toBe(true)
    service.dispose()
  })

  it('denies display streams that were not armed by the owning overlay frame', async () => {
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

    await beginPaintedLiveRegion(service)
    const callback = vi.fn()
    mocks.getDisplayMediaHandler()({
      frame: { id: 99 },
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: false,
      userGesture: true
    }, callback)

    expect(callback).toHaveBeenCalledWith({})
    expect(mocks.getSources).not.toHaveBeenCalled()
    expect(service.provideVideoFrame(42, videoPng(200, 100), {
      viewport: { width: 100, height: 50 }
    })).toBe(false)
    service.dispose()
  })

  it('requires the trusted renderer origin and an active user gesture for display streams', async () => {
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

    await beginPaintedLiveRegion(service)
    service.armVideoFrame(42)
    const wrongOrigin = vi.fn()
    mocks.getDisplayMediaHandler()({
      frame: mocks.mainFrame,
      securityOrigin: 'https://example.test',
      videoRequested: true,
      audioRequested: false,
      userGesture: true
    }, wrongOrigin)
    const noGesture = vi.fn()
    mocks.getDisplayMediaHandler()({
      frame: mocks.mainFrame,
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: false,
      userGesture: false
    }, noGesture)

    expect(wrongOrigin).toHaveBeenCalledWith({})
    expect(noGesture).toHaveBeenCalledWith({})
    expect(mocks.getSources).not.toHaveBeenCalled()

    const allowed = vi.fn()
    mocks.getDisplayMediaHandler()({
      frame: mocks.mainFrame,
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: false,
      userGesture: true
    }, allowed)
    await vi.waitFor(() => expect(allowed).toHaveBeenCalledWith({
      video: { id: mocks.source.id, name: mocks.source.name }
    }))
    service.dispose()
  })

  it('does not restore a cancelled grant after source enumeration finishes', async () => {
    let resolveSources!: (sources: typeof mocks.source[]) => void
    mocks.getSources.mockImplementationOnce(() => new Promise((resolve) => { resolveSources = resolve }))
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

    await beginPaintedLiveRegion(service)
    service.armVideoFrame(42)
    const callback = vi.fn()
    mocks.getDisplayMediaHandler()({
      frame: mocks.mainFrame,
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: false,
      userGesture: true
    }, callback)
    service.cancelVideoFrame(42)
    resolveSources([mocks.source])

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}))
    expect(service.provideVideoFrame(42, videoPng(200, 100), {
      viewport: { width: 100, height: 50 }
    })).toBe(false)
    service.dispose()
  })

  it('rejects a severely downscaled full-display video frame', async () => {
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

    await beginPaintedLiveRegion(service)
    service.armVideoFrame(42)
    const callback = vi.fn()
    mocks.getDisplayMediaHandler()({
      frame: mocks.mainFrame,
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: false,
      userGesture: true
    }, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())

    expect(() => service.provideVideoFrame(42, videoPng(50, 25), {
      viewport: { width: 100, height: 50 }
    })).toThrow('did not match this display')
    service.dispose()
  })

  it('holds the current frame only when Edit requests it', async () => {
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

    await beginPaintedLiveRegion(service)
    await expect(service.freeze(42, 'edit')).resolves.toEqual(expect.objectContaining({
      displayId: '7',
      surface: 'frozen',
      imageDataUrl: `data:image/png;base64,${Buffer.from('whole-display').toString('base64')}`
    }))

    expect(mocks.getSources).toHaveBeenCalledOnce()
    expect(mocks.window.close).not.toHaveBeenCalled()
    await expect(service.getContext(42)).resolves.toMatchObject({ surface: 'frozen' })
    service.dispose()
  })

  it('uses a full video stream frame when Edit holds the selected moment', async () => {
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

    await beginPaintedLiveRegion(service)
    service.armVideoFrame(42)
    const callback = vi.fn()
    mocks.getDisplayMediaHandler()({
      frame: mocks.mainFrame,
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: false,
      userGesture: true
    }, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    expect(service.provideVideoFrame(42, videoPng(200, 100), {
      viewport: { width: 100, height: 50 }
    })).toBe(true)
    service.cancelVideoFrame(42)

    await expect(service.freeze(42, 'edit')).resolves.toMatchObject({
      surface: 'frozen',
      imageDataUrl: `data:image/png;base64,${Buffer.from('whole-display').toString('base64')}`
    })
    expect(mocks.getSources).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('does not scan the desktop accessibility tree until Analyze is explicitly requested', async () => {
    const snapshot = vi.fn(async () => [])
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService(
      { save: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      { snapshot },
      undefined,
      { liveSelection: true, presentationDelayMs: 0 }
    )

    await beginPaintedLiveRegion(service)
    expect(snapshot).not.toHaveBeenCalled()

    await service.freeze(42, 'analyze')
    expect(snapshot).toHaveBeenCalledWith([], false, true)
    service.dispose()
  })

  it('falls back to the frozen path when Windows rejects capture exclusion', async () => {
    mocks.setContentProtected(false)
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

    const opening = service.begin('region')
    await vi.waitFor(() => expect(mocks.secureWindow).toHaveBeenCalledTimes(2))
    await expect(service.getContext(42)).resolves.toMatchObject({ surface: 'frozen' })
    service.readyToShow(42)
    await opening

    expect(mocks.secureWindow.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ transparent: true }))
    expect(mocks.secureWindow.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ transparent: false }))
    expect(mocks.getSources).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('honours the user turning live selection off and back on', async () => {
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

    expect(service.supportsLiveSelection()).toBe(true)
    expect(service.isLiveSelectionEnabled()).toBe(true)

    service.setLiveSelectionEnabled(false)
    expect(service.isLiveSelectionEnabled()).toBe(false)
    await beginPaintedRegion(service)
    await expect(service.getContext(42)).resolves.toMatchObject({ surface: 'frozen' })
    expect(mocks.getSources).toHaveBeenCalledTimes(1)
    service.cancel()

    service.setLiveSelectionEnabled(true)
    expect(service.isLiveSelectionEnabled()).toBe(true)
    await beginPaintedLiveRegion(service)
    expect(mocks.getSources).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('reports live selection as unavailable when the platform cannot support it', async () => {
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService(
      { save: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { liveSelection: false, presentationDelayMs: 0 }
    )

    expect(service.supportsLiveSelection()).toBe(false)
    // Enabling the setting cannot override a platform that lacks capture exclusion.
    service.setLiveSelectionEnabled(true)
    expect(service.isLiveSelectionEnabled()).toBe(false)
    await beginPaintedRegion(service)
    await expect(service.getContext(42)).resolves.toMatchObject({ surface: 'frozen' })
    service.dispose()
  })

  it('enables capture exclusion only on supported Windows builds', async () => {
    const { supportsLiveRegionCapture } = await import('../src/main/capture/capture-service')

    expect(supportsLiveRegionCapture('win32', '10.0.19045')).toBe(true)
    expect(supportsLiveRegionCapture('win32', '10.0.19041')).toBe(true)
    expect(supportsLiveRegionCapture('win32', '10.0.18363')).toBe(false)
    expect(supportsLiveRegionCapture('darwin', '23.6.0')).toBe(false)
  })
})
