import type { ProviderEvent } from '../types/provider'
import type { Rectangle } from '../types/geometry'
import type { ApplicationUpdateState } from '../types/update'
import type {
  AppearancePreference,
  AppearanceState,
  CaptureAnalysis,
  CaptureRecipe,
  CaptureMode,
  ChatGptRuntimeStatus,
  ConversationExchange,
  ConversationExportOptions,
  ConversationExportPreview,
  ConversationHistorySummary,
  ConversationSegment,
  ConversationSelection,
  CustomPrompt,
  HistorySettings,
  ImageImportResult,
  ImageEditOperation,
  OcrLanguage,
  OcrExternalActionKind,
  OcrResult,
  OnboardingStatus,
  ProviderKind,
  ProviderModelCapability,
  ProviderProfileSummary,
  QuestionAttachment,
  QuestionDraft,
  RecipeShortcutBindingState,
  ResponsePhase,
  ShortcutAction,
  ShortcutBindingState
} from '../types/app'

export const IPC = {
  appearanceGet: 'appearance:get',
  settingsGet: 'settings:get', settingsOpenOcrLanguages: 'settings:open-ocr-languages', settingsSetAppearance: 'settings:set-appearance', settingsSetLaunchAtLogin: 'settings:set-launch-at-login', settingsSetShellIntegration: 'settings:set-shell-integration', settingsSetShortcut: 'settings:set-shortcut', settingsResetShortcuts: 'settings:reset-shortcuts', settingsSaveCustomPrompt: 'settings:save-custom-prompt', settingsDeleteCustomPrompt: 'settings:delete-custom-prompt', settingsSaveRecipe: 'settings:save-recipe', settingsDuplicateRecipe: 'settings:duplicate-recipe', settingsDeleteRecipe: 'settings:delete-recipe', settingsReorderRecipes: 'settings:reorder-recipes', settingsExportRecipes: 'settings:export-recipes', settingsImportRecipes: 'settings:import-recipes', settingsSetOnboardingStatus: 'settings:set-onboarding-status', settingsSetPrivateMode: 'settings:set-private-mode', settingsSetHistoryRetention: 'settings:set-history-retention', settingsSetScreenshotRetention: 'settings:set-screenshot-retention', settingsTestOnboardingCapture: 'settings:test-onboarding-capture', settingsDeleteTemp: 'settings:delete-temp', settingsChanged: 'settings:changed', appearanceChanged: 'appearance:changed',
  profilesList: 'profiles:list', profilesCreateApiKey: 'profiles:create-api-key', profilesCreateChatGpt: 'profiles:create-chatgpt', profilesAuthenticate: 'profiles:authenticate', profilesRename: 'profiles:rename', profilesTest: 'profiles:test', profilesSignOut: 'profiles:sign-out', profilesDelete: 'profiles:delete', profilesSetDefault: 'profiles:set-default', profilesSetDefaults: 'profiles:set-defaults', profilesModels: 'profiles:models',
  chatGptRuntimeInstall: 'chatgpt-runtime:install', chatGptRuntimeRemove: 'chatgpt-runtime:remove',
  captureStart: 'capture:start', captureGetContext: 'capture:get-context', captureAnalyze: 'capture:analyze', captureAnalysisProgress: 'capture:analysis-progress', captureCancelAnalysis: 'capture:cancel-analysis', captureGetOcrLanguages: 'capture:get-ocr-languages', captureSetOcrLanguage: 'capture:set-ocr-language', captureSelect: 'capture:select', captureCancel: 'capture:cancel',
  questionGet: 'question:get', questionGetFullImage: 'question:get-full-image', questionRunOcr: 'question:run-ocr', questionGetOcrResult: 'question:get-ocr-result', questionSetOcrSelection: 'question:set-ocr-selection', questionSetSelection: 'question:set-selection', questionSetPinned: 'question:set-pinned', questionSetPreviewOpen: 'question:set-preview-open', questionRemoveAttachment: 'question:remove-attachment', questionApplyAttachmentEdits: 'question:apply-attachment-edits', questionImportClipboardImage: 'question:import-clipboard-image', questionPickImages: 'question:pick-images', questionImportDroppedFiles: 'question:import-dropped-files', questionExportPreview: 'question:export-preview', questionExport: 'question:export', questionSend: 'question:send', questionRetry: 'question:retry', questionResolveWebSearch: 'question:resolve-web-search', questionStop: 'question:stop', questionClose: 'question:close', questionAddSnip: 'question:add-snip', questionNewChat: 'question:new-chat', questionEvent: 'question:event', questionStateChanged: 'question:state-changed',
  historyList: 'history:list', historyOpen: 'history:open', historyDelete: 'history:delete', historyClear: 'history:clear', historyExportPreview: 'history:export-preview', historyExport: 'history:export',
  updatesSetAutomaticChecks: 'updates:set-automatic-checks', updatesCheck: 'updates:check', updatesDownload: 'updates:download', updatesInstall: 'updates:install',
  applicationOpenSettings: 'application:open-settings', clipboardWriteText: 'clipboard:write-text',
  windowChromeGetState: 'window-chrome:get-state', windowChromeReady: 'window-chrome:ready', windowChromeMinimize: 'window-chrome:minimize', windowChromeToggleMaximize: 'window-chrome:toggle-maximize', windowChromeClose: 'window-chrome:close', windowChromeBeginResize: 'window-chrome:begin-resize', windowChromeUpdateResize: 'window-chrome:update-resize', windowChromeEndResize: 'window-chrome:end-resize', windowChromeStateChanged: 'window-chrome:state-changed', externalOpen: 'external:open', externalOpenOcrEntity: 'external:open-ocr-entity'
} as const

