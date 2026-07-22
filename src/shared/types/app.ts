import type { ProviderStatus } from './provider'

export type AppearancePreference = 'system' | 'dark' | 'light'
export type ResolvedAppearance = 'dark' | 'light'

export interface AppearanceState {
  preference: AppearancePreference
  resolved: ResolvedAppearance
}

export type ProviderKind = 'chatgpt' | 'openai' | 'anthropic' | 'openrouter'
export type ProfileAuthentication = 'chatgpt-oauth' | 'api-key'
export type ProfileHealth = 'unknown' | 'checking' | 'available' | 'unavailable'

export interface ProviderModelCapability {
  id: string
  displayName: string
  provider: ProviderKind
  inputModalities: string[]
  supportedReasoningEfforts: string[]
  defaultReasoningEffort?: string
  isDefault: boolean
  unavailableReason?: string
}

export interface ProviderProfileSummary {
  id: string
  name: string
  provider: ProviderKind
  authentication: ProfileAuthentication
  authenticationState: 'signed-in' | 'signed-out' | 'error'
  accountLabel?: string
  defaultModelId: string | null
  defaultReasoningEffort: string | null
  health: ProfileHealth
  healthMessage?: string
  lastHealthCheckAt?: string
  isDefault: boolean
  status?: ProviderStatus
}

export interface ConversationSelection {
  profileId: string
  provider: ProviderKind
  modelId: string
  reasoningEffort: string | null
}

export interface ConversationSegment {
  id: string
  selection: ConversationSelection
  startedAt: string
  disclosure: string | null
}

export type ResponsePhase =
  | 'idle'
  | 'connecting'
  | 'thinking'
  | 'streaming'
  | 'awaiting-approval'
  | 'stopped'
  | 'completed'
  | 'failed'

export type CaptureMode = 'region' | 'display' | 'window' | 'repeat-last'
export type ShortcutAction = CaptureMode | 'settings'

export interface ShortcutBindingState {
  action: ShortcutAction
  accelerator: string | null
  registered: boolean
  error?: string
}

export interface ConversationExchange {
  id: string
  question: string
  answer: string
  phase: ResponsePhase
  segmentId: string
  error?: string
  webSearch?: {
    id: string
    query: string
    status: 'requested' | 'searching' | 'declined' | 'completed' | 'failed'
  }
}
