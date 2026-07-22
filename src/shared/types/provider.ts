export type ProviderState = 'starting' | 'ready' | 'signed-out' | 'error' | 'stopped'

export interface ProviderStatus {
  state: ProviderState
  version: string
  account: null | {
    type: 'chatgpt' | 'apiKey'
    email?: string | null
    planType?: string | null
  }
  error?: string
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
  imagePath?: string
  modelId: string
  reasoningEffort?: string | null
  history?: Array<{ role: 'user' | 'assistant'; text: string }>
  webSearchAllowed?: boolean
}

export type ProviderEvent =
  | { type: 'started'; turnId: string }
  | { type: 'delta'; text: string }
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'web-search-requested'; requestId: string; query: string }
  | { type: 'error'; message: string }
