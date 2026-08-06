import { describe, expect, it } from 'vitest'
import { questionSessionSnapshot, type QuestionSessionState } from '../src/main/windows/question-session-model'
import { createSessionAttachment } from '../src/main/windows/question-attachments'

describe('typed question session snapshot', () => {
  it('exposes renderer-safe state without paths or mutable references', () => {
    const attachment = createSessionAttachment('secret-path.png', 'draft', false, 'attachment-1', () => 'thumbnail')
    const state: QuestionSessionState = {
      id: 'session-1',
      attachments: [attachment],
      window: null,
      previewWindow: null,
      previewAttachmentId: null,
      busy: false,
      cleaningUp: false,
      capturePending: false,
      phase: 'idle',
      selection: null,
      exchanges: [],
      segments: [],
      disclosure: null,
      models: [],
      initialization: Promise.resolve(),
      pinned: false,
      historyId: 'history-1',
      createdAt: '2026-08-04T00:00:00.000Z',
      documentContext: '',
      ocrContextByExchangeId: new Map()
    }

    const snapshot = questionSessionSnapshot(state, [])
    expect(snapshot.attachments).toEqual([{
      id: 'attachment-1',
      thumbnailDataUrl: 'thumbnail',
      status: 'draft',
      edited: false,
      ocr: { status: 'idle' }
    }])
    expect(JSON.stringify(snapshot)).not.toContain('secret-path.png')
    attachment.status = 'sent'
    expect(snapshot.attachments[0]?.status).toBe('draft')
  })
})
