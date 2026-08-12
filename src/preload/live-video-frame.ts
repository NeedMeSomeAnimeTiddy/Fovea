import type { CaptureVideoFrameMetadata } from '@shared/contracts/ipc'
import type { Rectangle } from '@shared/types/geometry'

export interface LiveVideoFrameBridge {
  arm(): Promise<void>
  provide(png: Uint8Array, metadata: CaptureVideoFrameMetadata): Promise<boolean>
  disarm(): Promise<void>
}

export interface LiveVideoFrameEnvironment {
  getDisplayMedia(constraints: DisplayMediaStreamOptions): Promise<MediaStream>
  createVideo(): HTMLVideoElement
  createCanvas(): HTMLCanvasElement
  getViewport(): { width: number; height: number }
}

export interface LiveVideoFrameTiming {
  streamStartupMs: number
  commitWaitMs: number
  nextFrameMs: number
  encodeMs: number
}

interface PreparedVideoFrame {
  generation: number
  stream: MediaStream
  video: HTMLVideoElement
}

const DEFAULT_TIMING: LiveVideoFrameTiming = {
  streamStartupMs: 1_500,
  commitWaitMs: 400,
  nextFrameMs: 100,
  encodeMs: 1_500
}

/**
 * Keeps a display stream only while a region selection is active. The caller can
 * warm it without waiting, take one PNG frame at commit, and then every track is
 * stopped even when IPC, playback, or encoding fails.
 */
export class LiveVideoFrameCapture {
  private generation = 0
  private prepared: PreparedVideoFrame | null = null
  private preparation: { generation: number; promise: Promise<PreparedVideoFrame | null> } | null = null
  private openingStream: { generation: number; stream: MediaStream } | null = null
  private captureInFlight = false

  constructor(
    private readonly bridge: LiveVideoFrameBridge,
    private readonly environment: LiveVideoFrameEnvironment,
    private readonly timing: LiveVideoFrameTiming = DEFAULT_TIMING
  ) {}

  async prepare(): Promise<boolean> {
    return Boolean(await this.ensurePrepared())
  }

  async capture(rectangle?: Rectangle): Promise<boolean> {
    if (this.captureInFlight) return false
    this.captureInFlight = true
    try {
      const prepared = this.prepared ?? await withTimeout(
        this.ensurePrepared(),
        this.timing.commitWaitMs,
        null
      )
      if (!prepared || prepared.generation !== this.generation) {
        await this.cancel()
        return false
      }

      const receivedFreshFrame = await waitForNextVideoFrame(prepared.video, this.timing.nextFrameMs)
      if (!receivedFreshFrame || prepared.generation !== this.generation) return false

      const width = prepared.video.videoWidth
      const height = prepared.video.videoHeight
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return false
      const viewport = this.environment.getViewport()
      const source = captureSourceRectangle(rectangle, viewport, { width, height })
      if (!source) return false

      const canvas = this.environment.createCanvas()
      canvas.width = source.width
      canvas.height = source.height
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) return false
      if (rectangle) {
        context.drawImage(
          prepared.video,
          source.x,
          source.y,
          source.width,
          source.height,
          0,
          0,
          source.width,
          source.height
        )
      } else {
        context.drawImage(prepared.video, 0, 0, width, height)
      }
      const blob = await withTimeout(canvasToPng(canvas), this.timing.encodeMs, null)
      if (!blob || prepared.generation !== this.generation) return false

      const png = new Uint8Array(await blob.arrayBuffer())
      if (!png.byteLength || prepared.generation !== this.generation) return false
      return await this.bridge.provide(png, { viewport, ...(rectangle ? { rectangle } : {}) })
    } catch {
      return false
    } finally {
      this.captureInFlight = false
      await this.cancel()
    }
  }

  async cancel(): Promise<void> {
    this.generation += 1
    const prepared = this.prepared
    this.prepared = null
    this.preparation = null
    const openingStream = this.openingStream
    this.openingStream = null
    if (prepared) releasePreparedFrame(prepared)
    if (openingStream) stopStream(openingStream.stream)
    try {
      await this.bridge.disarm()
    } catch {
      // The window may already be closing. Local tracks are stopped regardless.
    }
  }

  private ensurePrepared(): Promise<PreparedVideoFrame | null> {
    if (this.prepared) return Promise.resolve(this.prepared)
    if (this.preparation) return this.preparation.promise

    const generation = ++this.generation
    const promise = this.open(generation).then((prepared) => {
      if (!prepared) return null
      if (generation !== this.generation) {
        releasePreparedFrame(prepared)
        return null
      }
      this.prepared = prepared
      return prepared
    }).finally(() => {
      if (this.preparation?.generation === generation) this.preparation = null
    })
    this.preparation = { generation, promise }
    return promise
  }

  private async open(generation: number): Promise<PreparedVideoFrame | null> {
    let stream: MediaStream | null = null
    try {
      await this.bridge.arm()
      if (generation !== this.generation) return null

      const request = this.environment.getDisplayMedia({
        audio: false,
        video: { frameRate: { ideal: 30, max: 30 } }
      })
      void request.then((lateStream) => {
        if (generation !== this.generation) stopStream(lateStream)
      }).catch(() => undefined)
      stream = await withTimeout(request, this.timing.streamStartupMs, null)
      if (!stream || generation !== this.generation) {
        if (stream) stopStream(stream)
        const ownsAttempt = generation === this.generation
        if (ownsAttempt) {
          this.generation += 1
          try {
            await this.bridge.disarm()
          } catch {
            // The main-process grant may already have expired.
          }
        }
        return null
      }
      this.openingStream = { generation, stream }
      if (!stream.getVideoTracks().length) {
        throw new Error('The display stream did not contain video.')
      }

      const video = this.environment.createVideo()
      video.autoplay = true
      video.muted = true
      video.playsInline = true
      video.srcObject = stream
      const playing = await withTimeout(video.play().then(() => true), this.timing.streamStartupMs, false)
      if (!playing) throw new Error('The display stream did not begin playback.')
      await waitForVideoDimensions(video, this.timing.streamStartupMs)
      if (generation !== this.generation) {
        releasePreparedFrame({ generation, stream, video })
        return null
      }
      if (this.openingStream?.generation === generation) this.openingStream = null
      return { generation, stream, video }
    } catch {
      if (this.openingStream?.generation === generation) this.openingStream = null
      if (stream) stopStream(stream)
      const ownsAttempt = generation === this.generation
      if (ownsAttempt) {
        this.generation += 1
        try {
          await this.bridge.disarm()
        } catch {
          // A denied or closing bridge is the normal signal to use bitmap fallback.
        }
      }
      return null
    }
  }
}

