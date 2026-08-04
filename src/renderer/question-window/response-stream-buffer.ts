import type { AssistantResponseMetadata, ProviderEvent } from '@shared/types/provider'
import type { ResponsePhase } from '@shared/types/app'

const CONVERSATIONAL_INTERVAL_MS = 40
const CONVERSATIONAL_BATCH_SIZE = 12
const WORD_BOUNDARY_LOOKAHEAD = 12
const TARGET_CATCH_UP_FRAMES = 6

export type TerminalResponsePhase = Extract<ResponsePhase, 'completed' | 'stopped' | 'failed'>

export interface ResponseTextBatch {
  answer: string
  summary: string
}

export interface ResponseStreamCallbacks {
  isReady(): boolean
  prefersReducedMotion?(): boolean
  onBatch(batch: ResponseTextBatch): void
  onMetadata(metadata: AssistantResponseMetadata): void
  onPhase(phase: ResponsePhase): void
  onRefresh(): void
}

interface TimerScheduler {
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  cancel(handle: ReturnType<typeof setTimeout>): void
}

const defaultScheduler: TimerScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle)
}

/**
 * Coalesces provider events before they reach React, then reveals them in short
 * word-sized beats. Large bursts increase the batch size so the conversational
 * effect never leaves more than a brief artificial backlog behind the provider.
 */
export class ResponseStreamBuffer {
  private pendingAnswer = ''
  private pendingSummary = ''
  private pendingTerminal: TerminalResponsePhase | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private activeBatchSize = 0

  constructor(
    private readonly callbacks: ResponseStreamCallbacks,
    private readonly scheduler: TimerScheduler = defaultScheduler
  ) {}

  consume(event: ProviderEvent): void {
    if (event.type === 'web-search-requested') {
      this.reset()
      this.callbacks.onRefresh()
      return
    }
    if (event.type === 'response-metadata') {
      this.pendingSummary += event.metadata.summary
      this.callbacks.onMetadata({ ...event.metadata, summary: '' })
      this.schedule()
      return
    }
    if (event.type === 'delta') {
      this.pendingAnswer += event.text
      this.schedule()
      return
    }
    if (event.type === 'started') {
      this.pendingTerminal = null
      this.callbacks.onPhase('thinking')
      return
    }
    if (event.type === 'completed' || event.type === 'cancelled') {
      this.finishAfterPendingText(event.type === 'completed' ? 'completed' : 'stopped')
      return
    }
    if (event.type === 'error') this.finishAfterPendingText('failed')
  }

  reset(): void {
    this.pendingAnswer = ''
    this.pendingSummary = ''
    this.pendingTerminal = null
    this.activeBatchSize = 0
    if (this.timer !== null) this.scheduler.cancel(this.timer)
    this.timer = null
  }

  dispose(): void {
    this.reset()
  }

  private finishAfterPendingText(phase: TerminalResponsePhase): void {
    this.pendingTerminal = phase
    if (this.pendingAnswer || this.pendingSummary) this.schedule()
    else this.finish()
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = this.scheduler.schedule(() => this.drain(), CONVERSATIONAL_INTERVAL_MS)
  }

  private drain(): void {
    this.timer = null
    if (!this.callbacks.isReady()) {
      this.schedule()
      return
    }

    const backlog = this.pendingSummary.length + this.pendingAnswer.length
    const interrupted = this.pendingTerminal === 'stopped' || this.pendingTerminal === 'failed'
    if (!interrupted) {
      this.activeBatchSize = Math.max(
        this.activeBatchSize,
        CONVERSATIONAL_BATCH_SIZE,
        Math.ceil(backlog / TARGET_CATCH_UP_FRAMES)
      )
    }
    const batchSize = interrupted || this.callbacks.prefersReducedMotion?.()
      ? Number.MAX_SAFE_INTEGER
      : this.activeBatchSize
    const summary = takeConversationalBatch(this.pendingSummary, batchSize)
    this.pendingSummary = summary.remainder
    const answer = takeConversationalBatch(this.pendingAnswer, Math.max(0, batchSize - summary.count))
    this.pendingAnswer = answer.remainder

    if (summary.value || answer.value) {
      this.callbacks.onBatch({ summary: summary.value, answer: answer.value })
    }
    if (this.pendingSummary || this.pendingAnswer) this.schedule()
    else {
      this.activeBatchSize = 0
      this.finish()
    }
  }

  private finish(): void {
    const phase = this.pendingTerminal
    if (!phase) return
    this.pendingTerminal = null
    this.callbacks.onPhase(phase)
    this.callbacks.onRefresh()
  }
}

/**
 * Takes at least the requested number of graphemes, looking a little farther
 * for whitespace or punctuation so visible updates land on natural boundaries.
 */
export function takeConversationalBatch(value: string, minimumGraphemes: number): {
  value: string
  remainder: string
  count: number
} {
  if (!value || minimumGraphemes <= 0) return { value: '', remainder: value, count: 0 }
  if (!Number.isFinite(minimumGraphemes)) {
    return { value, remainder: '', count: countGraphemes(value) }
  }

  const segmenter = createGraphemeSegmenter()
  const maximumGraphemes = minimumGraphemes + WORD_BOUNDARY_LOOKAHEAD
  let end = 0
  let count = 0
  for (const segment of segmentGraphemes(value, segmenter)) {
    end = segment.index + segment.segment.length
    count += 1
    if (count >= minimumGraphemes && isConversationalBoundary(segment.segment)) break
    if (count >= maximumGraphemes) break
  }
  return { value: value.slice(0, end), remainder: value.slice(end), count }
}

export function takeStreamingBatch(value: string, maximumGraphemes: number): {
  value: string
  remainder: string
  count: number
} {
  if (!value || maximumGraphemes <= 0) return { value: '', remainder: value, count: 0 }
  const segmenter = createGraphemeSegmenter()
  let end = 0
  let count = 0
  if (segmenter) {
    for (const segment of segmenter.segment(value)) {
      if (count >= maximumGraphemes) break
      end = segment.index + segment.segment.length
      count += 1
    }
  } else {
    for (const codePoint of value) {
      if (count >= maximumGraphemes) break
      end += codePoint.length
      count += 1
    }
  }
  return { value: value.slice(0, end), remainder: value.slice(end), count }
}

interface GraphemeSegment {
  index: number
  segment: string
}

interface GraphemeSegmenter {
  segment(value: string): Iterable<GraphemeSegment>
}

function createGraphemeSegmenter(): GraphemeSegmenter | null {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locales?: string | string[], options?: { granularity: 'grapheme' }) => GraphemeSegmenter
  }).Segmenter
  return Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null
}

function segmentGraphemes(value: string, segmenter: GraphemeSegmenter | null): Iterable<GraphemeSegment> {
  if (segmenter) return segmenter.segment(value)
  let index = 0
  return Array.from(value, (segment) => {
    const grapheme = { index, segment }
    index += segment.length
    return grapheme
  })
}

function countGraphemes(value: string): number {
  let count = 0
  for (const segment of segmentGraphemes(value, createGraphemeSegmenter())) {
    if (segment.segment) count += 1
  }
  return count
}

function isConversationalBoundary(segment: string): boolean {
  return /[\s,.!?;:\u2026\u2014-]/u.test(segment)
}
