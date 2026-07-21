import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type FoveaApi, type SettingsViewState, type WindowChromeState } from '@shared/contracts/ipc'
import type { AppearanceState } from '@shared/types/app'
import type { ProviderEvent } from '@shared/types/provider'

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
    list: () => ipcRenderer.invoke(IPC.profilesList),
    createApiKey: (provider, name, apiKey) => ipcRenderer.invoke(IPC.profilesCreateApiKey, provider, name, apiKey),
    createChatGpt: (name) => ipcRenderer.invoke(IPC.profilesCreateChatGpt, name),
    rename: (id, name) => ipcRenderer.invoke(IPC.profilesRename, id, name),
    authenticate: (id) => ipcRenderer.invoke(IPC.profilesAuthenticate, id),
    test: (id) => ipcRenderer.invoke(IPC.profilesTest, id),
    signOut: (id) => ipcRenderer.invoke(IPC.profilesSignOut, id),
    delete: (id) => ipcRenderer.invoke(IPC.profilesDelete, id),
    setDefault: (id) => ipcRenderer.invoke(IPC.profilesSetDefault, id),
    setDefaults: (id, modelId, reasoning) => ipcRenderer.invoke(IPC.profilesSetDefaults, id, modelId, reasoning),
    models: (id) => ipcRenderer.invoke(IPC.profilesModels, id)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet), setAppearance: (value) => ipcRenderer.invoke(IPC.settingsSetAppearance, value), setLaunchAtLogin: (enabled) => ipcRenderer.invoke(IPC.settingsSetLaunchAtLogin, enabled), setShortcut: (action, accelerator) => ipcRenderer.invoke(IPC.settingsSetShortcut, action, accelerator), resetShortcuts: () => ipcRenderer.invoke(IPC.settingsResetShortcuts), completeOnboarding: () => ipcRenderer.invoke(IPC.settingsCompleteOnboarding), deleteTemporaryFiles: () => ipcRenderer.invoke(IPC.settingsDeleteTemp),
    onChanged: (callback) => subscribe(IPC.settingsChanged, callback), onAppearanceChanged: (callback) => subscribe(IPC.appearanceChanged, callback)
  },
  capture: { start: (mode) => ipcRenderer.invoke(IPC.captureStart, mode), getContext: () => ipcRenderer.invoke(IPC.captureGetContext), select: (rectangle) => ipcRenderer.invoke(IPC.captureSelect, rectangle), cancel: () => ipcRenderer.invoke(IPC.captureCancel) },
  question: {
    get: (id) => ipcRenderer.invoke(IPC.questionGet, id), setSelection: (id, selection) => ipcRenderer.invoke(IPC.questionSetSelection, id, selection), send: (id, text) => ipcRenderer.invoke(IPC.questionSend, id, text), stop: (id) => ipcRenderer.invoke(IPC.questionStop, id), close: (id) => ipcRenderer.invoke(IPC.questionClose, id), newSnip: (id) => ipcRenderer.invoke(IPC.questionNewSnip, id),
    onEvent: (callback) => { const listener = (_event: Electron.IpcRendererEvent, id: string, event: ProviderEvent): void => callback(id, event); ipcRenderer.on(IPC.questionEvent, listener); return () => ipcRenderer.removeListener(IPC.questionEvent, listener) }
  },
  application: { openSettings: () => ipcRenderer.invoke(IPC.applicationOpenSettings) },
  windowChrome: { getState: () => ipcRenderer.invoke(IPC.windowChromeGetState), ready: () => ipcRenderer.send(IPC.windowChromeReady), minimize: () => ipcRenderer.invoke(IPC.windowChromeMinimize), toggleMaximize: () => ipcRenderer.invoke(IPC.windowChromeToggleMaximize), close: () => ipcRenderer.invoke(IPC.windowChromeClose), beginResize: (edge) => ipcRenderer.invoke(IPC.windowChromeBeginResize, edge), updateResize: () => ipcRenderer.send(IPC.windowChromeUpdateResize), endResize: () => ipcRenderer.send(IPC.windowChromeEndResize), onStateChanged: (callback) => subscribe(IPC.windowChromeStateChanged, callback) },
  openExternal: (url) => ipcRenderer.invoke(IPC.externalOpen, url)
}

function subscribe<T extends SettingsViewState | AppearanceState | WindowChromeState>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(structuredClone(value))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('fovea', api)
