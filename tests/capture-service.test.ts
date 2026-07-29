import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OcrService } from '../src/main/ocr/ocr-service'

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
    toPNG: () => Buffer.from('whole-display'),
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
    showInactive: vi.fn(),
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
    screenToDipRect: (_window: unknown, bounds: typeof display.bounds) => bounds,
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

    await service.begin('region')

    expect(mocks.secureWindow).toHaveBeenCalledWith(expect.objectContaining({
      x: -100,
      y: 20,
      width: 100,
      height: 50,
      useContentSize: true,
      transparent: false,
      backgroundColor: '#0b0c10'
    }))
    expect(mocks.window.setContentBounds).toHaveBeenCalledWith(mocks.display.bounds, false)
    await expect(service.getContext(42)).resolves.toEqual({
      width: 100,
      height: 50,
      minSelectionSize: 24,
      displayId: '7',
      imageDataUrl: `data:image/jpeg;base64,${Buffer.from('frozen-display').toString('base64')}`,
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

    await service.begin('region')
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

    await service.begin('region')
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
    expect(snapshot).toHaveBeenCalledWith([], true, true)
    expect(mocks.getSources).toHaveBeenCalledTimes(1)
    expect(mocks.getSources).toHaveBeenCalledWith(expect.objectContaining({ types: ['screen'] }))
    expect(recognise).toHaveBeenCalledWith(
      expect.stringMatching(/^capture-analysis-/),
      Buffer.from('whole-display'),
      { width: 200, height: 100 },
      expect.any(Function),
      { sourcePath: 'C:\\temp\\analysis.png', preserveGeometry: true }
    )
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
    await opening
    expect(mocks.window.showInactive).toHaveBeenCalledTimes(1)
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

    await service.begin('region')

    await expect(waitingContext).resolves.toMatchObject({ displayId: '7' })
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

    await service.begin('region')

    expect(snapshot).toHaveBeenCalledWith([], true, true)
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

    await service.begin('region')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.window.close).not.toHaveBeenCalled()
    await expect(service.getContext(42)).resolves.toMatchObject({ imageDataUrl: expect.stringContaining('data:image/jpeg') })
    service.dispose()
  })

  it('uses a startup-only watchdog when the frozen screen cannot be prepared', async () => {
    vi.useFakeTimers()
    mocks.loadRenderer.mockImplementationOnce(() => new Promise<undefined>(() => undefined))
    const { CaptureService } = await import('../src/main/capture/capture-service')
    const service = new CaptureService({ save: vi.fn() } as never, vi.fn(), vi.fn())

    const opening = expect(service.begin('region')).rejects.toThrow('The frozen screen could not be prepared in time')
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

    await service.begin('region', { onCompleted: destinationCompleted, onCancelled: destinationCancelled })
    await expect(service.getContext(42)).resolves.toMatchObject({ canEditBeforeSending: false })
    service.cancel()
    expect(destinationCancelled).toHaveBeenCalledTimes(1)
    expect(destinationCompleted).not.toHaveBeenCalled()

    await service.begin('region')
    await service.select({ x: 10, y: 5, width: 24, height: 24 }, 42)
    expect(defaultCompleted).toHaveBeenCalledTimes(1)
    expect(destinationCompleted).not.toHaveBeenCalled()
    service.dispose()
  })
})
