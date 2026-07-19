import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type SettingsViewState, type SnipChatApi } from '@shared/contracts/ipc'
import type { ProviderEvent } from '@shared/types/provider'

const api: SnipChatApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    signInWithChatGPT: () => ipcRenderer.invoke(IPC.settingsLoginChatGpt),
    signInWithApiKey: (apiKey) => ipcRenderer.invoke(IPC.settingsLoginApiKey, apiKey),
    signOut: () => ipcRenderer.invoke(IPC.settingsLogout),
    setModel: (modelId) => ipcRenderer.invoke(IPC.settingsSetModel, modelId),
    setLaunchAtLogin: (enabled) => ipcRenderer.invoke(IPC.settingsSetLaunchAtLogin, enabled),
    deleteTemporaryFiles: () => ipcRenderer.invoke(IPC.settingsDeleteTemp),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: SettingsViewState): void => callback(state)
      ipcRenderer.on(IPC.settingsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.settingsChanged, listener)
    }
  },
  capture: {
    getContext: () => ipcRenderer.invoke(IPC.captureGetContext),
    select: (rectangle) => ipcRenderer.invoke(IPC.captureSelect, rectangle),
    cancel: () => ipcRenderer.invoke(IPC.captureCancel)
  },
  question: {
    get: (sessionId) => ipcRenderer.invoke(IPC.questionGet, sessionId),
    send: (sessionId, text) => ipcRenderer.invoke(IPC.questionSend, sessionId, text),
    stop: (sessionId) => ipcRenderer.invoke(IPC.questionStop, sessionId),
    close: (sessionId) => ipcRenderer.invoke(IPC.questionClose, sessionId),
    newSnip: (sessionId) => ipcRenderer.invoke(IPC.questionNewSnip, sessionId),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, sessionId: string, providerEvent: ProviderEvent): void =>
        callback(sessionId, providerEvent)
      ipcRenderer.on(IPC.questionEvent, listener)
      return () => ipcRenderer.removeListener(IPC.questionEvent, listener)
    }
  },
  openExternal: (url) => ipcRenderer.invoke(IPC.externalOpen, url)
}

contextBridge.exposeInMainWorld('snipchat', api)
