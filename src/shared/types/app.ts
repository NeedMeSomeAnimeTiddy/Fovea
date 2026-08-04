import type { AssistantResponseMetadata, ProviderStatus } from './provider'
import type { AppError } from './app-error'

export type AppearancePreference = 'system' | 'dark' | 'light'
export type ResolvedAppearance = 'dark' | 'light'
export type OnboardingStatus = 'pending' | 'skipped' | 'completed'

export interface HistorySettings {
  privateMode: boolean
  retentionDays: number
  retainScreenshots: boolean
}

export interface ConversationHistorySummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  hasScreenshots: boolean
}

export type ImageEditTool = 'arrow' | 'rectangle' | 'freehand' | 'text' | 'blur' | 'redact'

export interface ImageEditPoint {
  x: number
  y: number
}

export interface ImageEditOperation {
  id: string
  tool: ImageEditTool
  points: ImageEditPoint[]
  text?: string
  strokeWidth?: number
}

export interface CustomPrompt {
  id: string
  label: string
  prompt: string
}

export interface AppearanceState {
  preference: AppearancePreference
  resolved: ResolvedAppearance
}

export type ProviderKind = 'chatgpt' | 'openai' | 'anthropic' | 'openrouter'
export type ProfileAuthentication = 'chatgpt-oauth' | 'api-key'
export type ProfileHealth = 'unknown' | 'checking' | 'available' | 'unavailable'

export interface ChatGptRuntimeStatus {
  state: 'not-installed' | 'checking' | 'downloading' | 'installed' | 'error' | 'unsupported'
  version: string
  architecture: string
  downloadBytes: number
  downloadedBytes: number
  installedBytes: number
  removable: boolean
  error?: string
}

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

export interface QuestionAttachment {
  id: string
  thumbnailDataUrl: string
  status: 'draft' | 'sent'
  edited: boolean
  ocr: OcrAttachmentState
}

export interface OcrLanguage {
  code: string
  label: string
  source: 'configured' | 'detected'
}

export interface OcrBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface OcrRegion {
  id: string
  text: string
  confidence: number
  bounds: OcrBounds
}

export interface OcrEntity {
  id: string
  kind: 'url' | 'email' | 'phone' | 'qr' | 'barcode'
  value: string
  bounds?: OcrBounds
}

export type OcrExternalActionKind = 'url' | 'email' | 'phone'
export type OcrPreprocessing = 'none' | 'upscaled-contrast' | 'high-contrast'
export type PaddleOcrProfile = 'small' | 'medium' | 'large'

export interface OcrResult {
  attachmentId: string
  text: string
  confidence: number
  quality: 'normal' | 'low-confidence'
  language: OcrLanguage
  regions: OcrRegion[]
  words?: OcrRegion[]
  truncated: boolean
  entities?: OcrEntity[]
  engine?: 'tesseract' | 'windows' | 'paddle'
  paddleProfile?: PaddleOcrProfile
  paddleModels?: {
    detector: string
    recognizer: string
  }
  cached?: boolean
  preprocessing?: OcrPreprocessing
  geometryCorrection?: 'deskewed' | 'perspective-corrected'
  durationMs?: number
}

export type OcrAttachmentState =
  | { status: 'idle' }
  | { status: 'running'; progress: number; stage: string }
  | {
      status: 'ready'
      confidence: number
      quality: OcrResult['quality']
      language: OcrLanguage
      regionCount: number
      selectedRegionCount: number
      selectedRegionIds: string[]
      includeNextRequest: boolean
      truncated: boolean
    }
  | { status: 'empty'; language: OcrLanguage }
  | { status: 'failed'; error: AppError }

export type ResponsePhase =
  | 'idle'
  | 'connecting'
  | 'thinking'
  | 'streaming'
  | 'awaiting-approval'
  | 'stopped'
  | 'completed'
  | 'failed'

export type SpectralEdgeState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'thinking'
  | 'streaming'
  | 'recovering'
  | 'completed'
  | 'stopped'
  | 'error'

export type CaptureMode = 'region' | 'display' | 'window' | 'repeat-last'
export type ShortcutAction = CaptureMode | 'settings'

export type CaptureFeatureKind = 'text' | 'control' | 'link' | 'error' | 'value' | 'visual' | 'face'

export interface CaptureFeature {
  id: string
  kind: CaptureFeatureKind
  label: string
  bounds: OcrBounds
  rank?: number
  source?: 'uia' | 'hybrid' | 'ocr-word' | 'ocr-line' | 'visual'
  detector?: 'heuristic' | 'omniparser' | 'yunet'
  role?: string
  description?: string
  enabled?: boolean
  visibility?: number
  visibilityVerified?: boolean
}

export interface CaptureAnalysis {
  features: CaptureFeature[]
  truncated: boolean
  stage?: 'semantic' | 'text' | 'visual'
  complete?: boolean
}

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
  source?: 'ai' | 'ocr'
  ocr?: {
    confidence: number
    quality: OcrResult['quality']
    language: OcrLanguage
    entities: OcrEntity[]
    engine: 'tesseract' | 'windows' | 'paddle'
    paddleProfile?: PaddleOcrProfile
    cached: boolean
    preprocessing: OcrPreprocessing
    geometryCorrection?: 'deskewed' | 'perspective-corrected'
    durationMs: number
  }
  attachmentIds?: string[]
  automatic?: boolean
  metadata?: AssistantResponseMetadata
  retryOf?: string
  error?: AppError
  webSearch?: {
    id: string
    query: string
    status: 'requested' | 'searching' | 'declined' | 'completed' | 'failed'
  }
}
