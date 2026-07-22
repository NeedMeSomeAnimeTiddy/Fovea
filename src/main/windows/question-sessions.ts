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
const WEB_SEARCH_REQUEST_PREFIX = '<fovea-web-search-request>'
const WEB_SEARCH_APPROVED_PREFIX = '[FOVEA_WEB_SEARCH_APPROVED]'

interface ProviderSegmentState { segment: ConversationSegment; conversationId: string | null; screenshotAttached: boolean }
interface QuestionSession {
  id: string; imagePath: string; thumbnailDataUrl: string; window: BrowserWindow | null; busy: boolean; cleaningUp: boolean
  phase: ResponsePhase; selection: ConversationSelection | null; exchanges: ConversationExchange[]; segments: ProviderSegmentState[]; disclosure: string | null
  models: ProviderModelCapability[]; initialization: Promise<void>
}

export class QuestionSessions {
  private readonly sessions = new Map<string, QuestionSession>()
  constructor(private readonly providers: ProviderRegistry, private readonly screenshots: TempScreenshotStore, private readonly startNewCapture: () => Promise<void>) {}

  async open(capture: CompletedCapture): Promise<void> {
    const id = randomUUID(); const image = nativeImage.createFromPath(capture.imagePath)
    const session: QuestionSession = { id, imagePath: capture.imagePath, thumbnailDataUrl: image.resize({ width: Math.min(380, image.getSize().width), quality: 'good' }).toDataURL(), window: null, busy: false, cleaningUp: false, phase: 'idle', selection: null, exchanges: [], segments: [], disclosure: null, models: [], initialization: Promise.resolve() }
    this.sessions.set(id, session)
    session.initialization = this.selectInitial(session)
    const material = selectWindowMaterial({ disableTransparentWindows: app.commandLine.hasSwitch('disable-transparent-windows') })
    try {
      const opened = await openBrowserWindowWithChrome({ kind: 'question', label: 'Question window', initialMaterial: material, surfaceSize: QUESTION_WINDOW_SIZES.surfaceSize, minimumSurfaceSize: QUESTION_WINDOW_SIZES.minimumSurfaceSize, screenSource: screen, timeoutMs: QUESTION_WINDOW_READY_TIMEOUT_MS, createWindow: (attempt) => this.createQuestionWindow(capture, session, attempt), loadRenderer: (window) => loadRenderer(window, 'question', { session: id }), isWindowCurrent: (window) => this.sessions.get(id) === session && session.window === window, beforeRetry: (window) => { if (session.window === window) session.window = null } })
      if (session.window === opened.window && !opened.window.isDestroyed()) opened.window.focus()
    } catch (error) { await this.cleanup(id); throw error }
  }

  async get(id: string): Promise<QuestionViewState> {
    return this.snapshot(await this.requireInitializedSession(id))
  }

  async setSelection(id: string, selection: ConversationSelection): Promise<QuestionViewState> {
    const session = await this.requireInitializedSession(id)
    if (session.busy) throw new Error('Stop the current response before changing provider settings.')
    if (this.pendingWebSearch(session)) throw new Error('Approve or decline the pending web search before changing provider settings.')
    await this.providers.validateSelection(selection)
    session.models = await this.providers.listModels(selection.profileId)
    const previous = session.selection
    const providerChanged = Boolean(previous && (previous.profileId !== selection.profileId || previous.provider !== selection.provider))
    session.selection = structuredClone(selection)
    if (providerChanged || !session.segments.length) this.startSegment(session, providerChanged)
    return this.snapshot(session)
  }

