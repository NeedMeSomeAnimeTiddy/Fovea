import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BrowserWindow, desktopCapturer, screen, type DesktopCapturerSource, type Display, type NativeImage } from 'electron'
import type { CaptureContext } from '@shared/contracts/ipc'
import type { CaptureMode } from '@shared/types/app'
import type { Rectangle } from '@shared/types/geometry'
import { clampCropRectangle, logicalToPhysical } from './geometry'
import { loadRenderer, secureWindow } from '../windows/window-factory'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'

const execFileAsync = promisify(execFile)

interface PendingDisplay { display: Display; image: NativeImage; window: BrowserWindow }
interface CaptureDescriptor { mode: CaptureMode; displayId?: number; rectangle?: Rectangle; sourceId?: string }
interface PendingCapture { candidates: Map<number, PendingDisplay>; topology: string }

export interface CompletedCapture { imagePath: string; selectedBounds: Rectangle; display: Display }

export class CaptureService {
  private pending: PendingCapture | null = null
  private lastDescriptor: CaptureDescriptor | null = null
  private cancellationTimer: NodeJS.Timeout | null = null

  constructor(private readonly screenshots: TempScreenshotStore, private readonly onCompleted: (capture: CompletedCapture) => Promise<void>, private readonly onError: (message: string) => void) {
    screen.on('display-added', this.cancelForTopologyChange)
    screen.on('display-removed', this.cancelForTopologyChange)
    screen.on('display-metrics-changed', this.cancelForTopologyChange)
  }

  async begin(mode: CaptureMode = 'region'): Promise<void> {
    if (this.pending) return
    if (mode === 'repeat-last') {
      if (!this.lastDescriptor) throw new Error('There is no previous capture to repeat.')
      return this.dispatchDescriptor(this.lastDescriptor)
    }
    if (mode === 'display') return this.captureDisplay()
    if (mode === 'window') return this.captureFocusedWindow()
    return this.beginRegion()
  }

  getContext(senderWebContentsId?: number): CaptureContext {
    const candidate = this.findCandidate(senderWebContentsId)
    return { width: candidate.display.bounds.width, height: candidate.display.bounds.height, minSelectionSize: 24, displayId: String(candidate.display.id) }
  }

  async select(rectangle: Rectangle, senderWebContentsId?: number): Promise<void> {
    const candidate = this.findCandidate(senderWebContentsId)
    const bounded = boundRectangle(rectangle, candidate.display.bounds.width, candidate.display.bounds.height)
    if (bounded.width < 24 || bounded.height < 24) throw new Error('Select an area at least 24 × 24 pixels.')
    this.lastDescriptor = { mode: 'region', displayId: candidate.display.id, rectangle: bounded }
    await this.complete(candidate, bounded)
  }

  cancel(): void {
    const pending = this.pending
    this.pending = null
    this.clearCancellationTimer()
    for (const candidate of pending?.candidates.values() ?? []) if (!candidate.window.isDestroyed()) candidate.window.close()
  }

  dispose(): void {
    this.cancel()
    screen.off('display-added', this.cancelForTopologyChange)
    screen.off('display-removed', this.cancelForTopologyChange)
    screen.off('display-metrics-changed', this.cancelForTopologyChange)
  }

