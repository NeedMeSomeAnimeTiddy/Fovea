// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationExchange } from '../src/shared/types/app'
import { AttachmentStrip, CaptureMenu, ConversationTimeline, ocrEntityExternalAction, takeNextTypingCharacter } from '../src/renderer/question-window/main'

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

  it('opens screenshot actions and disables draft-only actions for sent images', () => {
    const preview = vi.fn()
    const edit = vi.fn()
    const remove = vi.fn()
    render(
      <AttachmentStrip
        attachments={[
          { id: 'sent', thumbnailDataUrl: 'data:image/png;base64,c2VudA==', status: 'sent', edited: false, ocr: { status: 'idle' } },
          { id: 'draft', thumbnailDataUrl: 'data:image/png;base64,ZHJhZnQ=', status: 'draft', edited: false, ocr: { status: 'idle' } }
        ]}
        disabled={false}
        onEdit={edit}
        onPreview={preview}
        onRemove={remove}
      />
    )

    expect(screen.getByRole('region', { name: 'Conversation screenshots' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Screenshot \d options/ })).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot 1 options' }))
    expect(screen.getByRole('menu', { name: 'Screenshot 1 actions' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Extract text/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Edit' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'Remove' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'View Full' }))
    expect(preview).toHaveBeenCalledWith('sent')

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot 2 options, not sent yet' }))
    expect(screen.getByRole('menuitem', { name: 'Edit' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('menuitem', { name: 'Remove' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'View Full' }))
    expect(preview).toHaveBeenCalledWith('draft')

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot 2 options, not sent yet' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(edit).toHaveBeenCalledWith('draft')

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot 2 options, not sent yet' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
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

  it('shows OCR output as plain text in the normal response timeline', () => {
    const onCopy = vi.fn(async () => undefined)
    const onOpenOcrEntity = vi.fn()
    const { container } = render(
      <ConversationTimeline
        exchanges={[{
          id: 'ocr',
          question: 'Extract text',
          answer: 'Invoice\nTotal £42',
          phase: 'completed',
          segmentId: 'local-ocr',
          source: 'ocr',
          automatic: true,
          ocr: {
            confidence: 93,
            quality: 'normal',
            language: { code: 'eng', label: 'English', source: 'configured' },
            entities: [{ id: 'entity-1', kind: 'email', value: 'billing@example.com' }],
            engine: 'tesseract',
            cached: false,
            preprocessing: 'upscaled-contrast',
            durationMs: 240
          }
        }]}
        onCopy={onCopy}
        onOpenOcrEntity={onOpenOcrEntity}
        onResolveWebSearch={vi.fn()}
      />
    )

    expect(container.querySelector('.ocr-response-text')?.textContent).toBe('Invoice\nTotal £42')
    expect(screen.getByText('Tesseract OCR')).toBeTruthy()
    expect(screen.getByText('93% confidence')).toBeTruthy()
    expect(screen.getByText('240ms')).toBeTruthy()
    expect(screen.getByText('Enhanced')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy Email: billing@example.com' }))
    expect(onCopy).toHaveBeenCalledWith('billing@example.com', 'Email copied')
    fireEvent.click(screen.getByRole('button', { name: 'Email billing@example.com' }))
    expect(onOpenOcrEntity).toHaveBeenCalledWith({ id: 'entity-1', kind: 'email', value: 'billing@example.com' })
    expect(screen.queryByRole('dialog', { name: 'Extracted text' })).toBeNull()
  })

  it('offers external actions only for safe actionable OCR entities', () => {
    expect(ocrEntityExternalAction({ id: 'url', kind: 'url', value: 'https://example.com' }))
      .toMatchObject({ kind: 'url', label: 'Open' })
    expect(ocrEntityExternalAction({ id: 'qr', kind: 'qr', value: 'www.example.com' }))
      .toMatchObject({ kind: 'url', label: 'Open' })
    expect(ocrEntityExternalAction({ id: 'text-qr', kind: 'qr', value: 'plain text' })).toBeNull()
    expect(ocrEntityExternalAction({ id: 'barcode', kind: 'barcode', value: '1234567890' })).toBeNull()
  })

  it('identifies native Windows OCR without inventing a confidence score', () => {
    const onManageOcrLanguages = vi.fn()
    render(
      <ConversationTimeline
        exchanges={[{
          id: 'native-ocr',
          question: 'Extract text',
          answer: 'Native result',
          phase: 'completed',
          segmentId: 'local-ocr',
          source: 'ocr',
          automatic: true,
          ocr: {
            confidence: 0,
            quality: 'normal',
            language: { code: 'en-GB', label: 'English (United Kingdom)', source: 'detected' },
            entities: [],
            engine: 'windows',
            cached: false,
            preprocessing: 'none',
            durationMs: 1_250
          }
        }]}
        onCopy={vi.fn(async () => undefined)}
        onManageOcrLanguages={onManageOcrLanguages}
        onResolveWebSearch={vi.fn()}
      />
    )

    expect(screen.getByText('Windows OCR')).toBeTruthy()
    expect(screen.getByText('1.3s')).toBeTruthy()
    expect(screen.queryByText('0% confidence')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Manage languages' }))
    expect(onManageOcrLanguages).toHaveBeenCalledOnce()
  })
})
