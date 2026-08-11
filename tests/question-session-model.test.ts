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
      ocrContextByExchangeId: new Map(),
      draft: null,
      launchError: null
    }

    const snapshot = questionSessionSnapshot(state, [])
    expect(snapshot.attachments).toEqual([{
      id: 'attachment-1',
      thumbnailDataUrl: 'thumbnail',
      status: 'draft',
      edited: false,
      ocr: { status: 'idle' }
    }])
    expect(snapshot.requestDisclosure).toBeNull()
    expect(JSON.stringify(snapshot)).not.toContain('secret-path.png')
    attachment.status = 'sent'
    expect(snapshot.attachments[0]?.status).toBe('draft')
  })

  it('derives the exact next-request provider, destination, model, and attachments in main state', () => {
    const selection = { profileId: 'custom-1', provider: 'custom' as const, modelId: 'vision-1', reasoningEffort: null }
    const sent = createSessionAttachment('sent-path.png', 'sent', false, 'sent', () => 'sent-thumbnail')
    const draft = createSessionAttachment('draft-path.png', 'draft', false, 'draft', () => 'draft-thumbnail')
    const state: QuestionSessionState = {
      id: 'session-1',
      attachments: [sent, draft],
      window: null,
      previewWindow: null,
      previewAttachmentId: null,
      busy: false,
      cleaningUp: false,
      capturePending: false,
      phase: 'idle',
      selection,
      exchanges: [],
      segments: [{
        segment: { id: 'segment-1', selection, startedAt: '2026-08-04T00:00:00.000Z', disclosure: null },
        conversationId: 'direct-conversation'
      }],
      disclosure: null,
      models: [{ id: 'vision-1', displayName: 'Vision One', provider: 'custom', inputModalities: ['text', 'image'], supportedReasoningEfforts: [], isDefault: true }],
      initialization: Promise.resolve(),
      pinned: false,
      historyId: 'history-1',
      createdAt: '2026-08-04T00:00:00.000Z',
      documentContext: '',
      ocrContextByExchangeId: new Map(),
      draft: null,
      launchError: null
    }

    const direct = questionSessionSnapshot(state, [{
      id: 'custom-1',
      name: 'Private gateway',
      provider: 'custom',
      authentication: 'api-key',
      baseUrl: 'https://gateway.example/v1',
      authenticationState: 'signed-in',
      defaultModelId: 'vision-1',
      defaultReasoningEffort: null,
      health: 'available',
      isDefault: true
    }])
    expect(direct.requestDisclosure).toEqual({
      profileId: 'custom-1',
      profileName: 'Private gateway',
      provider: 'custom',
      baseUrl: 'https://gateway.example/v1',
      modelId: 'vision-1',
      modelName: 'Vision One',
      attachmentIds: ['sent', 'draft']
    })

    const chatGptSelection = { profileId: 'chatgpt-1', provider: 'chatgpt' as const, modelId: 'vision-1', reasoningEffort: null }
    state.selection = chatGptSelection
    state.segments = [{
      segment: { id: 'segment-2', selection: chatGptSelection, startedAt: '2026-08-04T00:01:00.000Z', disclosure: null },
      conversationId: 'stateful-conversation'
    }]
    const stateful = questionSessionSnapshot(state, [{
      id: 'chatgpt-1',
      name: 'ChatGPT work',
      provider: 'chatgpt',
      authentication: 'chatgpt-oauth',
      authenticationState: 'signed-in',
      defaultModelId: 'vision-1',
      defaultReasoningEffort: null,
      health: 'available',
      isDefault: true
    }])
    expect(stateful.requestDisclosure?.attachmentIds).toEqual(['draft'])
  })
})
