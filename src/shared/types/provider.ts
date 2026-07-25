import type { AppError } from './app-error'

export type ProviderState = 'starting' | 'ready' | 'signed-out' | 'error' | 'stopped'

export interface ProviderStatus {
  state: ProviderState
  recovering?: boolean
  version: string
  account: null | {
    type: 'chatgpt' | 'apiKey'
    email?: string | null
    planType?: string | null
  }
  error?: AppError
}

export interface VisionModel {
  id: string
  displayName: string
  isDefault: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts: string[]
  inputModalities: string[]
}

export interface VisionTurnInput {
  text: string
  imagePaths?: string[]
  modelId: string
  reasoningEffort?: string | null
  history?: Array<{ role: 'user' | 'assistant'; text: string }>
  webSearchAllowed?: boolean
  webSearchPreferred?: boolean
}

export interface AssistantResponseMetadata {
  category: string
  summary: string
  suggestedQuestions: string[]
}

export type ProviderEvent =
  | { type: 'started'; turnId: string }
  | { type: 'delta'; text: string }
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'response-metadata'; metadata: AssistantResponseMetadata }
  | { type: 'web-search-requested'; requestId: string; query: string }
  | { type: 'error'; error: AppError }