export const WINDOW_RESIZE_EDGES = ['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-right', 'bottom-left'] as const
export type WindowResizeEdge = (typeof WINDOW_RESIZE_EDGES)[number]
export type WindowMaterial = 'transparent' | 'solid'
export interface WindowChromeState { focused: boolean; maximized: boolean; material: WindowMaterial; canMinimize: boolean; canMaximize: boolean; canResize: boolean }
export function isWindowResizeEdge(value: unknown): value is WindowResizeEdge { return typeof value === 'string' && WINDOW_RESIZE_EDGES.some((edge) => edge === value) }

export interface ShellIntegrationState {
  enabled: boolean
  supported: boolean
  /** False when the registry no longer matches what Fovea wrote, so the UI can offer a repair. */
  registered: boolean
}

export interface SettingsViewState {
  appearance: AppearanceState
  profiles: ProviderProfileSummary[]
  chatGptRuntime: ChatGptRuntimeStatus
  shortcuts: ShortcutBindingState[]
  recipeShortcuts: RecipeShortcutBindingState[]
  customPrompts: CustomPrompt[]
  recipes: CaptureRecipe[]
  launchAtLogin: boolean
  shellIntegration: ShellIntegrationState
  onboardingStatus: OnboardingStatus
  tempLocation: string
  appVersion: string
  updates: ApplicationUpdateState
  history: HistorySettings
  ocrLanguageCode?: string
}
export type OnboardingTestCaptureResult =
  | { status: 'captured'; thumbnailDataUrl: string }
  | { status: 'cancelled' }
export interface CaptureContext { width: number; height: number; minSelectionSize: number; displayId?: string; imageDataUrl: string; canEditBeforeSending: boolean }
export interface RequestDisclosureState {
  profileId: string
  profileName: string
  provider: ProviderKind
  baseUrl?: string
  modelId: string
  modelName: string
  /** Attachment ids the main process will include if the user sends the next request now. */
  attachmentIds: string[]
}
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
  requestDisclosure?: RequestDisclosureState | null
  disclosure: string | null
  busy: boolean
  pinned: boolean
  draft: QuestionDraft | null
  launchError: string | null
}