  async send(id: string, text: string): Promise<void> {
    const session = await this.requireInitializedSession(id); const question = text.trim()
    if (!question) throw new Error('Type a question first.'); if (question.length > 10_000) throw new Error('The question is too long.'); if (session.busy) throw new Error('Wait for the current answer or press Stop.'); if (!session.selection) throw new Error('Choose an authenticated provider profile and model first.')
    if (this.pendingWebSearch(session)) throw new Error('Approve or decline the pending web search before sending another message.')
    await this.providers.validateSelection(session.selection)
    let providerSegment = session.segments.at(-1); if (!providerSegment) { this.startSegment(session, false); providerSegment = session.segments.at(-1)! }
    if (!providerSegment.conversationId) providerSegment.conversationId = await this.providers.createConversation(session.selection)
    const exchange: ConversationExchange = { id: randomUUID(), question, answer: '', phase: 'connecting', segmentId: providerSegment.segment.id }
    session.exchanges.push(exchange); session.busy = true; this.setPhase(session, exchange, 'connecting')
    const attachScreenshot = !providerSegment.screenshotAttached
    providerSegment.screenshotAttached = true
    await this.runTurn(session, exchange, providerSegment, { text: question, imagePath: attachScreenshot ? session.imagePath : undefined }, true)
  }

