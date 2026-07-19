import { app, ipcMain, shell } from 'electron'
import { IPC, type SettingsViewState } from '@shared/contracts/ipc'
import type { Rectangle } from '@shared/types/geometry'
import type { VisionModel } from '@shared/types/provider'
import type { CaptureService } from '../capture/capture-service'
import type { CodexAppServerProvider } from '../providers/codex-app-server/codex-app-server-provider'
import type { SettingsStore } from '../storage/settings-store'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'
import type { QuestionSessions } from '../windows/question-sessions'
import { getSettingsWindow } from '../windows/settings-window'

export interface IpcDependencies {
  provider: CodexAppServerProvider
  settings: SettingsStore
  screenshots: TempScreenshotStore
  capture: CaptureService
  questions: QuestionSessions
  shortcut: string
}

export function registerIpc(dependencies: IpcDependencies): void {
  const buildSettingsState = async (): Promise<SettingsViewState> => {
    const provider = await dependencies.provider.getStatus()
    let models: VisionModel[] = []
    try {
      models = await dependencies.provider.listModels()
    } catch {
      models = []
    }
    let selectedModelId = dependencies.settings.get().selectedModelId
    if (models.length > 0 && !models.some((model) => model.id === selectedModelId)) {
      selectedModelId = models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null
      await dependencies.settings.update({ selectedModelId })
    }
    return {
      provider,
      models,
      selectedModelId,
      shortcut: dependencies.shortcut,
      launchAtLogin: dependencies.settings.get().launchAtLogin,
      tempLocation: dependencies.screenshots.directory
    }
  }

  const broadcastSettings = async (): Promise<void> => {
    const window = getSettingsWindow()
    if (!window || window.isDestroyed()) return
    const settings = await buildSettingsState()
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(IPC.settingsChanged, settings)
    }
  }

  dependencies.provider.on('status', () => void broadcastSettings().catch(() => undefined))

  ipcMain.handle(IPC.settingsGet, buildSettingsState)
  ipcMain.handle(IPC.settingsLoginChatGpt, async () => {
    await dependencies.provider.signInWithChatGPT()
    await broadcastSettings()
  })
  ipcMain.handle(IPC.settingsLoginApiKey, async (_event, apiKey: unknown) => {
    if (typeof apiKey !== 'string' || apiKey.length > 512) throw new Error('Invalid API key.')
    await dependencies.provider.signInWithApiKey(apiKey)
    await broadcastSettings()
  })
  ipcMain.handle(IPC.settingsLogout, async () => {
    await dependencies.provider.signOut()
    await broadcastSettings()
  })
  ipcMain.handle(IPC.settingsSetModel, async (_event, modelId: unknown) => {
    if (typeof modelId !== 'string' || modelId.length > 200) throw new Error('Invalid model selection.')
    const models = await dependencies.provider.listModels()
    if (!models.some((model) => model.id === modelId)) throw new Error('That model is not available.')
    await dependencies.settings.update({ selectedModelId: modelId })
    await broadcastSettings()
  })
  ipcMain.handle(IPC.settingsSetLaunchAtLogin, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid launch setting.')
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
    await dependencies.settings.update({ launchAtLogin: enabled })
    await broadcastSettings()
  })
  ipcMain.handle(IPC.settingsDeleteTemp, async () => dependencies.screenshots.cleanup())

  ipcMain.handle(IPC.captureGetContext, () => dependencies.capture.getContext())
  ipcMain.handle(IPC.captureSelect, async (_event, rectangle: unknown) => {
    if (!isRectangle(rectangle)) throw new Error('Invalid selection.')
    await dependencies.capture.select(rectangle)
  })
  ipcMain.handle(IPC.captureCancel, () => dependencies.capture.cancel())

  ipcMain.handle(IPC.questionGet, (_event, sessionId: unknown) =>
    dependencies.questions.get(requireSessionId(sessionId))
  )
  ipcMain.handle(IPC.questionSend, async (_event, sessionId: unknown, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Invalid question.')
    await dependencies.questions.send(requireSessionId(sessionId), text)
  })
  ipcMain.handle(IPC.questionStop, (_event, sessionId: unknown) =>
    dependencies.questions.stop(requireSessionId(sessionId))
  )
  ipcMain.handle(IPC.questionClose, (_event, sessionId: unknown) =>
    dependencies.questions.close(requireSessionId(sessionId))
  )
  ipcMain.handle(IPC.questionNewSnip, (_event, sessionId: unknown) =>
    dependencies.questions.newSnip(requireSessionId(sessionId))
  )
  ipcMain.handle(IPC.externalOpen, async (_event, urlValue: unknown) => {
    if (typeof urlValue !== 'string') throw new Error('Invalid link.')
    const url = new URL(urlValue)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only web links can be opened.')
    await shell.openExternal(url.toString())
  })
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Invalid snip session.')
  return value
}

function isRectangle(value: unknown): value is Rectangle {
  if (!value || typeof value !== 'object') return false
  const rectangle = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof rectangle[key] === 'number' && Number.isFinite(rectangle[key])
  )
}
