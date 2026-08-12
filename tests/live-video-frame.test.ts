import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveVideoFrameCapture, type LiveVideoFrameEnvironment, type LiveVideoFrameTiming } from '../src/preload/live-video-frame'

const timing: LiveVideoFrameTiming = {
  streamStartupMs: 100,
  commitWaitMs: 20,
  nextFrameMs: 10,
  encodeMs: 20
}

afterEach(() => {
  vi.useRealTimers()
})

describe('live video frame capture', () => {
  it('warms a video-only display stream, sends one PNG frame, and stops every track', async () => {
    const harness = createHarness()
    const bridge = {
      arm: vi.fn(async () => undefined),
      provide: vi.fn(async () => true),
      disarm: vi.fn(async () => undefined)
    }
    const capture = new LiveVideoFrameCapture(bridge, harness.environment, timing)

    await expect(capture.prepare()).resolves.toBe(true)
    await expect(capture.capture()).resolves.toBe(true)

    expect(harness.getDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      video: { frameRate: { ideal: 30, max: 30 } }
    })
    expect(harness.video).toMatchObject({ autoplay: true, muted: true, playsInline: true })
    expect(harness.drawImage).toHaveBeenCalledWith(harness.video, 0, 0, 200, 100)
    expect(bridge.provide).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3, 4]),
      { viewport: { width: 100, height: 50 } }
    )
    expect(harness.stop).toHaveBeenCalled()
    expect(harness.video.srcObject).toBeNull()
    expect(bridge.disarm).toHaveBeenCalled()
  })

  it('encodes only the selected pixels for a normal drag capture', async () => {
    const harness = createHarness()
    const bridge = {
      arm: vi.fn(async () => undefined),
      provide: vi.fn(async () => true),
      disarm: vi.fn(async () => undefined)
    }
    const capture = new LiveVideoFrameCapture(bridge, harness.environment, timing)
    const rectangle = { x: 10, y: 5, width: 24, height: 24 }

    await capture.prepare()
    await expect(capture.capture(rectangle)).resolves.toBe(true)

    expect(harness.drawImage).toHaveBeenCalledWith(
      harness.video,
      20,
      10,
      48,
      48,
      0,
      0,
      48,
      48
    )
    expect(bridge.provide).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3, 4]),
      { viewport: { width: 100, height: 50 }, rectangle }
    )
  })

  it('stops a warmed stream when selection is cancelled', async () => {
    const harness = createHarness()
    const bridge = {
      arm: vi.fn(async () => undefined),
      provide: vi.fn(async () => true),
      disarm: vi.fn(async () => undefined)
    }
    const capture = new LiveVideoFrameCapture(bridge, harness.environment, timing)

    await capture.prepare()
    await capture.cancel()

    expect(harness.stop).toHaveBeenCalled()
    expect(bridge.provide).not.toHaveBeenCalled()
    expect(bridge.disarm).toHaveBeenCalledOnce()
  })

  it('falls back promptly and stops a display stream that arrives after commit timed out', async () => {
    vi.useFakeTimers()
    let resolveStream!: (stream: MediaStream) => void
    const request = new Promise<MediaStream>((resolve) => { resolveStream = resolve })
    const harness = createHarness(request)
    const bridge = {
      arm: vi.fn(async () => undefined),
      provide: vi.fn(async () => true),
      disarm: vi.fn(async () => undefined)
    }
    const capture = new LiveVideoFrameCapture(bridge, harness.environment, timing)

    const result = capture.capture()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(timing.commitWaitMs)
    await expect(result).resolves.toBe(false)

    resolveStream(harness.stream)
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.stop).toHaveBeenCalled()
    expect(bridge.provide).not.toHaveBeenCalled()
    expect(bridge.disarm).toHaveBeenCalled()
  })

  it('stops an opening stream immediately when video playback stalls and capture is cancelled', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    vi.mocked(harness.video.play).mockReturnValue(new Promise<void>(() => undefined))
    const bridge = {
      arm: vi.fn(async () => undefined),
      provide: vi.fn(async () => true),
      disarm: vi.fn(async () => undefined)
    }
    const capture = new LiveVideoFrameCapture(bridge, harness.environment, timing)

    const preparation = capture.prepare()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.video.play).toHaveBeenCalledOnce()

    await capture.cancel()
    expect(harness.stop).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(timing.streamStartupMs)
    await expect(preparation).resolves.toBe(false)
  })

  it('falls back instead of encoding a stale frame when no new video frame arrives', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const requestVideoFrameCallback = vi.fn(() => 1)
    Object.defineProperty(harness.video, 'requestVideoFrameCallback', {
      configurable: true,
      value: requestVideoFrameCallback
    })
    const bridge = {
      arm: vi.fn(async () => undefined),
      provide: vi.fn(async () => true),
      disarm: vi.fn(async () => undefined)
    }
    const capture = new LiveVideoFrameCapture(bridge, harness.environment, timing)

    await expect(capture.prepare()).resolves.toBe(true)
    const result = capture.capture()
    await vi.advanceTimersByTimeAsync(timing.nextFrameMs)

    await expect(result).resolves.toBe(false)
    expect(requestVideoFrameCallback).toHaveBeenCalledOnce()
    expect(bridge.provide).not.toHaveBeenCalled()
    expect(harness.stop).toHaveBeenCalled()
  })

  it('does not let an older timed-out preparation disarm a newer stream grant', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const firstStop = vi.fn()
    const firstTrack = { stop: firstStop } as unknown as MediaStreamTrack
    const firstStream = {
      getTracks: () => [firstTrack],
      getVideoTracks: () => [firstTrack]
    } as unknown as MediaStream
    const firstVideo = {
      ...harness.video,
      srcObject: null,
      play: vi.fn(() => new Promise<void>(() => undefined))
    } as unknown as HTMLVideoElement
    harness.getDisplayMedia
      .mockResolvedValueOnce(firstStream)
      .mockResolvedValueOnce(harness.stream)
    harness.environment.createVideo = vi.fn()
      .mockReturnValueOnce(firstVideo)
      .mockReturnValueOnce(harness.video)
    const bridge = {
      arm: vi.fn(async () => undefined),
      provide: vi.fn(async () => true),
      disarm: vi.fn(async () => undefined)
    }
    const capture = new LiveVideoFrameCapture(bridge, harness.environment, timing)

    const firstPreparation = capture.prepare()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(firstVideo.play).toHaveBeenCalledOnce()
    await capture.cancel()

    await expect(capture.prepare()).resolves.toBe(true)
    expect(bridge.arm).toHaveBeenCalledTimes(2)
    expect(bridge.disarm).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(timing.streamStartupMs)
    await expect(firstPreparation).resolves.toBe(false)
    expect(bridge.disarm).toHaveBeenCalledOnce()
    await expect(capture.capture()).resolves.toBe(true)
    expect(bridge.provide).toHaveBeenCalledOnce()
    expect(bridge.disarm).toHaveBeenCalledTimes(2)
    expect(firstStop).toHaveBeenCalled()
  })
})

