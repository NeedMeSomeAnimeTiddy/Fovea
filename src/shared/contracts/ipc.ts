import type { ProviderEvent, ProviderStatus, VisionModel } from '../types/provider'
import type { Rectangle } from '../types/geometry'

export const IPC = {
  settingsGet: 'settings:get',
  settingsLoginChatGpt: 'settings:login-chatgpt',
  settingsLoginApiKey: 'settings:login-api-key',
  settingsLogout: 'settings:logout',
  settingsSetModel: 'settings:set-model',
  settingsSetLaunchAtLogin: 'settings:set-launch-at-login',
  settingsDeleteTemp: 'settings:delete-temp',
  settingsChanged: 'settings:changed',
  captureGetContext: 'capture:get-context',
  captureSelect: 'capture:select',
  captureCancel: 'capture:cancel',
  questionGet: 'question:get',
  questionSend: 'question:send',
  questionStop: 'question:stop',
  questionClose: 'question:close',
  questionNewSnip: 'question:new-snip',
  questionEvent: 'question:event',
  windowChromeGetState: 'window-chrome:get-state',
  windowChromeReady: 'window-chrome:ready',
  windowChromeMinimize: 'window-chrome:minimize',
  windowChromeToggleMaximize: 'window-chrome:toggle-maximize',
  windowChromeClose: 'window-chrome:close',
  windowChromeBeginResize: 'window-chrome:begin-resize',
  windowChromeUpdateResize: 'window-chrome:update-resize',
  windowChromeEndResize: 'window-chrome:end-resize',
  windowChromeStateChanged: 'window-chrome:state-changed',
  externalOpen: 'external:open'
} as const

export const WINDOW_RESIZE_EDGES = [
  'top',
  'right',
  'bottom',
  'left',
  'top-left',
  'top-right',
  'bottom-right',
  'bottom-left'
] as const

export type WindowResizeEdge = (typeof WINDOW_RESIZE_EDGES)[number]
export type WindowMaterial = 'transparent' | 'solid'

export interface WindowChromeState {
  focused: boolean
  maximized: boolean
  material: WindowMaterial
  canMinimize: boolean
  canMaximize: boolean
  canResize: boolean
}

export function isWindowResizeEdge(value: unknown): value is WindowResizeEdge {
  return typeof value === 'string' && WINDOW_RESIZE_EDGES.some((edge) => edge === value)
}

export interface SettingsViewState {
  provider: ProviderStatus
  models: VisionModel[]
  selectedModelId: string | null
  shortcut: string
  launchAtLogin: boolean
  tempLocation: string
}

export interface CaptureContext {
  width: number
  height: number
  minSelectionSize: number
}

export interface QuestionViewState {
  sessionId: string
  thumbnailDataUrl: string
  busy: boolean
}

export interface SnipChatApi {
  settings: {
    get(): Promise<SettingsViewState>
    signInWithChatGPT(): Promise<void>
    signInWithApiKey(apiKey: string): Promise<void>
    signOut(): Promise<void>
    setModel(modelId: string): Promise<void>
    setLaunchAtLogin(enabled: boolean): Promise<void>
    deleteTemporaryFiles(): Promise<number>
    onChanged(callback: (state: SettingsViewState) => void): () => void
  }
  capture: {
    getContext(): Promise<CaptureContext>
    select(rectangle: Rectangle): Promise<void>
    cancel(): Promise<void>
  }
  question: {
    get(sessionId: string): Promise<QuestionViewState>
    send(sessionId: string, text: string): Promise<void>
    stop(sessionId: string): Promise<void>
    close(sessionId: string): Promise<void>
    newSnip(sessionId: string): Promise<void>
    onEvent(callback: (sessionId: string, event: ProviderEvent) => void): () => void
  }
  windowChrome: {
    getState(): Promise<WindowChromeState>
    ready(): void
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    beginResize(edge: WindowResizeEdge): Promise<void>
    updateResize(): void
    endResize(): void
    onStateChanged(callback: (state: WindowChromeState) => void): () => void
  }
  openExternal(url: string): Promise<void>
}