function releasePreparedFrame(prepared: PreparedVideoFrame): void {
  prepared.video.pause()
  prepared.video.srcObject = null
  stopStream(prepared.stream)
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

function waitForVideoDimensions(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (error?: Error): void => {
      video.removeEventListener('loadeddata', onLoaded)
      video.removeEventListener('error', onError)
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else if (video.videoWidth > 0 && video.videoHeight > 0) resolve()
      else reject(new Error('The display stream did not expose a video frame.'))
    }
    const onLoaded = (): void => finish()
    const onError = (): void => finish(new Error('The display stream stopped before its first frame.'))
    video.addEventListener('loadeddata', onLoaded, { once: true })
    video.addEventListener('error', onError, { once: true })
    timer = setTimeout(() => finish(new Error('The display stream did not start in time.')), timeoutMs)
  })
}

function waitForNextVideoFrame(video: HTMLVideoElement, timeoutMs: number): Promise<boolean> {
  if (typeof video.requestVideoFrameCallback !== 'function') return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (fresh: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(fresh)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    video.requestVideoFrameCallback(() => finish(true))
  })
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

function captureSourceRectangle(
  rectangle: Rectangle | undefined,
  viewport: { width: number; height: number },
  video: { width: number; height: number }
): Rectangle | null {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) return null
  if (!rectangle) return { x: 0, y: 0, width: video.width, height: video.height }
  if (
    ![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isFinite) ||
    rectangle.x < 0 ||
    rectangle.y < 0 ||
    rectangle.width <= 0 ||
    rectangle.height <= 0 ||
    rectangle.x + rectangle.width > viewport.width ||
    rectangle.y + rectangle.height > viewport.height
  ) return null
  const scaleX = video.width / viewport.width
  const scaleY = video.height / viewport.height
  const x = Math.max(0, Math.min(video.width - 1, Math.round(rectangle.x * scaleX)))
  const y = Math.max(0, Math.min(video.height - 1, Math.round(rectangle.y * scaleY)))
  const right = Math.max(x + 1, Math.min(video.width, Math.round((rectangle.x + rectangle.width) * scaleX)))
  const bottom = Math.max(y + 1, Math.min(video.height, Math.round((rectangle.y + rectangle.height) * scaleY)))
  return { x, y, width: right - x, height: bottom - y }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(fallback), timeoutMs)
    promise.then(finish, () => finish(fallback))
  })
}
