import { randomUUID } from 'node:crypto'
import type { ConversationExchange, ResponsePhase } from '@shared/types/app'
import type { AssistantResponseMetadata, ProviderEvent } from '@shared/types/provider'
import { toAppError } from '../errors/app-error'

const WEB_SEARCH_REQUEST_PREFIX = '<fovea-web-search-request>'
const RESPONSE_METADATA_PREFIX = '<fovea-response>'
const RESPONSE_METADATA_SUFFIX = '</fovea-response>'
const RESPONSE_METADATA_LIMIT = 12_000
const RESPONSE_PREAMBLE_LIMIT = 2_000

export const SAFE_SUGGESTED_QUESTIONS = [
  'What do the most important visible details mean?',
  'Is anything in this image unusual or incorrect?',
  'What is the most useful next step based on this image?',
  'What could a web search verify about what is shown?'
]

export interface ResponseControlOptions {
  detectMetadata: boolean
  detectWebSearch: boolean
}

export interface QuestionTurnSessionState {
  busy: boolean
  phase: ResponsePhase
}

export interface RunQuestionTurnOptions {
  session: QuestionTurnSessionState
  exchange: ConversationExchange
  events: AsyncIterable<ProviderEvent>
  controls: ResponseControlOptions
  emit(event: ProviderEvent): void
  persist(): Promise<void>
  createRequestId?(): string
}

/** Runs one provider event stream without depending on BrowserWindow or IPC. */
export async function runQuestionTurn(options: RunQuestionTurnOptions): Promise<void> {
  const { session, exchange, events, controls, emit, persist } = options
  let probe = ''
  let probing = controls.detectMetadata || controls.detectWebSearch
  const appendAnswer = (text: string): void => {
    const visibleText = exchange.answer ? text : text.replace(/^\s+/, '')
    if (!visibleText) return
    exchange.answer += visibleText
    setTurnPhase(session, exchange, 'streaming')
    emit({ type: 'delta', text: visibleText })
  }
  const flush = (): void => {
    if (!probe) return
    appendAnswer(probe)
    probe = ''
  }
  const consumeMetadata = (): 'complete' | 'partial' | 'none' => {
    if (!controls.detectMetadata) return 'none'
    const parsed = parseResponseMetadata(probe)
    if (parsed.state !== 'complete') return parsed.state
    probe = ''
    probing = false
    if (parsed.metadata) {
      exchange.metadata = parsed.metadata
      emit({ type: 'response-metadata', metadata: parsed.metadata })
    }
    appendAnswer(parsed.remainder)
    return 'complete'
  }

  try {
    for await (const event of events) {
      if (event.type === 'started') {
        setTurnPhase(session, exchange, 'thinking')
        emit(event)
        continue
      }
      if (event.type === 'delta') {
        if (probing) {
          probe += event.text
          const metadataState = consumeMetadata()
          if (metadataState === 'complete') continue
          const candidate = probe.trimStart()
          const possibleMetadata = controls.detectMetadata && (
            metadataState === 'partial' || candidate.startsWith(RESPONSE_METADATA_PREFIX)
          )
          const possibleWebSearch = controls.detectWebSearch && (
            WEB_SEARCH_REQUEST_PREFIX.startsWith(candidate) || candidate.startsWith(WEB_SEARCH_REQUEST_PREFIX)
          )
          if ((possibleMetadata || possibleWebSearch) && probe.length <= RESPONSE_METADATA_LIMIT) continue
          probing = false
          flush()
          continue
        }
        appendAnswer(event.text)
        continue
      }
      if (event.type === 'completed') {
        if (probing) {
          const query = controls.detectWebSearch ? parseWebSearchRequest(probe) : null
          if (query) {
            const requestId = (options.createRequestId ?? randomUUID)()
            exchange.webSearch = { id: requestId, query, status: 'requested' }
            exchange.answer = ''
            setTurnPhase(session, exchange, 'awaiting-approval')
            emit({ type: 'web-search-requested', requestId, query })
            return
          }
          if (consumeMetadata() !== 'complete') {
            probing = false
            flush()
          }
        }
        const recovered = parseResponseMetadata(exchange.answer)
        if (recovered.state === 'complete') {
          exchange.answer = recovered.remainder
          if (recovered.metadata) {
            exchange.metadata = recovered.metadata
            emit({ type: 'response-metadata', metadata: recovered.metadata })
          }
        }
        if (exchange.webSearch?.status === 'searching') exchange.webSearch.status = 'completed'
        setTurnPhase(session, exchange, 'completed')
        emit(event)
        return
      }
      if (event.type === 'cancelled') {
        if (exchange.webSearch?.status === 'searching') exchange.webSearch.status = 'failed'
        setTurnPhase(session, exchange, 'stopped')
        emit(event)
        return
      }
      if (event.type === 'error') {
        if (exchange.webSearch?.status === 'searching') exchange.webSearch.status = 'failed'
        exchange.error = event.error
        setTurnPhase(session, exchange, 'failed')
        emit(event)
        return
      }
    }
  } catch (error) {
    if (exchange.webSearch?.status === 'searching') exchange.webSearch.status = 'failed'
    if (session.phase === 'stopped' || isCancellation(error)) {
      setTurnPhase(session, exchange, 'stopped')
      emit({ type: 'cancelled' })
      return
    }
    const appError = toAppError(error, 'provider-unavailable')
    exchange.error = appError
    setTurnPhase(session, exchange, 'failed')
    emit({ type: 'error', error: appError })
  } finally {
    session.busy = false
    await persist().catch(() => undefined)
  }
}