  async resolveWebSearch(id: string, requestId: string, approved: boolean): Promise<QuestionViewState> {
    const session = await this.requireInitializedSession(id)
    if (session.busy) throw new Error('Wait for the current response or press Stop.')
    const exchange = session.exchanges.find((item) => item.webSearch?.id === requestId)
    if (!exchange || exchange.webSearch?.status !== 'requested') throw new Error('That web-search request is no longer pending.')
    if (!approved) {
      exchange.webSearch.status = 'declined'
      exchange.answer = 'Web search was not approved, so I cannot verify this confidently.'
      this.setPhase(session, exchange, 'completed')
      return this.snapshot(session)
    }
    const segment = session.segments.find((item) => item.segment.id === exchange.segmentId)
    if (!segment) throw new Error('The provider segment for this search is no longer available.')
    if (!segment.conversationId) segment.conversationId = await this.providers.createConversation(segment.segment.selection)
    exchange.webSearch.status = 'searching'
    exchange.answer = ''
    exchange.error = undefined
    session.busy = true
    this.setPhase(session, exchange, 'connecting')
    await this.runTurn(session, exchange, segment, { text: `${WEB_SEARCH_APPROVED_PREFIX}\n${exchange.question}`, imagePath: session.imagePath, webSearchAllowed: true }, false)
    return this.snapshot(session)
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
  private pendingWebSearch(session: QuestionSession): ConversationExchange | undefined { return session.exchanges.find((exchange) => exchange.webSearch?.status === 'requested') }
  private async runTurn(session: QuestionSession, exchange: ConversationExchange, providerSegment: ProviderSegmentState, input: { text: string; imagePath?: string; webSearchAllowed?: boolean }, detectWebSearchRequest: boolean): Promise<void> {
    let probe = ''
    let probing = detectWebSearchRequest
    const flush = (): void => { if (!probe) return; exchange.answer += probe; this.setPhase(session, exchange, 'streaming'); this.emit(session, { type: 'delta', text: probe }); probe = '' }
    try {
      for await (const event of this.providers.send(providerSegment.conversationId!, providerSegment.segment.selection, input)) {
        if (event.type === 'started') { this.setPhase(session, exchange, 'thinking'); this.emit(session, event); continue }
        if (event.type === 'delta') {
          if (probing) {
            probe += event.text
            const candidate = probe.trimStart()
            if (WEB_SEARCH_REQUEST_PREFIX.startsWith(candidate) || candidate.startsWith(WEB_SEARCH_REQUEST_PREFIX)) continue
            probing = false
            flush()
            continue
          }
          exchange.answer += event.text
          this.setPhase(session, exchange, 'streaming')
          this.emit(session, event)
          continue
        }
        if (event.type === 'completed') {
          if (probing) {
            const query = parseWebSearchRequest(probe)
            if (query) {
              const requestId = randomUUID()
              exchange.webSearch = { id: requestId, query, status: 'requested' }
              exchange.answer = ''
              this.setPhase(session, exchange, 'awaiting-approval')
              this.emit(session, { type: 'web-search-requested', requestId, query })
              return
            }
            probing = false
            flush()
          }
          if (exchange.webSearch?.status === 'searching') exchange.webSearch.status = 'completed'
          this.setPhase(session, exchange, 'completed')
          this.emit(session, event)
          return
        }
        if (event.type === 'cancelled') {
          if (exchange.webSearch?.status === 'searching') exchange.webSearch.status = 'failed'
          this.setPhase(session, exchange, 'stopped')
          this.emit(session, event)
          return
        }
        if (event.type === 'error') {
          if (exchange.webSearch?.status === 'searching') exchange.webSearch.status = 'failed'
          exchange.error = event.message
          this.setPhase(session, exchange, 'failed')
          this.emit(session, event)
          return
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (exchange.webSearch?.status === 'searching') exchange.webSearch.status = 'failed'
      exchange.error = message
      this.setPhase(session, exchange, 'failed')
      this.emit(session, { type: 'error', message })
    } finally { session.busy = false }
  }
  private async safeModels(profileId: string): Promise<ProviderModelCapability[]> { try { return await this.providers.listModels(profileId) } catch { return [] } }
  private emit(session: QuestionSession, event: ProviderEvent): void { if (session.window && !session.window.isDestroyed()) session.window.webContents.send(IPC.questionEvent, session.id, event) }
  private createQuestionWindow(capture: CompletedCapture, session: QuestionSession, material: WindowMaterial): BrowserWindow {
    const appearance = getWindowAppearanceOptions(QUESTION_WINDOW_SIZES, material, capture.display.workArea)
    const selection = { x: capture.display.bounds.x + capture.selectedBounds.x, y: capture.display.bounds.y + capture.selectedBounds.y, width: capture.selectedBounds.width, height: capture.selectedBounds.height }
    const placement = placeWindowAdjacentToSelection(selection, appearance.size, capture.display.workArea)
    const window = secureWindow({ x: placement.x, y: placement.y, width: placement.width, height: placement.height, minWidth: appearance.minimumSize.width, minHeight: appearance.minimumSize.height, frame: appearance.frame, transparent: appearance.transparent, backgroundColor: appearance.backgroundColor, show: appearance.show, useContentSize: appearance.useContentSize, hasShadow: appearance.hasShadow, resizable: appearance.resizable, maximizable: appearance.maximizable, minimizable: appearance.minimizable, closable: appearance.closable, movable: appearance.movable, fullscreenable: appearance.fullscreenable, thickFrame: appearance.thickFrame, roundedCorners: appearance.roundedCorners, alwaysOnTop: true, skipTaskbar: false, title: 'Fovea', autoHideMenuBar: true })
    session.window = window; window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.once('closed', () => { if (session.window === window) void this.cleanup(session.id) }); return window
  }
  private snapshot(session: QuestionSession): QuestionViewState { return { sessionId: session.id, thumbnailDataUrl: session.thumbnailDataUrl, phase: session.phase, exchanges: structuredClone(session.exchanges), segments: session.segments.map((item) => structuredClone(item.segment)), selection: session.selection ? structuredClone(session.selection) : null, profiles: this.providers.listProfiles(), models: structuredClone(session.models), disclosure: session.disclosure, busy: session.busy } }
  private async requireInitializedSession(id: string): Promise<QuestionSession> { const session = this.requireSession(id); await session.initialization; if (this.sessions.get(id) !== session) throw new Error('This capture session has already closed.'); return session }
  private requireSession(id: string): QuestionSession { const session = this.sessions.get(id); if (!session) throw new Error('This capture session has already closed.'); return session }
  private async cleanup(id: string): Promise<void> { const session = this.sessions.get(id); if (!session || session.cleaningUp) return; session.cleaningUp = true; this.sessions.delete(id); await this.screenshots.delete(session.imagePath); await Promise.all(session.segments.flatMap((item) => item.conversationId ? [this.providers.deleteConversation(item.conversationId, item.segment.selection.provider).catch(() => undefined)] : [])) }
}

function parseWebSearchRequest(value: string): string | null {
  const match = value.trim().match(/^<fovea-web-search-request>([\s\S]{1,1000})<\/fovea-web-search-request>$/i)
  if (!match) return null
  try {
    const payload = JSON.parse(match[1]!) as { query?: unknown }
    return typeof payload.query === 'string' && payload.query.trim() ? payload.query.trim().slice(0, 500) : null
  } catch { return null }
}
