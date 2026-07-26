import { nativeImage } from 'electron'
import type { OnboardingTestCaptureResult } from '@shared/contracts/ipc'
import type { OnboardingStatus } from '@shared/types/app'
import type { CaptureDestination, CaptureService, CompletedCapture } from '../capture/capture-service'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'

const PREVIEW_MAX_WIDTH = 420
const PREVIEW_MAX_HEIGHT = 220

export class OnboardingController {
  private activeCapture: Promise<OnboardingTestCaptureResult> | null = null

  constructor(
    private readonly capture: CaptureService,
    private readonly screenshots: TempScreenshotStore,
    private readonly restoreSettings: () => Promise<void>
  ) {}

  async testCapture(): Promise<OnboardingTestCaptureResult> {
    if (this.activeCapture) throw new Error('A test capture is already in progress.')
    const capture = this.beginTestCapture()
    this.activeCapture = capture
    try {
      return await capture
    } finally {
      if (this.activeCapture === capture) this.activeCapture = null
    }
  }

  private beginTestCapture(): Promise<OnboardingTestCaptureResult> {
    return new Promise((resolve, reject) => {
      let captureStarted = false
      let cancelledDuringStartup = false
      let settled = false

      const settle = async (result: OnboardingTestCaptureResult): Promise<void> => {
        if (settled) return
        settled = true
        try {
          await this.restoreSettings()
          resolve(result)
        } catch (error) {
          reject(error)
        }
      }
      const fail = async (error: unknown): Promise<void> => {
        if (settled) return
        settled = true
        try {
          await this.restoreSettings()
          reject(error)
        } catch (restoreError) {
          reject(restoreError)
        }
      }
      const destination: CaptureDestination = {
        onCompleted: async (completed) => {
          try {
            const thumbnailDataUrl = await this.createThumbnailAndDelete(completed)
            await settle({ status: 'captured', thumbnailDataUrl })
          } catch (error) {
            await fail(error)
          }
        },
        onCancelled: () => {
          if (!captureStarted) {
            cancelledDuringStartup = true
            return
          }
          void settle({ status: 'cancelled' })
        }
      }

      void this.capture.begin('region', destination).then(() => {
        captureStarted = true
        if (cancelledDuringStartup) void settle({ status: 'cancelled' })
      }).catch((error) => void fail(error))
    })
  }

  private async createThumbnailAndDelete(completed: CompletedCapture): Promise<string> {
    try {
      const image = nativeImage.createFromPath(completed.imagePath)
      if (image.isEmpty()) throw new Error('The test capture preview could not be created.')
      const size = image.getSize()
      const scale = Math.min(1, PREVIEW_MAX_WIDTH / size.width, PREVIEW_MAX_HEIGHT / size.height)
      const preview = scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: 'good'
          })
        : image
      return preview.toDataURL()
    } finally {
      await this.screenshots.delete(completed.imagePath)
    }
  }
}

export function shouldShowOnboardingAtStartup(status: OnboardingStatus): boolean {
  return status === 'pending'
}
