import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, nativeImage, screen } from 'electron'
import type { ProviderEvent } from '@shared/types/provider'
import type { QuestionViewState, WindowMaterial } from '@shared/contracts/ipc'
import type { CompletedCapture } from '../capture/capture-service'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'
import type { CodexAppServerProvider } from '../providers/codex-app-server/codex-app-server-provider'
import {
  getWindowAppearanceOptions,
  selectWindowMaterial,
  type WindowSurfaceSizes
} from './window-appearance'
import {
  openBrowserWindowWithChrome,
  WINDOW_CHROME_READY_TIMEOUT_MS
} from './window-chrome'
import { loadRenderer, secureWindow } from './window-factory'
import { placeWindowAdjacentToSelection } from './window-geometry'

export const QUESTION_WINDOW_SIZES: WindowSurfaceSizes = {
  surfaceSize: { width: 480, height: 640 },
  minimumSurfaceSize: { width: 400, height: 480 }
}

export const QUESTION_WINDOW_READY_TIMEOUT_MS = WINDOW_CHROME_READY_TIMEOUT_MS

interface QuestionSession {
  id: string
  imagePath: string
  thumbnailDataUrl: string
  window: BrowserWindow | null
  conversationId: string | null
  busy: boolean
  cleaningUp: boolean
}

export class QuestionSessions {
  private readonly sessions = new Map<string, QuestionSession>()

  constructor(
    private readonly provider: CodexAppServerProvider,
    private readonly screenshots: TempScreenshotStore,
    private readonly startNewCapture: () => Promise<void>
  ) {}

  async open(capture: CompletedCapture): Promise<void> {
    const id = randomUUID()
    const image = nativeImage.createFromPath(capture.imagePath)
    const thumbnail = image.resize({ width: Math.min(340, image.getSize().width), quality: 'good' }).toDataURL()
    const session: QuestionSession = {
      id,
      imagePath: capture.imagePath,
      thumbnailDataUrl: thumbnail,
      window: null,
      conversationId: null,
      busy: false,
      cleaningUp: false
    }
    this.sessions.set(id, session)

    const material = selectWindowMaterial({
      disableTransparentWindows: app.commandLine.hasSwitch('disable-transparent-windows')
    })
    try {
      const opened = await openBrowserWindowWithChrome({
        kind: 'question',
        label: 'Question window',
        initialMaterial: material,
        surfaceSize: QUESTION_WINDOW_SIZES.surfaceSize,
        minimumSurfaceSize: QUESTION_WINDOW_SIZES.minimumSurfaceSize,
        screenSource: screen,
        timeoutMs: QUESTION_WINDOW_READY_TIMEOUT_MS,
        createWindow: (attemptMaterial) =>
          this.createQuestionWindow(capture, session, attemptMaterial),
        loadRenderer: (window) => loadRenderer(window, 'question', { session: id }),
        isWindowCurrent: (window) =>
          this.sessions.get(id) === session && session.window === window,
        beforeRetry: (window) => {
          if (session.window === window) session.window = null
        }
      })
      if (session.window === opened.window && !opened.window.isDestroyed()) opened.window.focus()
    } catch (error) {
      await this.cleanup(id)
      throw error
    }
  }

  get(id: string): QuestionViewState {
    const session = this.requireSession(id)
    return { sessionId: id, thumbnailDataUrl: session.thumbnailDataUrl, busy: session.busy }
  }

  async send(id: string, text: string): Promise<void> {
    const session = this.requireSession(id)
    const question = text.trim()
    if (!question) throw new Error('Type a question first.')
    if (question.length > 10_000) throw new Error('The question is too long.')
    if (session.busy) throw new Error('Wait for the current answer or press Stop.')
    session.busy = true
    const isInitial = !session.conversationId
    try {
      if (!session.conversationId) session.conversationId = await this.provider.createConversation()
      for await (const event of this.provider.sendMessage(session.conversationId, {
        text: question,
        imagePath: isInitial ? session.imagePath : undefined
      })) {
        this.emit(session, event)
      }
    } catch (error) {
      this.emit(session, { type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      session.busy = false
    }
  }

  async stop(id: string): Promise<void> {
    const session = this.requireSession(id)
    if (session.conversationId) await this.provider.cancel(session.conversationId)
  }

  async close(id: string): Promise<void> {
    const session = this.requireSession(id)
    if (session.window && !session.window.isDestroyed()) session.window.close()
    await this.cleanup(id)
  }

  async newSnip(id: string): Promise<void> {
    await this.close(id)
    await this.startNewCapture()
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.cleanup(id)))
  }

  private emit(session: QuestionSession, event: ProviderEvent): void {
    if (session.window && !session.window.isDestroyed()) {
      session.window.webContents.send('question:event', session.id, event)
    }
  }

  private createQuestionWindow(
    capture: CompletedCapture,
    session: QuestionSession,
    material: WindowMaterial
  ): BrowserWindow {
    const appearance = getWindowAppearanceOptions(
      QUESTION_WINDOW_SIZES,
      material,
      capture.display.workArea
    )
    const absoluteSelection = {
      x: capture.display.bounds.x + capture.selectedBounds.x,
      y: capture.display.bounds.y + capture.selectedBounds.y,
      width: capture.selectedBounds.width,
      height: capture.selectedBounds.height
    }
    const placement = placeWindowAdjacentToSelection(
      absoluteSelection,
      appearance.size,
      capture.display.workArea
    )
    const window = secureWindow({
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      minWidth: appearance.minimumSize.width,
      minHeight: appearance.minimumSize.height,
      frame: appearance.frame,
      transparent: appearance.transparent,
      backgroundColor: appearance.backgroundColor,
      show: appearance.show,
      useContentSize: appearance.useContentSize,
      hasShadow: appearance.hasShadow,
      resizable: appearance.resizable,
      maximizable: appearance.maximizable,
      minimizable: appearance.minimizable,
      closable: appearance.closable,
      movable: appearance.movable,
      fullscreenable: appearance.fullscreenable,
      thickFrame: appearance.thickFrame,
      roundedCorners: appearance.roundedCorners,
      alwaysOnTop: true,
      skipTaskbar: false,
      title: 'SnipChat',
      autoHideMenuBar: true
    })
    session.window = window
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.once('closed', () => {
      if (session.window === window) void this.cleanup(session.id)
    })
    return window
  }

  private requireSession(id: string): QuestionSession {
    const session = this.sessions.get(id)
    if (!session) throw new Error('This snip session has already closed.')
    return session
  }

  private async cleanup(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.cleaningUp) return
    session.cleaningUp = true
    this.sessions.delete(id)
    await this.screenshots.delete(session.imagePath)
    if (session.conversationId) await this.provider.deleteConversation(session.conversationId).catch(() => undefined)
  }
}