export function setTurnPhase(
  session: QuestionTurnSessionState,
  exchange: ConversationExchange,
  phase: ResponsePhase
): void {
  session.phase = phase
  exchange.phase = phase
  if (['completed', 'failed', 'stopped'].includes(phase) && !exchange.completedAt) {
    exchange.completedAt = new Date().toISOString()
  }
}

function parseWebSearchRequest(value: string): string | null {
  const match = value.match(/<fovea-web-search-request>([\s\S]{1,1000})<\/fovea-web-search-request>/i)
  if (!match) return null
  try {
    const payload = JSON.parse(match[1]!) as { query?: unknown }
    return typeof payload.query === 'string' && payload.query.trim() ? payload.query.trim().slice(0, 500) : null
  } catch {
    return null
  }
}

function parseResponseMetadata(value: string): {
  state: 'complete' | 'partial' | 'none'
  metadata?: AssistantResponseMetadata
  remainder: string
} {
  const candidate = value.trimStart()
  const lowerCandidate = candidate.toLowerCase()
  const start = lowerCandidate.indexOf(RESPONSE_METADATA_PREFIX)
  if (start < 0) {
    if (candidate.length <= RESPONSE_PREAMBLE_LIMIT) return { state: 'partial', remainder: '' }
    return { state: 'none', remainder: value }
  }
  const end = lowerCandidate.indexOf(RESPONSE_METADATA_SUFFIX, start + RESPONSE_METADATA_PREFIX.length)
  if (end < 0) return { state: 'partial', remainder: '' }

  const payloadText = candidate.slice(start + RESPONSE_METADATA_PREFIX.length, end)
  const remainder = candidate.slice(end + RESPONSE_METADATA_SUFFIX.length).replace(/^\s+/, '')
  try {
    const payload = JSON.parse(payloadText) as {
      category?: unknown
      summary?: unknown
      suggestedQuestions?: unknown
    }
    const summary = typeof payload.summary === 'string' ? payload.summary.trim().slice(0, 1_200) : ''
    if (!summary) return { state: 'complete', remainder }
    const category = typeof payload.category === 'string' && payload.category.trim()
      ? payload.category.trim().slice(0, 80)
      : 'general'
    const suggestedQuestions = [
      ...(Array.isArray(payload.suggestedQuestions)
        ? payload.suggestedQuestions
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item && !requiresUnavailableInput(item))
        : []),
      ...SAFE_SUGGESTED_QUESTIONS
    ]
    return {
      state: 'complete',
      metadata: {
        category,
        summary,
        suggestedQuestions: [...new Set(suggestedQuestions)].slice(0, 4).map((item) => item.slice(0, 180))
      },
      remainder
    }
  } catch {
    return { state: 'complete', remainder }
  }
}

function requiresUnavailableInput(question: string): boolean {
  const requestsUserAction = /\b(?:can|could|would)\s+you\b|\b(?:please|share|upload|attach|send|provide|capture|record|show me|take another)\b/i.test(question)
  const unavailableInput = /\b(?:screens?|screenshots?|images?|photos?|pictures?|files?|links?|videos?|recordings?|logs?)\b/i.test(question)
  const unavailableMoment = /\b(?:just before|just after|previous screen|next screen|earlier screen|later screen)\b/i.test(question)
  return unavailableMoment || (requestsUserAction && unavailableInput)
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /stopped|aborted|cancelled/i.test(error.message))
}
