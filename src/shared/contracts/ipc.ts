import type { ProviderEvent } from '../types/provider'
import type { Rectangle } from '../types/geometry'
import type {
  AppearancePreference,
  AppearanceState,
  CaptureMode,
  ConversationExchange,
  ConversationSegment,
  ConversationSelection,
  CustomPrompt,
  OnboardingStatus,
  ProviderKind,
  ProviderModelCapability,
  ProviderProfileSummary,
  QuestionAttachment,
  ResponsePhase,
  ShortcutAction,
  ShortcutBindingState
} from '../types/app'

export const IPC = {
  appearanceGet: 'appearance:get',
  settingsGet: 'settings:get', settingsSetAppearance: 'settings:set-appearance', settingsSetLaunchAtLogin: 'settings:set-launch-at-login', settingsSetShortcut: 'settings:set-shortcut', settingsResetShortcuts: 'settings:reset-shortcuts', settingsSaveCustomPrompt: 'settings:save-custom-prompt', settingsDeleteCustomPrompt: 'settings:delete-custom-prompt', settingsSetOnboardingStatus: 'settings:set-onboarding-status', settingsTestOnboardingCapture: 'settings:test-onboarding-capture', settingsDeleteTemp: 'settings:delete-temp', settingsChanged: 'settings:changed', appearanceChanged: 'appearance:changed',
  profilesList: 'profiles:list', profilesCreateApiKey: 'profiles:create-api-key', profilesCreateChatGpt: 'profiles:create-chatgpt', profilesRename: 'profiles:rename', profilesAuthenticate: 'profiles:authenticate', profilesTest: 'profiles:test', profilesSignOut: 'profiles:sign-out', profilesDelete: 'profiles:delete', profilesSetDefault: 'profiles:set-default', profilesSetDefaults: 'profiles:set-defaults', profilesModels: 'profiles:models',
  captureStart: 'capture:start', captureGetContext: 'capture:get-context', captureSelect: 'capture:select', captureCancel: 'capture:cancel',
  questionGet: 'question:get', questionGetFullImage: 'question:get-full-image', questionSetSelection: 'question:set-selection', questionSetPinned: 'question:set-pinned', questionSetPreviewOpen: 'question:set-preview-open', questionRemoveAttachment: 'question:remove-attachment', questionSend: 'question:send', questionRetry: 'question:retry', questionResolveWebSearch: 'question:resolve-web-search', questionStop: 'question:stop', questionClose: 'question:close', questionAddSnip: 'question:add-snip', questionNewChat: 'question:new-chat', questionEvent: 'question:event', questionStateChanged: 'question:state-changed',
  applicationOpenSettings: 'application:open-settings',
  windowChromeGetState: 'window-chrome:get-state', windowChromeReady: 'window-chrome:ready', windowChromeMinimize: 'window-chrome:minimize', windowChromeToggleMaximize: 'window-chrome:toggle-maximize', windowChromeClose: 'window-chrome:close', windowChromeBeginResize: 'window-chrome:begin-resize', windowChromeUpdateResize: 'window-chrome:update-resize', windowChromeEndResize: 'window-chrome:end-resize', windowChromeStateChanged: 'window-chrome:state-changed', externalOpen: 'external:open'
} as const

export const WINDOW_RESIZE_EDGES = ['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-right', 'bottom-left'] as const
export type WindowResizeEdge = (typeof WINDOW_RESIZE_EDGES)[number]
export type WindowMaterial = 'transparent' | 'solid'
export interface WindowChromeState { focused: boolean; maximized: boolean; material: WindowMaterial; canMinimize: boolean; canMaximize: boolean; canResize: boolean }
export function isWindowResizeEdge(value: unknown): value is WindowResizeEdge { return typeof value === 'string' && WINDOW_RESIZE_EDGES.some((edge) => edge === value) }