function createHarness(displayMedia?: Promise<MediaStream>): {
  environment: LiveVideoFrameEnvironment
  getDisplayMedia: ReturnType<typeof vi.fn>
  stream: MediaStream
  video: HTMLVideoElement
  drawImage: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
} {
  const stop = vi.fn()
  const track = { stop } as unknown as MediaStreamTrack
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track]
  } as unknown as MediaStream
  const requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback) => {
    queueMicrotask(() => callback(0, {} as VideoFrameCallbackMetadata))
    return 1
  })
  const video = {
    autoplay: false,
    muted: false,
    playsInline: false,
    srcObject: null,
    readyState: 2,
    videoWidth: 200,
    videoHeight: 100,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestVideoFrameCallback
  } as unknown as HTMLVideoElement
  const drawImage = vi.fn()
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob: vi.fn((callback: BlobCallback) => callback(new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })))
  } as unknown as HTMLCanvasElement
  const getDisplayMedia = vi.fn(() => displayMedia ?? Promise.resolve(stream))
  return {
    environment: {
      getDisplayMedia,
      createVideo: () => video,
      createCanvas: () => canvas,
      getViewport: () => ({ width: 100, height: 50 })
    },
    getDisplayMedia,
    stream,
    video,
    drawImage,
    stop
  }
}
