import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, nativeImage, screen } from 'electron'
import { IPC, type QuestionViewState, type WindowMaterial } from '../../shared/contracts/ipc'
import type { ConversationExchange, ConversationSegment, ConversationSelection, ProviderModelCapability, ResponsePhase } from '@shared/types/app'
import type { ProviderEvent } from '@shared/types/provider'
import type { CompletedCapture } from '../capture/capture-service'
import type { ProviderRegistry } from '../providers/provider-registry'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'
import { getWindowAppearanceOptions, selectWindowMaterial, type WindowSurfaceSizes } from './window-appearance'
import { openBrowserWindowWithChrome, WINDOW_CHROME_READY_TIMEOUT_MS } from './window-chrome'
import { loadRenderer, secureWindow } from './window-factory'
import { placeWindowAdjacentToSelection } from './window-geometry'

export const QUESTION_WINDOW_SIZES: WindowSurfaceSizes = { surfaceSize: { width: 480, height: 640 }, minimumSurfaceSize: { width: 400, height: 480 } }
export const QUESTION_WINDOW_READY_TIMEOUT_MS = WINDOW_CHROME_READY_TIMEOUT_MS

interface ProviderSegmentState { segment: ConversationSegment; conversationId: string | null; screenshotAttached: boolean }
interface QuestionSession {
  id: string; imagePath: string; thumbnailDataUrl: string; window: BrowserWindow | null; busy: boolean; cleaningUp: boolean
  phase: ResponsePhase; selection: ConversationSelection | null; exchanges: ConversationExchange[]; segments: ProviderSegmentState[]; disclosure: string | null
  models: ProviderModelCapability[]
}

export class QuestionSessions {
  private readonly sessions = new Map<string, QuestionSession>()
  constructor(private readonly providers: ProviderRegistry, private readonly screenshots: TempScreenshotStore, private readonly startNewCapture: () => Promise<void>) {}

  async open(capture: CompletedCapture): Promise<void> {
    const id = randomUUID(); const image = nativeImage.createFromPath(capture.imagePath)
    const session: QuestionSession = { id, imagePath: capture.imagePath, thumbnailDataUrl: image.resize({ width: Math.min(380, image.getSize().width), quality: 'good' }).toDataURL(), window: null, busy: false, cleaningUp: false, phase: 'idle', selection: null, exchanges: [], segments: [], disclosure: null, models: [] }
    this.sessions.set(id, session)
    const initialSelection = this.selectInitial(session)
    const material = selectWindowMaterial({ disableTransparentWindows: app.commandLine.hasSwitch('disable-transparent-windows') })
    try {
      const opened = await openBrowserWindowWithChrome({ kind: 'question', label: 'Question window', initialMaterial: material, surfaceSize: QUESTION_WINDOW_SIZES.surfaceSize, minimumSurfaceSize: QUESTION_WINDOW_SIZES.minimumSurfaceSize, screenSource: screen, timeoutMs: QUESTION_WINDOW_READY_TIMEOUT_MS, createWindow: (attempt) => this.createQuestionWindow(capture, session, attempt), loadRenderer: async (window) => { await initialSelection; await loadRenderer(window, 'question', { session: id }) }, isWindowCurrent: (window) => this.sessions.get(id) === session && session.window === window, beforeRetry: (window) => { if (session.window === window) session.window = null } })
      if (session.window === opened.window && !opened.window.isDestroyed()) opened.window.focus()
    } catch (error) { await this.cleanup(id); throw error }
  }

  get(id: string): QuestionViewState {
    const session = this.requireSession(id)
    return { sessionId: id, thumbnailDataUrl: session.thumbnailDataUrl, phase: session.phase, exchanges: structuredClone(session.exchanges), segments: session.segments.map((item) => structuredClone(item.segment)), selection: session.selection ? structuredClone(session.selection) : null, profiles: this.providers.listProfiles(), models: structuredClone(session.models), disclosure: session.disclosure, busy: session.busy }
  }

  async setSelection(id: string, selection: ConversationSelection): Promise<QuestionViewState> {
    const session = this.requireSession(id)
    if (session.busy) throw new Error('Stop the current response before changing provider settings.')
    await this.providers.validateSelection(selection)
    session.models = await this.providers.listModels(selection.profileId)
    const previous = session.selection
    const providerChanged = Boolean(previous && (previous.profileId !== selection.profileId || previous.provider !== selection.provider))
    session.selection = structuredClone(selection)
    if (providerChanged || !session.segments.length) this.startSegment(session, providerChanged)
    return this.get(id)
  }

