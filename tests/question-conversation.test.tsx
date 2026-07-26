// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationExchange } from '../src/shared/types/app'
import { AttachmentStrip, CaptureMenu, ConversationTimeline, takeNextTypingCharacter } from '../src/renderer/question-window/main'

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

  it('previews every screenshot and only offers removal for drafts', () => {
    const preview = vi.fn()
    const remove = vi.fn()
    render(
      <AttachmentStrip
        attachments={[
          { id: 'sent', thumbnailDataUrl: 'data:image/png;base64,c2VudA==', status: 'sent' },
          { id: 'draft', thumbnailDataUrl: 'data:image/png;base64,ZHJhZnQ=', status: 'draft' }
        ]}
        disabled={false}
        onPreview={preview}
        onRemove={remove}
      />
    )

    expect(screen.getByRole('region', { name: 'Conversation screenshots' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Preview screenshot/ })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Remove screenshot 1' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Preview screenshot 2, not sent yet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot 2' }))
    expect(preview).toHaveBeenCalledWith('draft')
    expect(remove).toHaveBeenCalledWith('draft')
  })

  it('separates adding a screenshot from starting a new chat', () => {
    const add = vi.fn()
    const newChat = vi.fn()
    render(<CaptureMenu addDisabled onAdd={add} onNewChat={newChat} />)

    expect(screen.getByRole('menu', { name: 'Capture options' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Add a screenshot/ }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: /New chat/ }))
    expect(add).not.toHaveBeenCalled()
    expect(newChat).toHaveBeenCalledTimes(1)
  })
})
