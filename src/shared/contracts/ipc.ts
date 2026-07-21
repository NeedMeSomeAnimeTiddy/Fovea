import type { ProviderEvent } from '../types/provider'
import type { Rectangle } from '../types/geometry'
import type {
  AppearancePreference,
  AppearanceState,
  CaptureMode,
  ConversationExchange,
  ConversationSegment,
  ConversationSelection,
  ProviderKind,
  ProviderModelCapability,
  ProviderProfileSummary,
  ResponsePhase,
  ShortcutAction,
  ShortcutBindingState
} from '../types/app'

export const IPC = {
  appearanceGet: 'appearance:get',
  settingsGet: 'settings:get', settingsSetAppearance: 'settings:set-appearance', settingsSetLaunchAtLogin: 'settings:set-launch-at-login', settingsSetShortcut: 'settings:set-shortcut', settingsResetShortcuts: 'settings:reset-shortcuts', settingsCompleteOnboarding: 'settings:complete-onboarding', settingsDeleteTemp: 'settings:delete-temp', settingsChanged: 'settings:changed', appearanceChanged: 'appearance:changed',
  profilesList: 'profiles:list', profilesCreateApiKey: 'profiles:create-api-key', profilesCreateChatGpt: 'profiles:create-chatgpt', profilesRename: 'profiles:rename', profilesAuthenticate: 'profiles:authenticate', profilesTest: 'profiles:test', profilesSignOut: 'profiles:sign-out', profilesDelete: 'profiles:delete', profilesSetDefault: 'profiles:set-default', profilesSetDefaults: 'profiles:set-defaults', profilesModels: 'profiles:models',
  captureStart: 'capture:start', captureGetContext: 'capture:get-context', captureSelect: 'capture:select', captureCancel: 'capture:cancel',
  questionGet: 'question:get', questionSetSelection: 'question:set-selection', questionSend: 'question:send', questionStop: 'question:stop', questionClose: 'question:close', questionNewSnip: 'question:new-snip', questionEvent: 'question:event',
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
  launchAtLogin: boolean
  onboardingCompleted: boolean
  tempLocation: string
  appVersion: string
}
export interface CaptureContext { width: number; height: number; minSelectionSize: number; displayId?: string }
export interface QuestionViewState {
  sessionId: string
  thumbnailDataUrl: string
  phase: ResponsePhase
  exchanges: ConversationExchange[]
  segments: ConversationSegment[]
  selection: ConversationSelection | null
  profiles: ProviderProfileSummary[]
  models: ProviderModelCapability[]
  disclosure: string | null
  busy: boolean
}

export interface FoveaApi {
  profiles: {
    list(): Promise<ProviderProfileSummary[]>; createApiKey(provider: Exclude<ProviderKind, 'chatgpt'>, name: string, apiKey: string): Promise<ProviderProfileSummary>; createChatGpt(name?: string): Promise<ProviderProfileSummary>; rename(id: string, name: string): Promise<void>; authenticate(id: string): Promise<void>; test(id: string): Promise<ProviderModelCapability[]>; signOut(id: string): Promise<void>; delete(id: string): Promise<void>; setDefault(id: string): Promise<void>; setDefaults(id: string, modelId: string | null, reasoningEffort: string | null): Promise<void>; models(id: string): Promise<ProviderModelCapability[]>
  }
  settings: {
    get(): Promise<SettingsViewState>; setAppearance(preference: AppearancePreference): Promise<void>; setLaunchAtLogin(enabled: boolean): Promise<void>; setShortcut(action: ShortcutAction, accelerator: string | null): Promise<void>; resetShortcuts(): Promise<void>; completeOnboarding(): Promise<void>; deleteTemporaryFiles(): Promise<number>; onChanged(callback: (state: SettingsViewState) => void): () => void; onAppearanceChanged(callback: (state: AppearanceState) => void): () => void
  }
  capture: { start(mode: CaptureMode): Promise<void>; getContext(): Promise<CaptureContext>; select(rectangle: Rectangle): Promise<void>; cancel(): Promise<void> }
  question: { get(sessionId: string): Promise<QuestionViewState>; setSelection(sessionId: string, selection: ConversationSelection): Promise<QuestionViewState>; send(sessionId: string, text: string): Promise<void>; stop(sessionId: string): Promise<void>; close(sessionId: string): Promise<void>; newSnip(sessionId: string): Promise<void>; onEvent(callback: (sessionId: string, event: ProviderEvent) => void): () => void }
  application: { openSettings(): Promise<void> }
  windowChrome: { getState(): Promise<WindowChromeState>; ready(): void; minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void>; beginResize(edge: WindowResizeEdge): Promise<void>; updateResize(): void; endResize(): void; onStateChanged(callback: (state: WindowChromeState) => void): () => void }
  openExternal(url: string): Promise<void>
}
