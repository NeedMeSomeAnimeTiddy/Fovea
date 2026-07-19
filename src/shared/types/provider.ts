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

export type ProviderEvent =
  | { type: 'started'; turnId: string }
  | { type: 'delta'; text: string }
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }

