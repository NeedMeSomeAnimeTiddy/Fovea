import type { BrowserWindow } from 'electron'
import type { QuestionViewState, RequestDisclosureState } from '@shared/contracts/ipc'
import type {
  ConversationExchange,
  ConversationSegment,
  ConversationSelection,
  QuestionDraft,
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
  /** Text recovered locally from imported files, resent with every turn. Empty for captures. */
  documentContext: string
  ocrContextByExchangeId: Map<string, string>
  draft: QuestionDraft | null
  launchError: string | null
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
    requestDisclosure: requestDisclosureForSession(session, profiles),
    disclosure: session.disclosure,
    busy: session.busy,
    pinned: session.pinned,
    draft: session.draft ? structuredClone(session.draft) : null,
    launchError: session.launchError
  }
}

/**
 * Describes exactly what the main-process send path would share if a request started now.
 * Direct API providers are stateless and receive every sent image on each turn. ChatGPT keeps
 * its provider conversation, so an existing context receives only newly drafted images.
 */
export function requestDisclosureForSession(
  session: QuestionSessionState,
  profiles: ProviderProfileSummary[]
): RequestDisclosureState | null {
  const selection = session.selection
  if (!selection) return null

  const profile = profiles.find((candidate) => candidate.id === selection.profileId)
  const model = session.models.find((candidate) => candidate.id === selection.modelId)

  return {
    profileId: selection.profileId,
    profileName: profile?.name ?? selection.profileId,
    provider: selection.provider,
    ...(selection.provider === 'custom' && profile?.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    modelId: selection.modelId,
    modelName: model?.displayName ?? selection.modelId,
    attachmentIds: requestAttachmentIdsForSession(session)
  }
}

/** Shared by disclosure and the provider send path so the preview cannot drift from the payload. */
export function requestAttachmentIdsForSession(session: QuestionSessionState): string[] {
  const selection = session.selection
  if (!selection) return []
  const providerSegment = session.segments.at(-1)
  const hasExistingChatGptContext = selection.provider === 'chatgpt' && Boolean(providerSegment?.conversationId)
  const attachments = hasExistingChatGptContext
    ? session.attachments.filter((attachment) => attachment.status === 'draft')
    : session.attachments
  return attachments.map((attachment) => attachment.id)
}