export interface SettingsViewState {
  appearance: AppearanceState
  profiles: ProviderProfileSummary[]
  shortcuts: ShortcutBindingState[]
  customPrompts: CustomPrompt[]
  launchAtLogin: boolean
  onboardingStatus: OnboardingStatus
  tempLocation: string
  appVersion: string
}
export type OnboardingTestCaptureResult =
  | { status: 'captured'; thumbnailDataUrl: string }
  | { status: 'cancelled' }
export interface CaptureContext { width: number; height: number; minSelectionSize: number; displayId?: string; imageDataUrl: string }
export interface QuestionViewState {
  sessionId: string
  attachments: QuestionAttachment[]
  capturePending: boolean
  phase: ResponsePhase
  exchanges: ConversationExchange[]
  segments: ConversationSegment[]
  selection: ConversationSelection | null
  profiles: ProviderProfileSummary[]
  models: ProviderModelCapability[]
  disclosure: string | null
  busy: boolean
  pinned: boolean
}

export interface FoveaApi {
  profiles: {
    list(): Promise<ProviderProfileSummary[]>; createApiKey(provider: Exclude<ProviderKind, 'chatgpt'>, name: string, apiKey: string): Promise<ProviderProfileSummary>; createChatGpt(name?: string): Promise<ProviderProfileSummary>; rename(id: string, name: string): Promise<void>; authenticate(id: string): Promise<void>; test(id: string): Promise<ProviderModelCapability[]>; signOut(id: string): Promise<void>; delete(id: string): Promise<void>; setDefault(id: string): Promise<void>; setDefaults(id: string, modelId: string | null, reasoningEffort: string | null): Promise<void>; models(id: string): Promise<ProviderModelCapability[]>
  }
  settings: {
    get(): Promise<SettingsViewState>; setAppearance(preference: AppearancePreference): Promise<void>; setLaunchAtLogin(enabled: boolean): Promise<void>; setShortcut(action: ShortcutAction, accelerator: string | null): Promise<void>; resetShortcuts(): Promise<void>; saveCustomPrompt(id: string | null, label: string, prompt: string): Promise<void>; deleteCustomPrompt(id: string): Promise<void>; setOnboardingStatus(status: Exclude<OnboardingStatus, 'pending'>): Promise<void>; testOnboardingCapture(): Promise<OnboardingTestCaptureResult>; deleteTemporaryFiles(): Promise<number>; onChanged(callback: (state: SettingsViewState) => void): () => void; onAppearanceChanged(callback: (state: AppearanceState) => void): () => void
  }
  capture: { start(mode: CaptureMode): Promise<void>; getContext(): Promise<CaptureContext>; select(rectangle: Rectangle): Promise<void>; cancel(): Promise<void> }
  question: { get(sessionId: string): Promise<QuestionViewState>; getFullImage(sessionId: string, attachmentId: string): Promise<string>; setSelection(sessionId: string, selection: ConversationSelection): Promise<QuestionViewState>; setPinned(sessionId: string, pinned: boolean): Promise<void>; setPreviewOpen(sessionId: string, attachmentId: string | null): Promise<void>; removeAttachment(sessionId: string, attachmentId: string): Promise<QuestionViewState>; send(sessionId: string, text: string, preferWebSearch?: boolean): Promise<void>; retry(sessionId: string, exchangeId: string): Promise<void>; resolveWebSearch(sessionId: string, requestId: string, approved: boolean): Promise<QuestionViewState>; stop(sessionId: string): Promise<void>; close(sessionId: string): Promise<void>; addSnip(sessionId: string): Promise<void>; newChat(sessionId: string): Promise<void>; onEvent(callback: (sessionId: string, event: ProviderEvent) => void): () => void; onChanged(callback: (state: QuestionViewState) => void): () => void }
  application: { openSettings(): Promise<void> }
  windowChrome: { getState(): Promise<WindowChromeState>; ready(): void; minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void>; beginResize(edge: WindowResizeEdge): Promise<void>; updateResize(): void; endResize(): void; onStateChanged(callback: (state: WindowChromeState) => void): () => void }
  openExternal(url: string): Promise<void>
}
