// @vitest-environment jsdom

import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FrozenCaptureContext } from '../src/shared/contracts/ipc'
import { FrozenFrame, LiveSurfaceReady } from '../src/renderer/capture-overlay/main'

describe('capture overlay first frame', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('announces readiness only after decode and a post-decode frame', async () => {
    let finishDecode!: () => void
    const animationFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    }))
    const decode = vi.fn(() => new Promise<void>((resolve) => { finishDecode = resolve }))
    const onReady = vi.fn()
    const { container } = render(<FrozenFrame context={context} onReady={onReady} />)
    const image = container.querySelector('img')!
    Object.defineProperty(image, 'decode', { configurable: true, value: decode })

    expect(onReady).not.toHaveBeenCalled()
    fireEvent.load(image)
    expect(decode).toHaveBeenCalledOnce()
    expect(onReady).not.toHaveBeenCalled()

    finishDecode()
    await waitFor(() => expect(animationFrames).toHaveLength(1))
    expect(onReady).not.toHaveBeenCalled()

    animationFrames.shift()!(0)
    expect(animationFrames).toHaveLength(1)
    expect(onReady).not.toHaveBeenCalled()

    animationFrames.shift()!(16)
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce())

    fireEvent.load(image)
    await Promise.resolve()
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('keeps the native overlay hidden until the requested appearance is painted', async () => {
    const animationFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    }))
    const decode = vi.fn(async () => undefined)
    const onReady = vi.fn()
    const { container, rerender } = render(
      <FrozenFrame appearanceReady={false} context={context} onReady={onReady} />
    )
    const image = container.querySelector('img')!
    Object.defineProperty(image, 'decode', { configurable: true, value: decode })

    fireEvent.load(image)
    await waitFor(() => expect(decode).toHaveBeenCalledOnce())
    expect(animationFrames).toHaveLength(0)
    expect(onReady).not.toHaveBeenCalled()

    rerender(<FrozenFrame appearanceReady context={context} onReady={onReady} />)
    await waitFor(() => expect(animationFrames).toHaveLength(1))
    animationFrames.shift()!(0)
    expect(animationFrames).toHaveLength(1)
    animationFrames.shift()!(16)

    await waitFor(() => expect(onReady).toHaveBeenCalledOnce())
  })

  it('announces a live transparent surface after appearance and two painted frames', async () => {
    const animationFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    }))
    const onReady = vi.fn()
    const { container, rerender } = render(<LiveSurfaceReady appearanceReady={false} onReady={onReady} />)

    expect(container.childElementCount).toBe(0)
    expect(animationFrames).toHaveLength(0)
    expect(onReady).not.toHaveBeenCalled()

    rerender(<LiveSurfaceReady appearanceReady onReady={onReady} />)
    await waitFor(() => expect(animationFrames).toHaveLength(1))
    animationFrames.shift()!(0)
    expect(onReady).not.toHaveBeenCalled()
    expect(animationFrames).toHaveLength(1)

    animationFrames.shift()!(16)
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce())
  })
})

const context: FrozenCaptureContext = {
  width: 1280,
  height: 720,
  minSelectionSize: 24,
  displayId: '1',
  surface: 'frozen',
  imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
  canEditBeforeSending: true
}
