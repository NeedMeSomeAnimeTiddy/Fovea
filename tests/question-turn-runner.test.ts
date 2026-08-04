import { describe, expect, it, vi } from 'vitest'
import { runQuestionTurn } from '../src/main/windows/question-turn-runner'
import type { ConversationExchange } from '../src/shared/types/app'
import type { ProviderEvent } from '../src/shared/types/provider'

function exchange(): ConversationExchange {
  return {
    id: 'exchange-1',
    question: 'What is shown?',
    answer: '',
    phase: 'connecting',
    segmentId: 'segment-1'
  }
}

async function* events(...items: ProviderEvent[]): AsyncIterable<ProviderEvent> {
  yield* items
}

describe('provider-independent question turn runner', () => {
  it('parses metadata and emits only visible answer text', async () => {
    const current = exchange()
    const session = { busy: true, phase: current.phase }
    const emitted: ProviderEvent[] = []
    const persist = vi.fn(async () => undefined)

    await runQuestionTurn({
      session,
      exchange: current,
      events: events(
        { type: 'started', turnId: 'turn-1' },
        { type: 'delta', text: '<fovea-response>{"category":"ui","summary":"Useful summary","suggestedQuestions":["Explain this"]}</fovea-response>' },
        { type: 'delta', text: 'Detailed answer' },
        { type: 'completed' }
      ),
      controls: { detectMetadata: true, detectWebSearch: true },
      emit: (event) => emitted.push(event),
      persist
    })

    expect(current).toMatchObject({
      phase: 'completed',
      answer: 'Detailed answer',
      metadata: { category: 'ui', summary: 'Useful summary' }
    })
    expect(emitted.map((event) => event.type)).toEqual(['started', 'response-metadata', 'delta', 'completed'])
    expect(session).toEqual({ busy: false, phase: 'completed' })
    expect(persist).toHaveBeenCalledOnce()
  })

  it('pauses for a structured web-search request without exposing the control tag', async () => {
    const current = exchange()
    const session = { busy: true, phase: current.phase }
    const emitted: ProviderEvent[] = []

    await runQuestionTurn({
      session,
      exchange: current,
      events: events(
        { type: 'delta', text: '<fovea-web-search-request>{"query":"current product version"}</fovea-web-search-request>' },
        { type: 'completed' }
      ),
      controls: { detectMetadata: true, detectWebSearch: true },
      emit: (event) => emitted.push(event),
      persist: async () => undefined,
      createRequestId: () => 'request-1'
    })

    expect(current.answer).toBe('')
    expect(current.phase).toBe('awaiting-approval')
    expect(current.webSearch).toEqual({ id: 'request-1', query: 'current product version', status: 'requested' })
    expect(emitted).toEqual([{ type: 'web-search-requested', requestId: 'request-1', query: 'current product version' }])
  })

  it('normalises a thrown provider failure and still persists terminal state', async () => {
    const current = exchange()
    const session = { busy: true, phase: current.phase }
    const emitted: ProviderEvent[] = []
    const persist = vi.fn(async () => undefined)
    async function* failedEvents(fail = true): AsyncIterable<ProviderEvent> {
      if (!fail) yield { type: 'completed' }
      throw new Error('Gateway timed out (504)')
    }

    await runQuestionTurn({
      session,
      exchange: current,
      events: failedEvents(),
      controls: { detectMetadata: true, detectWebSearch: true },
      emit: (event) => emitted.push(event),
      persist
    })

    expect(current.phase).toBe('failed')
    expect(current.error?.code).toBe('timeout')
    expect(emitted.at(-1)?.type).toBe('error')
    expect(session.busy).toBe(false)
    expect(persist).toHaveBeenCalledOnce()
  })
})