  private async beginRegion(descriptor?: CaptureDescriptor): Promise<void> {
    const displays = screen.getAllDisplays()
    const topology = displays.map((display) => `${display.id}:${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}:${display.scaleFactor}`).sort().join('|')
    const maxWidth = Math.max(...displays.map((display) => Math.round(display.bounds.width * display.scaleFactor)))
    const maxHeight = Math.max(...displays.map((display) => Math.round(display.bounds.height * display.scaleFactor)))
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxWidth, height: maxHeight }, fetchWindowIcons: false })
    if (topology !== this.currentTopology()) throw new Error('Display configuration changed; capture was cancelled.')
    const candidates = new Map<number, PendingDisplay>()
    for (const display of displays) {
      if (descriptor?.displayId && descriptor.displayId !== display.id) continue
      const source = sources.find((entry) => entry.display_id === String(display.id))
      if (!source || source.thumbnail.isEmpty()) continue
      const overlay = this.createOverlay(display)
      candidates.set(overlay.webContents.id, { display, image: source.thumbnail, window: overlay })
    }
    if (!candidates.size) throw new Error('Windows did not provide any screen images to capture.')
    this.pending = { candidates, topology }
    this.startCancellationTimer()
    try {
      await Promise.all([...candidates.values()].map(async (candidate) => {
        await loadRenderer(candidate.window, 'overlay')
        if (!candidate.window.isDestroyed()) { candidate.window.show(); candidate.window.focus() }
      }))
      if (descriptor?.rectangle) await this.select(descriptor.rectangle, [...candidates.keys()][0])
    } catch (error) { this.cancel(); throw error }
  }

  private async captureDisplay(descriptor?: CaptureDescriptor): Promise<void> {
    const display = descriptor?.displayId ? screen.getAllDisplays().find((item) => item.id === descriptor.displayId) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    if (!display) throw new Error('The previous display is no longer connected.')
    const image = await this.captureScreenImage(display)
    const selectedBounds = { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height }
    this.lastDescriptor = { mode: 'display', displayId: display.id }
    await this.saveCompleted(display, image, selectedBounds)
  }

  private async captureFocusedWindow(descriptor?: CaptureDescriptor): Promise<void> {
    const target = descriptor?.sourceId ? { sourceId: descriptor.sourceId, processId: 0 } : await getForegroundTarget()
    if (target.processId === process.pid) throw new Error('Fovea cannot capture one of its own windows.')
    const ownHandles = new Set(BrowserWindow.getAllWindows().map((window) => window.getNativeWindowHandle().toString('hex').replace(/^0+/, '').toLowerCase()))
    const targetHandle = target.sourceId.split(':')[1]?.replace(/^0+/, '').toLowerCase()
    if (!targetHandle || ownHandles.has(targetHandle)) throw new Error('Fovea cannot capture one of its own windows.')
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 3840, height: 2160 }, fetchWindowIcons: false })
    const source = sources.find((candidate) => sourceHandle(candidate) === targetHandle)
    if (!source || source.thumbnail.isEmpty() || isBlank(source.thumbnail)) throw new Error('The focused window is minimized, protected, empty, or unavailable.')
    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    const size = source.thumbnail.getSize()
    const selectedBounds = { x: 0, y: 0, width: size.width, height: size.height }
    this.lastDescriptor = { mode: 'window', sourceId: source.id }
    await this.saveCompleted(display, source.thumbnail, selectedBounds)
  }

  private async dispatchDescriptor(descriptor: CaptureDescriptor): Promise<void> {
    if (descriptor.mode === 'region') return this.beginRegion(descriptor)
    if (descriptor.mode === 'display') return this.captureDisplay(descriptor)
    if (descriptor.mode === 'window') return this.captureFocusedWindow(descriptor)
  }

  private createOverlay(display: Display): BrowserWindow {
    const overlay = secureWindow({ x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, focusable: true, show: false, hasShadow: false })
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    overlay.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); this.cancel() } })
    overlay.webContents.once('render-process-gone', () => { this.cancel(); this.onError('The screen selection overlay stopped responding.') })
    return overlay
  }

  private async captureScreenImage(display: Display): Promise<NativeImage> {
    const width = Math.max(1, Math.round(display.bounds.width * display.scaleFactor))
    const height = Math.max(1, Math.round(display.bounds.height * display.scaleFactor))
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false })
    const source = sources.find((entry) => entry.display_id === String(display.id))
    if (!source || source.thumbnail.isEmpty() || isBlank(source.thumbnail)) throw new Error('Windows did not provide a usable display image.')
    return source.thumbnail
  }

  private findCandidate(senderWebContentsId?: number): PendingDisplay {
    if (!this.pending) throw new Error('There is no active screen capture.')
    const candidate = senderWebContentsId ? this.pending.candidates.get(senderWebContentsId) : [...this.pending.candidates.values()][0]
    if (!candidate) throw new Error('This overlay does not own a captured display.')
    return candidate
  }

  private async complete(candidate: PendingDisplay, bounded: Rectangle): Promise<void> {
    const imageSize = candidate.image.getSize()
    const physical = logicalToPhysical(bounded, imageSize.width / candidate.display.bounds.width, imageSize.height / candidate.display.bounds.height)
    const crop = clampCropRectangle(physical, imageSize)
    if (crop.width < 1 || crop.height < 1) throw new Error('The selected area was outside the captured image.')
    this.cancel()
    await this.saveCompleted(candidate.display, candidate.image.crop(crop), bounded)
  }

  private async saveCompleted(display: Display, image: NativeImage, selectedBounds: Rectangle): Promise<void> {
    const imagePath = await this.screenshots.save(image.toPNG())
    await this.onCompleted({ imagePath, selectedBounds, display })
  }

  private readonly cancelForTopologyChange = (): void => { if (this.pending && this.pending.topology !== this.currentTopology()) { this.cancel(); this.onError('Display configuration changed; capture was cancelled cleanly.') } }
  private currentTopology(): string { return screen.getAllDisplays().map((display) => `${display.id}:${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}:${display.scaleFactor}`).sort().join('|') }
  private startCancellationTimer(): void { this.clearCancellationTimer(); this.cancellationTimer = setTimeout(() => { this.cancel(); this.onError('Screen selection timed out and was cancelled.') }, 60_000) }
  private clearCancellationTimer(): void { if (this.cancellationTimer) clearTimeout(this.cancellationTimer); this.cancellationTimer = null }
}

function boundRectangle(rectangle: Rectangle, width: number, height: number): Rectangle {
  const x = Math.max(0, Math.min(width, rectangle.x)); const y = Math.max(0, Math.min(height, rectangle.y))
  return { x, y, width: Math.max(0, Math.min(rectangle.width, width - x)), height: Math.max(0, Math.min(rectangle.height, height - y)) }
}
function sourceHandle(source: DesktopCapturerSource): string { return source.id.split(':')[1]?.replace(/^0+/, '').toLowerCase() ?? '' }
function isBlank(image: NativeImage): boolean { const bitmap = image.resize({ width: 8, height: 8 }).toBitmap(); if (bitmap.length < 4) return true; const first = bitmap.subarray(0, 3).toString('hex'); for (let offset = 4; offset < bitmap.length; offset += 4) if (bitmap.subarray(offset, offset + 3).toString('hex') !== first) return false; return true }

async function getForegroundTarget(): Promise<{ sourceId: string; processId: number }> {
  const script = '$s=@"\nusing System;using System.Runtime.InteropServices;public static class F{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}\n"@;Add-Type $s;$h=[F]::GetForegroundWindow();[uint32]$p=0;[void][F]::GetWindowThreadProcessId($h,[ref]$p);@{sourceId=("window:{0:x}:0" -f $h.ToInt64());processId=$p}|ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout: 3_000, maxBuffer: 8_192 })
  const result = JSON.parse(stdout) as { sourceId?: unknown; processId?: unknown }
  if (typeof result.sourceId !== 'string' || !/^window:[0-9a-f]+:0$/i.test(result.sourceId) || typeof result.processId !== 'number') throw new Error('Could not resolve the focused window.')
  return { sourceId: result.sourceId, processId: result.processId }
}
