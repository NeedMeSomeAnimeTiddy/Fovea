import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResponseStreamBuffer } from '../src/renderer/question-window/response-stream-buffer'
import type { ResponsePhase } from '../src/shared/types/app'

afterEach(() => {
  vi.useRealTimers()
})

describe('response stream buffering', () => {
  it('coalesces a large provider burst into a bounded number of render batches', () => {
    vi.useFakeTimers()
    const batches: string[] = []
    const phases: ResponsePhase[] = []
    const buffer = new ResponseStreamBuffer({
      isReady: () => true,
      onBatch: ({ answer }) => batches.push(answer),
      onMetadata: vi.fn(),
      onPhase: (phase) => phases.push(phase),
      onRefresh: vi.fn()
    })

    buffer.consume({ type: 'delta', text: 'x'.repeat(10_000) })
    vi.runAllTimers()

    expect(batches.join('')).toHaveLength(10_000)
    expect(batches.length).toBeLessThanOrEqual(7)
    expect(phases.at(-1)).toBeUndefined()
  })

  it('preserves Unicode graphemes and flushes progressive batching for reduced motion', () => {
    vi.useFakeTimers()
    const batches: string[] = []
    const value = '👨‍👩‍👧‍👦'.repeat(2_000)
    const buffer = new ResponseStreamBuffer({
      isReady: () => true,
      prefersReducedMotion: () => true,
      onBatch: ({ answer }) => batches.push(answer),
      onMetadata: vi.fn(),
      onPhase: vi.fn(),
      onRefresh: vi.fn()
    })

    buffer.consume({ type: 'delta', text: value })
    vi.advanceTimersByTime(40)

    expect(batches).toEqual([value])
  })

  it('finishes a completed response conversationally within the bounded catch-up window', () => {
    vi.useFakeTimers()
    const order: string[] = []
    const refresh = vi.fn(() => order.push('refresh'))
    const buffer = new ResponseStreamBuffer({
      isReady: () => true,
      onBatch: ({ answer }) => order.push(`batch:${answer.length}`),
      onMetadata: vi.fn(),
      onPhase: (phase) => order.push(`phase:${phase}`),
      onRefresh: refresh
    })

    buffer.consume({ type: 'delta', text: 'y'.repeat(10_000) })
    buffer.consume({ type: 'completed' })
    vi.advanceTimersByTime(200)

    expect(order.filter((item) => item.startsWith('batch:'))).toHaveLength(5)
    expect(order).not.toContain('phase:completed')

    vi.advanceTimersByTime(40)

    expect(order.filter((item) => item.startsWith('batch:'))).toHaveLength(6)
    expect(order.at(-2)).toBe('phase:completed')
    expect(order.at(-1)).toBe('refresh')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it.each([
    ['cancelled', 'stopped'],
    ['error', 'failed']
  ] as const)('flushes pending text immediately before the %s terminal state', (eventType, expectedPhase) => {
    vi.useFakeTimers()
    const order: string[] = []
    const buffer = new ResponseStreamBuffer({
      isReady: () => true,
      onBatch: ({ answer }) => order.push(`batch:${answer.length}`),
      onMetadata: vi.fn(),
      onPhase: (phase) => order.push(`phase:${phase}`),
      onRefresh: () => order.push('refresh')
    })

    buffer.consume({ type: 'delta', text: 'y'.repeat(10_000) })
    buffer.consume(eventType === 'error'
      ? { type: 'error', error: { code: 'unexpected', title: 'Failed', message: 'Failed', recovery: 'none' } }
      : { type: eventType })
    vi.advanceTimersByTime(40)

    expect(order).toEqual(['batch:10000', `phase:${expectedPhase}`, 'refresh'])
  })

  it('reveals ordinary responses as short phrases on natural boundaries', () => {
    vi.useFakeTimers()
    const batches: string[] = []
    const buffer = new ResponseStreamBuffer({
      isReady: () => true,
      onBatch: ({ answer }) => batches.push(answer),
      onMetadata: vi.fn(),
      onPhase: vi.fn(),
      onRefresh: vi.fn()
    })

    buffer.consume({ type: 'delta', text: 'Hello there, how are you today?' })
    vi.advanceTimersByTime(40)
    expect(batches).toEqual(['Hello there,'])
    vi.advanceTimersByTime(40)
    expect(batches).toEqual(['Hello there,', ' how are you '])
    vi.advanceTimersByTime(40)
    expect(batches.join('')).toBe('Hello there, how are you today?')
  })

  it('keeps metadata and answer content ordered while rendering them in one frame', () => {
    vi.useFakeTimers()
    const batches: Array<{ summary: string; answer: string }> = []
    const metadata = vi.fn()
    const buffer = new ResponseStreamBuffer({
      isReady: () => true,
      onBatch: (batch) => batches.push(batch),
      onMetadata: metadata,
      onPhase: vi.fn(),
      onRefresh: vi.fn()
    })

    buffer.consume({
      type: 'response-metadata',
      metadata: { category: 'general', summary: 'Summary', suggestedQuestions: [] }
    })
    buffer.consume({ type: 'delta', text: 'Answer' })
    vi.advanceTimersByTime(40)

    expect(metadata).toHaveBeenCalledWith({ category: 'general', summary: '', suggestedQuestions: [] })
    expect(batches).toEqual([{ summary: 'Summary', answer: 'Answer' }])
  })

  it('waits for renderer readiness without dropping a terminal event', () => {
    vi.useFakeTimers()
    let ready = false
    const answer: string[] = []
    const phases: ResponsePhase[] = []
    const buffer = new ResponseStreamBuffer({
      isReady: () => ready,
      onBatch: (batch) => answer.push(batch.answer),
      onMetadata: vi.fn(),
      onPhase: (phase) => phases.push(phase),
      onRefresh: vi.fn()
    })

    buffer.consume({ type: 'delta', text: 'ready later' })
    buffer.consume({ type: 'completed' })
    vi.advanceTimersByTime(80)
    expect(answer).toEqual([])
    ready = true
    vi.advanceTimersByTime(40)
    expect(answer.join('')).toBe('ready later')
    expect(phases).toEqual(['completed'])
  })
})
