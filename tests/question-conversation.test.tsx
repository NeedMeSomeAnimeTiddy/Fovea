// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationExchange } from '../src/shared/types/app'
import { ConversationTimeline, takeNextTypingCharacter } from '../src/renderer/question-window/main'

afterEach(cleanup)

const exchanges: ConversationExchange[] = [
  {
    id: 'opening',
    question: 'Analyse this capture',
    answer: 'A little more detail.',
    phase: 'completed',
    segmentId: 'segment-1',
    automatic: true,
    metadata: {
      category: 'general',
      summary: 'This is the useful first answer.',
      suggestedQuestions: ['Explain this']
    }
  },
  {
    id: 'follow-up',
    question: 'Can you explain that simply?',
    answer: '',
    phase: 'completed',
    segmentId: 'segment-1',
    metadata: {
      category: 'general',
      summary: 'Here is the simpler explanation.',
      suggestedQuestions: ['What next?']
    }
  }
]

describe('response conversation timeline', () => {
  it('keeps the automatic answer and follow-up visible as one flowing conversation', () => {
    const { container } = render(
      <ConversationTimeline
        exchanges={exchanges}
        onCopy={vi.fn(async () => undefined)}
        onRecover={vi.fn()}
        onResolveWebSearch={vi.fn()}
      />
    )

    expect(screen.getByRole('log', { name: 'Conversation' })).toBeTruthy()
    expect(screen.queryByText('Analyse this capture')).toBeNull()
    expect(screen.getByText('This is the useful first answer.')).toBeTruthy()
    expect(screen.getByText('Can you explain that simply?')).toBeTruthy()
    expect(screen.getByText('Here is the simpler explanation.')).toBeTruthy()
    expect(container.querySelectorAll('.conversation-message--assistant')).toHaveLength(2)
    expect(container.querySelectorAll('.conversation-message--user')).toHaveLength(1)
  })

  it('extracts exactly one visible Unicode character for each typing tick', () => {
    expect(takeNextTypingCharacter('Hello')).toEqual({ character: 'H', remainder: 'ello' })
    expect(takeNextTypingCharacter('🙂 done')).toEqual({ character: '🙂', remainder: ' done' })
    expect(takeNextTypingCharacter('')).toEqual({ character: '', remainder: '' })
  })
})
