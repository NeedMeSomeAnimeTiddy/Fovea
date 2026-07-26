import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureDestination, CompletedCapture } from '../src/main/capture/capture-service'

const mocks = vi.hoisted(() => {
  const preview = { toDataURL: vi.fn(() => 'data:image/png;base64,preview') }
  const image = {
    getSize: vi.fn(() => ({ width: 840, height: 440 })),
    isEmpty: vi.fn(() => false),
    resize: vi.fn(() => preview),
    toDataURL: vi.fn(() => 'data:image/png;base64,original')
  }
  return {
    createFromPath: vi.fn(() => image),
    image,
    preview
  }
})

vi.mock('electron', () => ({
  nativeImage: { createFromPath: mocks.createFromPath }
}))

describe('onboarding capture controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.image.isEmpty.mockReturnValue(false)
    mocks.image.getSize.mockReturnValue({ width: 840, height: 440 })
    mocks.image.resize.mockReturnValue(mocks.preview)
    mocks.preview.toDataURL.mockReturnValue('data:image/png;base64,preview')
  })

  it('routes a region capture to a private thumbnail, deletes its path, and restores Settings', async () => {
    let destination!: CaptureDestination
    const capture = { begin: vi.fn(async (_mode, nextDestination) => { destination = nextDestination }) }
    const screenshots = { delete: vi.fn(async () => undefined) }
    const restoreSettings = vi.fn(async () => undefined)
    const { OnboardingController } = await import('../src/main/onboarding/onboarding-controller')
    const controller = new OnboardingController(capture as never, screenshots as never, restoreSettings)

    const result = controller.testCapture()
    await vi.waitFor(() => expect(capture.begin).toHaveBeenCalled())
    await destination.onCompleted(completedCapture())

    await expect(result).resolves.toEqual({ status: 'captured', thumbnailDataUrl: 'data:image/png;base64,preview' })
    expect(capture.begin).toHaveBeenCalledWith('region', destination)
    expect(mocks.createFromPath).toHaveBeenCalledWith('C:\\temp\\onboarding.png')
    expect(mocks.image.resize).toHaveBeenCalledWith({ width: 420, height: 220, quality: 'good' })
    expect(screenshots.delete).toHaveBeenCalledWith('C:\\temp\\onboarding.png')
    expect(restoreSettings).toHaveBeenCalledTimes(1)
  })

  it('restores Settings and returns a neutral result after cancellation', async () => {
    let destination!: CaptureDestination
    const capture = { begin: vi.fn(async (_mode, nextDestination) => { destination = nextDestination }) }
    const restoreSettings = vi.fn(async () => undefined)
    const { OnboardingController } = await import('../src/main/onboarding/onboarding-controller')
    const controller = new OnboardingController(capture as never, { delete: vi.fn() } as never, restoreSettings)

    const result = controller.testCapture()
    await vi.waitFor(() => expect(capture.begin).toHaveBeenCalled())
    await Promise.resolve()
    destination.onCancelled?.()

    await expect(result).resolves.toEqual({ status: 'cancelled' })
    expect(restoreSettings).toHaveBeenCalledTimes(1)
  })

  it('deletes the temporary image even when preview creation fails', async () => {
    let destination!: CaptureDestination
    const capture = { begin: vi.fn(async (_mode, nextDestination) => { destination = nextDestination }) }
    const screenshots = { delete: vi.fn(async () => undefined) }
    const restoreSettings = vi.fn(async () => undefined)
    mocks.image.isEmpty.mockReturnValue(true)
    const { OnboardingController } = await import('../src/main/onboarding/onboarding-controller')
    const controller = new OnboardingController(capture as never, screenshots as never, restoreSettings)

    const result = controller.testCapture()
    await vi.waitFor(() => expect(capture.begin).toHaveBeenCalled())
    await destination.onCompleted(completedCapture())

    await expect(result).rejects.toThrow(/preview could not be created/i)
    expect(screenshots.delete).toHaveBeenCalledWith('C:\\temp\\onboarding.png')
    expect(restoreSettings).toHaveBeenCalledTimes(1)
  })

  it('allows startup only for pending onboarding', async () => {
    const { shouldShowOnboardingAtStartup } = await import('../src/main/onboarding/onboarding-controller')
    expect(shouldShowOnboardingAtStartup('pending')).toBe(true)
    expect(shouldShowOnboardingAtStartup('skipped')).toBe(false)
    expect(shouldShowOnboardingAtStartup('completed')).toBe(false)
  })
})

function completedCapture(): CompletedCapture {
  return {
    imagePath: 'C:\\temp\\onboarding.png',
    selectedBounds: { x: 10, y: 10, width: 100, height: 80 },
    display: {} as CompletedCapture['display']
  }
}
