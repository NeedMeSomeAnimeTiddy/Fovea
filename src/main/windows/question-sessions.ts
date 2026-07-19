import { randomUUID } from 'node:crypto'
import { BrowserWindow, nativeImage } from 'electron'
import type { ProviderEvent } from '@shared/types/provider'
import type { QuestionViewState } from '@shared/contracts/ipc'
import type { CompletedCapture } from '../capture/capture-service'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'
import type { CodexAppServerProvider } from '../providers/codex-app-server/codex-app-server-provider'
import { WINDOW_BACKGROUND_COLOR } from './window-appearance'
import { loadRenderer, secureWindow } from './window-factory'

interface QuestionSession {
  id: string
  imagePath: string
  thumbnailDataUrl: string
  window: BrowserWindow
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
    const width = 480
    const height = 640
    const work = capture.display.workArea
    const absoluteSelection = {
      x: capture.display.bounds.x + capture.selectedBounds.x,
      y: capture.display.bounds.y + capture.selectedBounds.y,
      width: capture.selectedBounds.width,
      height: capture.selectedBounds.height
    }
    let x = Math.round(absoluteSelection.x + absoluteSelection.width + 12)
    if (x + width > work.x + work.width) x = Math.round(absoluteSelection.x - width - 12)
    x = Math.max(work.x, Math.min(x, work.x + work.width - width))
    let y = Math.round(absoluteSelection.y)
    y = Math.max(work.y, Math.min(y, work.y + work.height - height))

    const window = secureWindow({
      x,
      y,
      width,
      height,
      minWidth: 400,
      minHeight: 480,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      show: false,
      backgroundColor: WINDOW_BACKGROUND_COLOR,
      title: 'SnipChat'
    })
    const session: QuestionSession = {
      id,
      imagePath: capture.imagePath,
      thumbnailDataUrl: thumbnail,
      window,
      conversationId: null,
      busy: false,
      cleaningUp: false
    }
    this.sessions.set(id, session)
    window.on('closed', () => void this.cleanup(id))
    await loadRenderer(window, 'question', { session: id })
    window.show()
    window.focus()
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
    if (!session.window.isDestroyed()) session.window.close()
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
    if (!session.window.isDestroyed()) session.window.webContents.send('question:event', session.id, event)
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
