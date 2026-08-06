import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type FoveaApi, type QuestionViewState, type SettingsViewState, type WindowChromeState } from '@shared/contracts/ipc'
import type { AppearanceState, CaptureAnalysis } from '@shared/types/app'
import type { ProviderEvent } from '@shared/types/provider'
import type { IpcResult } from '@shared/types/app-error'

const initialAppearance = ipcRenderer.sendSync(IPC.appearanceGet) as AppearanceState
applyInitialAppearance(initialAppearance)
let captureAnalysisRequestSequence = 0

function applyInitialAppearance(appearance: AppearanceState): void {
  const apply = (): boolean => {
    const root = document.documentElement
    if (!root) return false
    root.dataset.appearance = appearance.preference
    root.dataset.theme = appearance.resolved
    return true
  }
  if (apply()) return
  const observer = new MutationObserver(() => {
    if (!apply()) return
    observer.disconnect()
  })
  observer.observe(document, { childList: true, subtree: true })
}

const api: FoveaApi = {
  profiles: {
    list: () => invokeResult(IPC.profilesList),
    createApiKey: (provider, name, apiKey, endpoint) => invokeResult(IPC.profilesCreateApiKey, provider, name, apiKey, endpoint),
    createChatGpt: (name) => invokeResult(IPC.profilesCreateChatGpt, name),
    rename: (id, name) => invokeResult(IPC.profilesRename, id, name),
    authenticate: (id) => invokeResult(IPC.profilesAuthenticate, id),
    test: (id) => invokeResult(IPC.profilesTest, id),
    signOut: (id) => invokeResult(IPC.profilesSignOut, id),
    delete: (id) => invokeResult(IPC.profilesDelete, id),
    setDefault: (id) => invokeResult(IPC.profilesSetDefault, id),
    setDefaults: (id, modelId, reasoning) => invokeResult(IPC.profilesSetDefaults, id, modelId, reasoning),
    models: (id) => invokeResult(IPC.profilesModels, id)
  },
  chatGptRuntime: {
    install: () => invokeResult(IPC.chatGptRuntimeInstall),
    remove: () => invokeResult(IPC.chatGptRuntimeRemove)
  },
  settings: {
    get: () => invokeResult(IPC.settingsGet), openOcrLanguages: () => invokeResult(IPC.settingsOpenOcrLanguages), setAppearance: (value) => invokeResult(IPC.settingsSetAppearance, value), setLaunchAtLogin: (enabled) => invokeResult(IPC.settingsSetLaunchAtLogin, enabled), setShellIntegration: (enabled) => invokeResult(IPC.settingsSetShellIntegration, enabled), setShortcut: (action, accelerator) => invokeResult(IPC.settingsSetShortcut, action, accelerator), resetShortcuts: () => invokeResult(IPC.settingsResetShortcuts), saveCustomPrompt: (id, label, prompt) => invokeResult(IPC.settingsSaveCustomPrompt, id, label, prompt), deleteCustomPrompt: (id) => invokeResult(IPC.settingsDeleteCustomPrompt, id), saveRecipe: (recipe) => invokeResult(IPC.settingsSaveRecipe, recipe), duplicateRecipe: (id) => invokeResult(IPC.settingsDuplicateRecipe, id), deleteRecipe: (id) => invokeResult(IPC.settingsDeleteRecipe, id), reorderRecipes: (ids) => invokeResult(IPC.settingsReorderRecipes, ids), exportRecipes: () => invokeResult(IPC.settingsExportRecipes), importRecipes: () => invokeResult(IPC.settingsImportRecipes), setOnboardingStatus: (status) => invokeResult(IPC.settingsSetOnboardingStatus, status), setPrivateMode: (enabled) => invokeResult(IPC.settingsSetPrivateMode, enabled), setHistoryRetention: (days) => invokeResult(IPC.settingsSetHistoryRetention, days), setScreenshotRetention: (enabled) => invokeResult(IPC.settingsSetScreenshotRetention, enabled), testOnboardingCapture: () => invokeResult(IPC.settingsTestOnboardingCapture), deleteTemporaryFiles: () => invokeResult(IPC.settingsDeleteTemp),
    onChanged: (callback) => subscribe(IPC.settingsChanged, callback), onAppearanceChanged: (callback) => subscribe(IPC.appearanceChanged, callback)
  },
  capture: { start: (mode) => invokeResult(IPC.captureStart, mode), getContext: () => invokeResult(IPC.captureGetContext), analyze: (onProgress) => runCaptureAnalysis(onProgress), cancelAnalysis: () => invokeResult(IPC.captureCancelAnalysis), getOcrLanguages: () => invokeResult(IPC.captureGetOcrLanguages), setOcrLanguage: (code) => invokeResult(IPC.captureSetOcrLanguage, code), select: (rectangle, operations = [], preferWebSearch = false, extractText = false, ocrLanguageCode, initialQuestion) => invokeResult(IPC.captureSelect, rectangle, operations, preferWebSearch, extractText, ocrLanguageCode, initialQuestion), cancel: () => invokeResult(IPC.captureCancel) },
  question: {
    get: (id) => invokeResult(IPC.questionGet, id), getFullImage: (id, attachmentId) => invokeResult(IPC.questionGetFullImage, id, attachmentId), runOcr: (id, attachmentId) => invokeResult(IPC.questionRunOcr, id, attachmentId), getOcrResult: (id, attachmentId) => invokeResult(IPC.questionGetOcrResult, id, attachmentId), setOcrSelection: (id, attachmentId, regionIds, includeNextRequest) => invokeResult(IPC.questionSetOcrSelection, id, attachmentId, regionIds, includeNextRequest), setSelection: (id, selection) => invokeResult(IPC.questionSetSelection, id, selection), setPinned: (id, pinned) => invokeResult(IPC.questionSetPinned, id, pinned), setPreviewOpen: (id, attachmentId) => invokeResult(IPC.questionSetPreviewOpen, id, attachmentId), removeAttachment: (id, attachmentId) => invokeResult(IPC.questionRemoveAttachment, id, attachmentId), applyAttachmentEdits: (id, attachmentId, operations) => invokeResult(IPC.questionApplyAttachmentEdits, id, attachmentId, operations), importClipboardImage: (id) => invokeResult(IPC.questionImportClipboardImage, id), pickImages: (id) => invokeResult(IPC.questionPickImages, id), importDroppedFiles: (id, files) => invokeResult(IPC.questionImportDroppedFiles, id, files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)), exportPreview: (id) => invokeResult(IPC.questionExportPreview, id), exportConversation: (id, options) => invokeResult(IPC.questionExport, id, options), send: (id, text, preferWebSearch = false) => invokeResult(IPC.questionSend, id, text, preferWebSearch), retry: (id, exchangeId) => invokeResult(IPC.questionRetry, id, exchangeId), resolveWebSearch: (id, requestId, approved) => invokeResult(IPC.questionResolveWebSearch, id, requestId, approved), stop: (id) => invokeResult(IPC.questionStop, id), close: (id) => invokeResult(IPC.questionClose, id), addSnip: (id) => invokeResult(IPC.questionAddSnip, id), newChat: (id) => invokeResult(IPC.questionNewChat, id),
    onEvent: (callback) => { const listener = (_event: Electron.IpcRendererEvent, id: string, event: ProviderEvent): void => callback(id, event); ipcRenderer.on(IPC.questionEvent, listener); return () => ipcRenderer.removeListener(IPC.questionEvent, listener) },
    onChanged: (callback) => subscribe(IPC.questionStateChanged, callback)
  },
  history: { list: (query = '') => invokeResult(IPC.historyList, query), open: (id) => invokeResult(IPC.historyOpen, id), delete: (id) => invokeResult(IPC.historyDelete, id), clear: () => invokeResult(IPC.historyClear), exportPreview: (id) => invokeResult(IPC.historyExportPreview, id), exportConversation: (id, options) => invokeResult(IPC.historyExport, id, options) },
  application: { openSettings: () => invokeResult(IPC.applicationOpenSettings) },
  clipboard: { writeText: (value) => invokeResult(IPC.clipboardWriteText, value) },
  windowChrome: { getState: () => ipcRenderer.invoke(IPC.windowChromeGetState), ready: () => ipcRenderer.send(IPC.windowChromeReady), minimize: () => ipcRenderer.invoke(IPC.windowChromeMinimize), toggleMaximize: () => ipcRenderer.invoke(IPC.windowChromeToggleMaximize), close: () => ipcRenderer.invoke(IPC.windowChromeClose), beginResize: (edge) => ipcRenderer.invoke(IPC.windowChromeBeginResize, edge), updateResize: () => ipcRenderer.send(IPC.windowChromeUpdateResize), endResize: () => ipcRenderer.send(IPC.windowChromeEndResize), onStateChanged: (callback) => subscribe(IPC.windowChromeStateChanged, callback) },
  openExternal: (url) => invokeResult(IPC.externalOpen, url),
  openOcrEntity: (kind, value) => invokeResult(IPC.externalOpenOcrEntity, kind, value)
}

async function invokeResult<T>(channel: string, ...arguments_: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...arguments_) as IpcResult<T>
  if (result.ok) return result.value
  return Promise.reject(structuredClone(result.error))
}

async function runCaptureAnalysis(onProgress?: (analysis: CaptureAnalysis) => void): Promise<CaptureAnalysis> {
  captureAnalysisRequestSequence += 1
  const requestId = `capture-analysis-${Date.now()}-${captureAnalysisRequestSequence}`
  const listener = (_event: Electron.IpcRendererEvent, progress: { requestId: string; analysis: CaptureAnalysis }): void => {
    if (progress.requestId === requestId) onProgress?.(structuredClone(progress.analysis))
  }
  ipcRenderer.on(IPC.captureAnalysisProgress, listener)
  try {
    return await invokeResult(IPC.captureAnalyze, requestId)
  } finally {
    ipcRenderer.removeListener(IPC.captureAnalysisProgress, listener)
  }
}

function subscribe<T extends SettingsViewState | AppearanceState | WindowChromeState | QuestionViewState>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(structuredClone(value))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('fovea', api)
