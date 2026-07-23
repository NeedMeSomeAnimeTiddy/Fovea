import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type FoveaApi, type SettingsViewState, type WindowChromeState } from '@shared/contracts/ipc'
import type { AppearanceState } from '@shared/types/app'
import type { ProviderEvent } from '@shared/types/provider'
import type { IpcResult } from '@shared/types/app-error'

const initialAppearance = ipcRenderer.sendSync(IPC.appearanceGet) as AppearanceState
applyInitialAppearance(initialAppearance)

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
    createApiKey: (provider, name, apiKey) => invokeResult(IPC.profilesCreateApiKey, provider, name, apiKey),
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
  settings: {
    get: () => invokeResult(IPC.settingsGet), setAppearance: (value) => invokeResult(IPC.settingsSetAppearance, value), setLaunchAtLogin: (enabled) => invokeResult(IPC.settingsSetLaunchAtLogin, enabled), setShortcut: (action, accelerator) => invokeResult(IPC.settingsSetShortcut, action, accelerator), resetShortcuts: () => invokeResult(IPC.settingsResetShortcuts), completeOnboarding: () => invokeResult(IPC.settingsCompleteOnboarding), deleteTemporaryFiles: () => invokeResult(IPC.settingsDeleteTemp),
    onChanged: (callback) => subscribe(IPC.settingsChanged, callback), onAppearanceChanged: (callback) => subscribe(IPC.appearanceChanged, callback)
  },
  capture: { start: (mode) => invokeResult(IPC.captureStart, mode), getContext: () => invokeResult(IPC.captureGetContext), select: (rectangle) => invokeResult(IPC.captureSelect, rectangle), cancel: () => invokeResult(IPC.captureCancel) },
  question: {
    get: (id) => invokeResult(IPC.questionGet, id), setSelection: (id, selection) => invokeResult(IPC.questionSetSelection, id, selection), send: (id, text) => invokeResult(IPC.questionSend, id, text), resolveWebSearch: (id, requestId, approved) => invokeResult(IPC.questionResolveWebSearch, id, requestId, approved), stop: (id) => invokeResult(IPC.questionStop, id), close: (id) => invokeResult(IPC.questionClose, id), newSnip: (id) => invokeResult(IPC.questionNewSnip, id),
    onEvent: (callback) => { const listener = (_event: Electron.IpcRendererEvent, id: string, event: ProviderEvent): void => callback(id, event); ipcRenderer.on(IPC.questionEvent, listener); return () => ipcRenderer.removeListener(IPC.questionEvent, listener) }
  },
  application: { openSettings: () => invokeResult(IPC.applicationOpenSettings) },
  windowChrome: { getState: () => ipcRenderer.invoke(IPC.windowChromeGetState), ready: () => ipcRenderer.send(IPC.windowChromeReady), minimize: () => ipcRenderer.invoke(IPC.windowChromeMinimize), toggleMaximize: () => ipcRenderer.invoke(IPC.windowChromeToggleMaximize), close: () => ipcRenderer.invoke(IPC.windowChromeClose), beginResize: (edge) => ipcRenderer.invoke(IPC.windowChromeBeginResize, edge), updateResize: () => ipcRenderer.send(IPC.windowChromeUpdateResize), endResize: () => ipcRenderer.send(IPC.windowChromeEndResize), onStateChanged: (callback) => subscribe(IPC.windowChromeStateChanged, callback) },
  openExternal: (url) => invokeResult(IPC.externalOpen, url)
}

async function invokeResult<T>(channel: string, ...arguments_: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...arguments_) as IpcResult<T>
  if (result.ok) return result.value
  return Promise.reject(structuredClone(result.error))
}

function subscribe<T extends SettingsViewState | AppearanceState | WindowChromeState>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(structuredClone(value))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('fovea', api)