export interface FoveaApi {
  profiles: {
    list(): Promise<ProviderProfileSummary[]>; createApiKey(provider: Exclude<ProviderKind, 'chatgpt'>, name: string, apiKey: string, endpoint?: { baseUrl?: string; modelIds?: string[] }): Promise<ProviderProfileSummary>;createChatGpt(name?: string): Promise<ProviderProfileSummary>; rename(id: string, name: string): Promise<void>; authenticate(id: string): Promise<void>; test(id: string): Promise<ProviderModelCapability[]>; signOut(id: string): Promise<void>; delete(id: string): Promise<void>; setDefault(id: string): Promise<void>; setDefaults(id: string, modelId: string | null, reasoningEffort: string | null): Promise<void>; models(id: string): Promise<ProviderModelCapability[]>
  }
  chatGptRuntime: { install(): Promise<ChatGptRuntimeStatus>; remove(): Promise<ChatGptRuntimeStatus> }
  settings: {
    get(): Promise<SettingsViewState>; openOcrLanguages(): Promise<void>; setAppearance(preference: AppearancePreference): Promise<void>; setLaunchAtLogin(enabled: boolean): Promise<void>; setShellIntegration(enabled: boolean): Promise<void>; setShortcut(action: ShortcutAction, accelerator: string | null): Promise<void>; resetShortcuts(): Promise<void>; saveCustomPrompt(id: string | null, label: string, prompt: string): Promise<void>; deleteCustomPrompt(id: string): Promise<void>; saveRecipe(recipe: CaptureRecipe): Promise<void>; duplicateRecipe(id: string): Promise<void>; deleteRecipe(id: string): Promise<void>; reorderRecipes(ids: string[]): Promise<void>; exportRecipes(): Promise<boolean>; importRecipes(): Promise<number>; setOnboardingStatus(status: Exclude<OnboardingStatus, 'pending'>): Promise<void>; setPrivateMode(enabled: boolean): Promise<void>; setHistoryRetention(days: number): Promise<void>; setScreenshotRetention(enabled: boolean): Promise<void>; testOnboardingCapture(): Promise<OnboardingTestCaptureResult>; deleteTemporaryFiles(): Promise<number>; onChanged(callback: (state: SettingsViewState) => void): () => void; onAppearanceChanged(callback: (state: AppearanceState) => void): () => void
  }
  capture: { start(mode: CaptureMode): Promise<void>; getContext(): Promise<CaptureContext>; analyze(onProgress?: (analysis: CaptureAnalysis) => void): Promise<CaptureAnalysis>; cancelAnalysis(): Promise<void>; getOcrLanguages(): Promise<OcrLanguage[]>; setOcrLanguage(code: string): Promise<void>; select(rectangle: Rectangle, operations?: ImageEditOperation[], preferWebSearch?: boolean, extractText?: boolean, ocrLanguageCode?: string, initialQuestion?: string): Promise<void>; cancel(): Promise<void> }
  question: { get(sessionId: string): Promise<QuestionViewState>; getFullImage(sessionId: string, attachmentId: string): Promise<string>; runOcr(sessionId: string, attachmentId: string): Promise<OcrResult>; getOcrResult(sessionId: string, attachmentId: string): Promise<OcrResult | null>; setOcrSelection(sessionId: string, attachmentId: string, regionIds: string[], includeNextRequest: boolean): Promise<QuestionViewState>; setSelection(sessionId: string, selection: ConversationSelection): Promise<QuestionViewState>; setPinned(sessionId: string, pinned: boolean): Promise<void>; setPreviewOpen(sessionId: string, attachmentId: string | null): Promise<void>; removeAttachment(sessionId: string, attachmentId: string): Promise<QuestionViewState>; applyAttachmentEdits(sessionId: string, attachmentId: string, operations: ImageEditOperation[]): Promise<QuestionViewState>; importClipboardImage(sessionId: string): Promise<ImageImportResult>; pickImages(sessionId: string): Promise<ImageImportResult>; importDroppedFiles(sessionId: string, files: File[]): Promise<ImageImportResult>; exportPreview(sessionId: string): Promise<ConversationExportPreview>; exportConversation(sessionId: string, options: ConversationExportOptions): Promise<boolean>; send(sessionId: string, text: string, preferWebSearch?: boolean): Promise<void>; retry(sessionId: string, exchangeId: string): Promise<void>; resolveWebSearch(sessionId: string, requestId: string, approved: boolean): Promise<QuestionViewState>; stop(sessionId: string): Promise<void>; close(sessionId: string): Promise<void>; addSnip(sessionId: string): Promise<void>; newChat(sessionId: string): Promise<void>; onEvent(callback: (sessionId: string, event: ProviderEvent) => void): () => void; onChanged(callback: (state: QuestionViewState) => void): () => void }
  history: { list(query?: string): Promise<ConversationHistorySummary[]>; open(id: string): Promise<void>; delete(id: string): Promise<void>; clear(): Promise<number>; exportPreview(id: string): Promise<ConversationExportPreview>; exportConversation(id: string, options: ConversationExportOptions): Promise<boolean> }
  updates: { setAutomaticChecks(enabled: boolean): Promise<ApplicationUpdateState>; check(): Promise<ApplicationUpdateState>; download(): Promise<ApplicationUpdateState>; install(): Promise<ApplicationUpdateState> }
  application: { openSettings(): Promise<void> }
  clipboard: { writeText(value: string): Promise<void> }
  windowChrome: { getState(): Promise<WindowChromeState>; ready(): void; minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void>; beginResize(edge: WindowResizeEdge): Promise<void>; updateResize(): void; endResize(): void; onStateChanged(callback: (state: WindowChromeState) => void): () => void }
  openExternal(url: string): Promise<void>
  openOcrEntity(kind: OcrExternalActionKind, value: string): Promise<void>
}
