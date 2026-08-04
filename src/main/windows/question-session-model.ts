import type { BrowserWindow } from 'electron'
import type { QuestionViewState } from '@shared/contracts/ipc'
import type {
  ConversationExchange,
  ConversationSegment,
  ConversationSelection,
  ProviderModelCapability,
  ProviderProfileSummary,
  ResponsePhase
} from '@shared/types/app'
import type { SessionAttachment } from './question-attachments'

export interface ProviderSegmentState {
  segment: ConversationSegment
  conversationId: string | null
}

export interface QuestionSessionState {
  id: string
  attachments: SessionAttachment[]
  window: BrowserWindow | null
  previewWindow: BrowserWindow | null
  previewAttachmentId: string | null
  busy: boolean
  cleaningUp: boolean
  capturePending: boolean
  phase: ResponsePhase
  selection: ConversationSelection | null
  exchanges: ConversationExchange[]
  segments: ProviderSegmentState[]
  disclosure: string | null
  models: ProviderModelCapability[]
  initialization: Promise<void>
  pinned: boolean
  historyId: string
  createdAt: string
  ocrContextByExchangeId: Map<string, string>
}

export function questionSessionSnapshot(
  session: QuestionSessionState,
  profiles: ProviderProfileSummary[]
): QuestionViewState {
  return {
    sessionId: session.id,
    attachments: session.attachments.map(({ id, thumbnailDataUrl, status, edited, ocr }) => ({
      id,
      thumbnailDataUrl,
      status,
      edited,
      ocr: structuredClone(ocr)
    })),
    capturePending: session.capturePending,
    phase: session.phase,
    exchanges: structuredClone(session.exchanges),
    segments: session.segments.map((item) => structuredClone(item.segment)),
    selection: session.selection ? structuredClone(session.selection) : null,
    profiles: structuredClone(profiles),
    models: structuredClone(session.models),
    disclosure: session.disclosure,
    busy: session.busy,
    pinned: session.pinned
  }
}
