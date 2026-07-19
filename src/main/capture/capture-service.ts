import { BrowserWindow, desktopCapturer, screen, type Display, type NativeImage } from 'electron'
import type { CaptureContext } from '@shared/contracts/ipc'
import type { Rectangle } from '@shared/types/geometry'
import { clampCropRectangle, logicalToPhysical } from './geometry'
import { loadRenderer, secureWindow } from '../windows/window-factory'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'

interface PendingCapture {
  display: Display
  image: NativeImage
  window: BrowserWindow
}

export interface CompletedCapture {
  imagePath: string
  selectedBounds: Rectangle
  display: Display
}

export class CaptureService {
  private pending: PendingCapture | null = null
  private cancellationTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly screenshots: TempScreenshotStore,
    private readonly onCompleted: (capture: CompletedCapture) => Promise<void>,
    private readonly onError: (message: string) => void
  ) {}

  async begin(): Promise<void> {
    if (this.pending) return
    const display = screen.getPrimaryDisplay()
    const requestedWidth = Math.max(1, Math.round(display.bounds.width * display.scaleFactor))
    const requestedHeight = Math.max(1, Math.round(display.bounds.height * display.scaleFactor))
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: requestedWidth, height: requestedHeight },
      fetchWindowIcons: false
    })
    const source = sources.find((entry) => entry.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) throw new Error('Windows did not provide a screen image to capture.')

    const overlay = secureWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: true,
      show: false,
      hasShadow: false
    })
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    overlay.setIgnoreMouseEvents(false)
    overlay.on('closed', () => {
      if (this.pending?.window === overlay) {
        this.pending = null
        this.clearCancellationTimer()
      }
    })
    overlay.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        this.cancel()
      }
    })
    overlay.webContents.once('did-fail-load', () => this.handleOverlayFailure(overlay))
    overlay.webContents.once('render-process-gone', () => this.handleOverlayFailure(overlay))
    this.pending = { display, image: source.thumbnail, window: overlay }
    this.startCancellationTimer()
    try {
      await loadRenderer(overlay, 'overlay')
      const rendererReady = await overlay.webContents.executeJavaScript(
        'Boolean(document.querySelector(".overlay"))'
      )
      if (!rendererReady) throw new Error('The capture overlay renderer did not initialise.')
      if (!overlay.isDestroyed()) {
        overlay.show()
        overlay.focus()
      }
    } catch {
      this.handleOverlayFailure(overlay)
    }
  }

  getContext(): CaptureContext {
    const pending = this.pending
    if (!pending) throw new Error('There is no active screen capture.')
    return {
      width: pending.display.bounds.width,
      height: pending.display.bounds.height,
      minSelectionSize: 24
    }
  }

  async select(rectangle: Rectangle): Promise<void> {
    const pending = this.pending
    if (!pending) return
    const bounded: Rectangle = {
      x: Math.max(0, Math.min(pending.display.bounds.width, rectangle.x)),
      y: Math.max(0, Math.min(pending.display.bounds.height, rectangle.y)),
      width: Math.max(0, rectangle.width),
      height: Math.max(0, rectangle.height)
    }
    bounded.width = Math.min(bounded.width, pending.display.bounds.width - bounded.x)
    bounded.height = Math.min(bounded.height, pending.display.bounds.height - bounded.y)
    if (bounded.width < 24 || bounded.height < 24) {
      this.onError('Select an area at least 24 × 24 pixels.')
      return
    }

    this.pending = null
    this.clearCancellationTimer()
    pending.window.hide()
    pending.window.close()
    const imageSize = pending.image.getSize()
    const physical = logicalToPhysical(
      bounded,
      imageSize.width / pending.display.bounds.width,
      imageSize.height / pending.display.bounds.height
    )
    const crop = clampCropRectangle(physical, imageSize)
    if (crop.width < 1 || crop.height < 1) throw new Error('The selected area was outside the captured image.')
    const imagePath = await this.screenshots.save(pending.image.crop(crop).toPNG())
    await this.onCompleted({ imagePath, selectedBounds: bounded, display: pending.display })
  }

  cancel(): void {
    const pending = this.pending
    this.pending = null
    this.clearCancellationTimer()
    if (pending && !pending.window.isDestroyed()) pending.window.close()
  }

  private handleOverlayFailure(overlay: BrowserWindow): void {
    if (this.pending?.window !== overlay) return
    this.cancel()
    this.onError('The screen selection overlay stopped responding. Please press the shortcut to try again.')
  }

  private startCancellationTimer(): void {
    this.clearCancellationTimer()
    this.cancellationTimer = setTimeout(() => {
      if (!this.pending) return
      this.cancel()
      this.onError('Screen selection timed out and was cancelled. Press the shortcut to try again.')
    }, 60_000)
  }

  private clearCancellationTimer(): void {
    if (!this.cancellationTimer) return
    clearTimeout(this.cancellationTimer)
    this.cancellationTimer = null
  }
}
