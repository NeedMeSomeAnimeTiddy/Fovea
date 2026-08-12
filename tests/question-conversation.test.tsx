// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FoveaApi, RequestDisclosureState } from '../src/shared/contracts/ipc'
import type { ConversationExchange } from '../src/shared/types/app'
import { AttachmentStrip, CaptureMenu, ConversationTimeline, EmptyConversation, RequestDisclosure, ocrEntityExternalAction, requestDisclosureKey } from '../src/renderer/question-window/main'
import { takeStreamingBatch } from '../src/renderer/question-window/response-stream-buffer'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'fovea')
})

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

describe('conversation opened with nothing asked yet', () => {
  it('invites a question instead of showing a skeleton that never resolves', () => {
    const onAsk = vi.fn()
    render(<EmptyConversation disabled={false} onAsk={onAsk} />)

    const button = screen.getByRole('button', { name: 'Ask a question' })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    expect(onAsk).toHaveBeenCalledTimes(1)
  })

  it('disables the invitation while the session cannot ask', () => {
    render(<EmptyConversation disabled onAsk={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Ask a question' }).hasAttribute('disabled')).toBe(true)
  })
})

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

  it('requires approval before opening an AI-rendered external link', async () => {
    const openExternal = vi.fn(async () => undefined)
    installOpenExternal(openExternal)
    const link = renderExternalLink('See [Example](https://example.com/help?x=1).')

    fireEvent.click(link)
    expect(openExternal).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Open external link' })).toBeTruthy()
    expect(screen.getByText('example.com')).toBeTruthy()
    expect(screen.getByText('https://example.com/help?x=1')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open link' }))
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://example.com/help?x=1'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Open external link' })).toBeNull())
    expect(document.activeElement).toBe(link)
  })

  it('cancels an external link without opening it and restores focus', async () => {
    const openExternal = vi.fn(async () => undefined)
    installOpenExternal(openExternal)
    const link = renderExternalLink('See [Example](https://example.com).')

    fireEvent.click(link)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(document.activeElement).toBe(cancel))
    fireEvent.click(cancel)

    expect(openExternal).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Open external link' })).toBeNull()
    expect(document.activeElement).toBe(link)
  })

  it('closes external-link confirmation with Escape', async () => {
    const openExternal = vi.fn(async () => undefined)
    installOpenExternal(openExternal)
    const link = renderExternalLink('See [Example](https://example.com).')

    fireEvent.click(link)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBe(document.activeElement))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(openExternal).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Open external link' })).toBeNull()
    expect(document.activeElement).toBe(link)
  })

  it('keeps confirmation open and explains when the shell cannot open a link', async () => {
    const openExternal = vi.fn(async () => { throw new Error('Shell unavailable') })
    installOpenExternal(openExternal)
    renderExternalLink('See [Example](https://example.com).')

    fireEvent.click(screen.getByRole('link', { name: 'Example' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open link' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Fovea could not open this link')
    expect(screen.getByRole('dialog', { name: 'Open external link' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false)
  })

  it('shows why a non-HTTP AI link is blocked without calling the shell', () => {
    const openExternal = vi.fn(async () => undefined)
    installOpenExternal(openExternal)
    renderExternalLink('Try [this action](mailto:billing@example.com).')

    fireEvent.click(screen.getByRole('link', { name: 'this action' }))

    expect(screen.getByText('Link blocked')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Blocked external link' })).toBeTruthy()
    expect(screen.getByText(/valid HTTP or HTTPS destination/i)).toBeTruthy()
    expect(screen.getByText('mailto:billing@example.com')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open link' })).toBeNull()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('takes bounded streaming batches without splitting visible Unicode graphemes', () => {
    expect(takeStreamingBatch('Hello', 3)).toEqual({ value: 'Hel', remainder: 'lo', count: 3 })
    expect(takeStreamingBatch('👨‍👩‍👧‍👦 done', 1)).toEqual({ value: '👨‍👩‍👧‍👦', remainder: ' done', count: 1 })
    expect(takeStreamingBatch('', 4)).toEqual({ value: '', remainder: '', count: 0 })
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

    expect(screen.getByRole('region', { name: 'Conversation images' })).toBeTruthy()
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

  it('shows the exact provider destination and request images with a draft redaction entry point', async () => {
    const preview = vi.fn()
    const edit = vi.fn()
    const remove = vi.fn()
    render(
      <RequestDisclosure
        attachments={[
          { id: 'sent', thumbnailDataUrl: 'data:image/png;base64,c2VudA==', status: 'sent', edited: false, ocr: { status: 'idle' } },
          { id: 'draft', thumbnailDataUrl: 'data:image/png;base64,ZHJhZnQ=', status: 'draft', edited: false, ocr: { status: 'idle' } }
        ]}
        disclosure={{
          profileId: 'custom-1',
          profileName: 'Private gateway',
          provider: 'custom',
          baseUrl: 'https://gateway.example/v1',
          modelId: 'vision-1',
          modelName: 'Vision One',
          attachmentIds: ['sent', 'draft']
        }}
        disabled={false}
        onEdit={edit}
        onPreview={preview}
        onRemove={remove}
      />
    )

    expect(screen.getByRole('region', { name: 'Next request privacy' })).toBeTruthy()
    expect(screen.getByText('Private gateway')).toBeTruthy()
    expect(screen.getByText('Custom API · Vision One')).toBeTruthy()
    expect(screen.getByText('https://gateway.example/v1')).toBeTruthy()
    expect(screen.getByText(/cannot identify every kind of sensitive information/i)).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Preview screenshot 1 shared with the next request' }))
    expect(preview).toHaveBeenCalledWith('sent')
    fireEvent.click(screen.getByRole('button', { name: 'Review / redact' }))
    expect(edit).toHaveBeenCalledWith('draft')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(remove).toHaveBeenCalledWith('draft')

    const dismiss = screen.getByRole('button', { name: 'Dismiss next request details' })
    expect(dismiss.getAttribute('aria-expanded')).toBe('true')
    const detailsId = dismiss.getAttribute('aria-controls')
    expect(detailsId).toBeTruthy()
    expect(document.getElementById(detailsId ?? '')?.hasAttribute('hidden')).toBe(false)
    dismiss.focus()
    fireEvent.click(dismiss)
    expect(document.getElementById(detailsId ?? '')?.hasAttribute('hidden')).toBe(true)
    expect(screen.getByText('Private gateway · 2 images')).toBeTruthy()
    const review = screen.getByRole('button', { name: 'Review' })
    expect(review.getAttribute('aria-expanded')).toBe('false')
    expect(review.getAttribute('aria-controls')).toBe(detailsId)
    expect(document.getElementById(detailsId ?? '')?.hasAttribute('hidden')).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(review))
    fireEvent.click(review)
    expect(screen.getByText(/cannot identify every kind of sensitive information/i)).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss next request details' })))
  })

  it('re-expands a collapsed disclosure when its request destination, model, or images change', () => {
    const attachments = [
      { id: 'sent', thumbnailDataUrl: 'data:image/png;base64,c2VudA==', status: 'sent' as const, edited: false, ocr: { status: 'idle' as const } },
      { id: 'draft', thumbnailDataUrl: 'data:image/png;base64,ZHJhZnQ=', status: 'draft' as const, edited: false, ocr: { status: 'idle' as const } }
    ]
    let disclosure: RequestDisclosureState = {
      profileId: 'custom-1',
      profileName: 'Private gateway',
      provider: 'custom',
      baseUrl: 'https://gateway.example/v1',
      modelId: 'vision-1',
      modelName: 'Vision One',
      attachmentIds: ['sent', 'draft']
    }
    const disclosureView = (next: RequestDisclosureState): React.JSX.Element => (
      <RequestDisclosure
        attachments={attachments}
        disclosure={next}
        disabled={false}
        key={requestDisclosureKey(next)}
        onEdit={vi.fn()}
        onPreview={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const { rerender } = render(disclosureView(disclosure))
    const changedDestination = { ...disclosure, baseUrl: 'https://gateway.example/v2' }
    const changedModel = { ...changedDestination, modelId: 'vision-2', modelName: 'Vision Two' }
    const changedRequests: RequestDisclosureState[] = [
      changedDestination,
      changedModel,
      { ...changedModel, attachmentIds: ['sent'] }
    ]

    for (const changedRequest of changedRequests) {
      const dismiss = screen.getByRole('button', { name: 'Dismiss next request details' })
      fireEvent.click(dismiss)
      expect(document.getElementById(dismiss.getAttribute('aria-controls') ?? '')?.hasAttribute('hidden')).toBe(true)
      disclosure = changedRequest
      rerender(disclosureView(disclosure))
      const nextDismiss = screen.getByRole('button', { name: 'Dismiss next request details' })
      expect(document.getElementById(nextDismiss.getAttribute('aria-controls') ?? '')?.hasAttribute('hidden')).toBe(false)
    }
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

function installOpenExternal(openExternal: FoveaApi['openExternal']): void {
  Object.defineProperty(window, 'fovea', {
    configurable: true,
    value: { openExternal } as unknown as FoveaApi
  })
}

function renderExternalLink(markdown: string): HTMLAnchorElement {
  render(
    <ConversationTimeline
      exchanges={[{
        id: 'external-link',
        question: 'Where can I learn more?',
        answer: markdown,
        phase: 'completed',
        segmentId: 'segment-1'
      }]}
      onCopy={vi.fn(async () => undefined)}
      onResolveWebSearch={vi.fn()}
    />
  )
  return screen.getByRole('link') as HTMLAnchorElement
}