  async send(id: string, text: string): Promise<void> {
    const session = this.requireSession(id); const question = text.trim()
    if (!question) throw new Error('Type a question first.'); if (question.length > 10_000) throw new Error('The question is too long.'); if (session.busy) throw new Error('Wait for the current answer or press Stop.'); if (!session.selection) throw new Error('Choose an authenticated provider profile and model first.')
    await this.providers.validateSelection(session.selection)
    let providerSegment = session.segments.at(-1); if (!providerSegment) { this.startSegment(session, false); providerSegment = session.segments.at(-1)! }
    if (!providerSegment.conversationId) providerSegment.conversationId = await this.providers.createConversation(session.selection)
    const exchange: ConversationExchange = { id: randomUUID(), question, answer: '', phase: 'connecting', segmentId: providerSegment.segment.id }
    session.exchanges.push(exchange); session.busy = true; this.setPhase(session, exchange, 'connecting')
    try {
      const attachScreenshot = !providerSegment.screenshotAttached
      providerSegment.screenshotAttached = true
      for await (const event of this.providers.send(providerSegment.conversationId, session.selection, { text: question, imagePath: attachScreenshot ? session.imagePath : undefined })) {
        if (event.type === 'started') this.setPhase(session, exchange, 'thinking')
        if (event.type === 'delta') { exchange.answer += event.text; this.setPhase(session, exchange, 'streaming') }
        if (event.type === 'completed') this.setPhase(session, exchange, 'completed')
        if (event.type === 'cancelled') this.setPhase(session, exchange, 'stopped')
        if (event.type === 'error') { exchange.error = event.message; this.setPhase(session, exchange, 'failed') }
        this.emit(session, event)
      }
    } catch (error) { const message = error instanceof Error ? error.message : String(error); exchange.error = message; this.setPhase(session, exchange, 'failed'); this.emit(session, { type: 'error', message }) }
    finally { session.busy = false }
  }

  async stop(id: string): Promise<void> { const session = this.requireSession(id); const segment = session.segments.at(-1); if (session.selection && segment?.conversationId) await this.providers.cancel(segment.conversationId, session.selection.provider); session.phase = 'stopped'; session.busy = false }
  async close(id: string): Promise<void> { const session = this.requireSession(id); if (session.window && !session.window.isDestroyed()) session.window.close(); await this.cleanup(id) }
  async newSnip(id: string): Promise<void> { await this.close(id); await this.startNewCapture() }
  async dispose(): Promise<void> { await Promise.all([...this.sessions.keys()].map((id) => this.cleanup(id))) }

  private async selectInitial(session: QuestionSession): Promise<void> {
    const profiles = this.providers.listProfiles(); const profile = profiles.find((item) => item.isDefault) ?? profiles[0]; if (!profile) return
    const models = await this.safeModels(profile.id); session.models = models; const model = models.find((item) => item.id === profile.defaultModelId) ?? models.find((item) => item.isDefault) ?? models[0]; if (!model) return
    session.selection = { profileId: profile.id, provider: profile.provider, modelId: model.id, reasoningEffort: profile.defaultReasoningEffort && model.supportedReasoningEfforts.includes(profile.defaultReasoningEffort) ? profile.defaultReasoningEffort : model.defaultReasoningEffort ?? null }
    this.startSegment(session, false)
  }
  private startSegment(session: QuestionSession, switchedProvider: boolean): void {
    if (!session.selection) return
    const disclosure = switchedProvider ? 'Provider changed. The new provider receives the screenshot once and only messages sent from this point; earlier transcript remains local.' : null
    const segment: ConversationSegment = { id: randomUUID(), selection: structuredClone(session.selection), startedAt: new Date().toISOString(), disclosure }
    session.segments.push({ segment, conversationId: null, screenshotAttached: false }); session.disclosure = disclosure
  }
  private setPhase(session: QuestionSession, exchange: ConversationExchange, phase: ResponsePhase): void { session.phase = phase; exchange.phase = phase }
  private async safeModels(profileId: string): Promise<ProviderModelCapability[]> { try { return await this.providers.listModels(profileId) } catch { return [] } }
  private emit(session: QuestionSession, event: ProviderEvent): void { if (session.window && !session.window.isDestroyed()) session.window.webContents.send(IPC.questionEvent, session.id, event) }
  private createQuestionWindow(capture: CompletedCapture, session: QuestionSession, material: WindowMaterial): BrowserWindow {
    const appearance = getWindowAppearanceOptions(QUESTION_WINDOW_SIZES, material, capture.display.workArea)
    const selection = { x: capture.display.bounds.x + capture.selectedBounds.x, y: capture.display.bounds.y + capture.selectedBounds.y, width: capture.selectedBounds.width, height: capture.selectedBounds.height }
    const placement = placeWindowAdjacentToSelection(selection, appearance.size, capture.display.workArea)
    const window = secureWindow({ x: placement.x, y: placement.y, width: placement.width, height: placement.height, minWidth: appearance.minimumSize.width, minHeight: appearance.minimumSize.height, frame: appearance.frame, transparent: appearance.transparent, backgroundColor: appearance.backgroundColor, show: appearance.show, useContentSize: appearance.useContentSize, hasShadow: appearance.hasShadow, resizable: appearance.resizable, maximizable: appearance.maximizable, minimizable: appearance.minimizable, closable: appearance.closable, movable: appearance.movable, fullscreenable: appearance.fullscreenable, thickFrame: appearance.thickFrame, roundedCorners: appearance.roundedCorners, alwaysOnTop: true, skipTaskbar: false, title: 'Fovea', autoHideMenuBar: true })
    session.window = window; window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.once('closed', () => { if (session.window === window) void this.cleanup(session.id) }); return window
  }
  private requireSession(id: string): QuestionSession { const session = this.sessions.get(id); if (!session) throw new Error('This capture session has already closed.'); return session }
  private async cleanup(id: string): Promise<void> { const session = this.sessions.get(id); if (!session || session.cleaningUp) return; session.cleaningUp = true; this.sessions.delete(id); await this.screenshots.delete(session.imagePath); await Promise.all(session.segments.flatMap((item) => item.conversationId ? [this.providers.deleteConversation(item.conversationId, item.segment.selection.provider).catch(() => undefined)] : [])) }
}
