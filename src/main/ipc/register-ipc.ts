import { app, BrowserWindow, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC, isWindowResizeEdge, type SettingsViewState } from '@shared/contracts/ipc'
import type { AppearancePreference, CaptureMode, ConversationSelection, ImageEditOperation, OnboardingStatus, ProviderKind, ShortcutAction } from '@shared/types/app'
import type { Rectangle } from '@shared/types/geometry'
import type { AppErrorCode } from '@shared/types/app-error'
import { toIpcResult } from '../errors/app-error'
import type { AppearanceController } from '../appearance/appearance-controller'
import type { CaptureService } from '../capture/capture-service'
import type { OnboardingController } from '../onboarding/onboarding-controller'
import type { ProviderRegistry } from '../providers/provider-registry'
import type { ShortcutManager } from '../shortcuts/shortcut-manager'
import type { SettingsStore } from '../storage/settings-store'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'
import type { ConversationHistoryStore } from '../storage/conversation-history-store'
import type { QuestionSessions } from '../windows/question-sessions'
import { ownsSettingsWebContents, showSettingsWindow } from '../windows/settings-window'
import { resolveWindowChromeController, type WindowChromeController, type WindowChromeIpcEvent } from '../windows/window-chrome'

export interface IpcDependencies { providers: ProviderRegistry; settings: SettingsStore; screenshots: TempScreenshotStore; history: ConversationHistoryStore; capture: CaptureService; onboarding: OnboardingController; questions: QuestionSessions; shortcuts: ShortcutManager; appearance: AppearanceController }

export function registerIpc(dependencies: IpcDependencies): void {
  ipcMain.on(IPC.appearanceGet, (event) => { event.returnValue = dependencies.appearance.getState() })
  const buildSettingsState = (): SettingsViewState => ({ appearance: dependencies.appearance.getState(), profiles: dependencies.providers.listProfiles(), shortcuts: dependencies.shortcuts.getState(), customPrompts: dependencies.settings.get().customPrompts, launchAtLogin: dependencies.settings.get().launchAtLogin, onboardingStatus: dependencies.settings.get().onboardingStatus, history: dependencies.settings.get().history, tempLocation: dependencies.screenshots.directory, appVersion: app.getVersion() })
  const broadcastSettings = (): void => {
    const state = buildSettingsState()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(IPC.settingsChanged, state)
    }
  }
  dependencies.providers.on('status', broadcastSettings)
  const mutate = async (operation: () => Promise<unknown>): Promise<void> => { await operation(); broadcastSettings() }
  const handle = (
    channel: string,
    operation: (event: IpcMainInvokeEvent, ...arguments_: unknown[]) => unknown,
    fallbackCode?: AppErrorCode
  ): void => {
    ipcMain.handle(channel, (event, ...arguments_) => toIpcResult(() => operation(event, ...arguments_), fallbackCode))
  }

  handle(IPC.settingsGet, buildSettingsState)
  handle(IPC.settingsSetAppearance, (_event, value) => mutate(() => dependencies.appearance.setPreference(requireAppearance(value))), 'validation')
  handle(IPC.settingsSetLaunchAtLogin, (_event, enabled) => mutate(async () => { if (typeof enabled !== 'boolean') throw new Error('Invalid launch setting.'); app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath }); await dependencies.settings.update({ launchAtLogin: enabled }) }), 'validation')
  handle(IPC.settingsSetShortcut, (_event, action, accelerator) => mutate(() => dependencies.shortcuts.set(requireShortcutAction(action), requireAccelerator(accelerator))), 'validation')
  handle(IPC.settingsResetShortcuts, () => mutate(() => dependencies.shortcuts.reset()))
  handle(IPC.settingsSaveCustomPrompt, (_event, id, label, prompt) => mutate(async () => {
    const settings = dependencies.settings.get()
    const promptId = id === null ? randomUUID() : requireId(id)
    const nextPrompt = {
      id: promptId,
      label: requireTrimmedString(label, 80),
      prompt: requireTrimmedString(prompt, 2_000)
    }
    const index = settings.customPrompts.findIndex((item) => item.id === promptId)
    if (id !== null && index < 0) throw new Error('Custom prompt not found.')
    if (id === null && settings.customPrompts.length >= 20) throw new Error('Custom prompt limit reached.')
    const customPrompts = [...settings.customPrompts]
    if (index >= 0) customPrompts[index] = nextPrompt
    else customPrompts.push(nextPrompt)
    await dependencies.settings.update({ customPrompts })
  }), 'validation')
  handle(IPC.settingsDeleteCustomPrompt, (_event, id) => mutate(async () => {
    const promptId = requireId(id)
    const settings = dependencies.settings.get()
    if (!settings.customPrompts.some((item) => item.id === promptId)) throw new Error('Custom prompt not found.')
    await dependencies.settings.update({ customPrompts: settings.customPrompts.filter((item) => item.id !== promptId) })
  }), 'validation')
  handle(IPC.settingsSetOnboardingStatus, (_event, status) => mutate(() => dependencies.settings.update({ onboardingStatus: requireOnboardingOutcome(status) })), 'validation')
  handle(IPC.settingsSetPrivateMode, (_event, enabled) => mutate(() => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid private mode setting.')
    return dependencies.settings.update({ history: { ...dependencies.settings.get().history, privateMode: enabled } })
  }), 'validation')
  handle(IPC.settingsSetHistoryRetention, (_event, days) => mutate(async () => {
    const retentionDays = requireInteger(days, 1, 3650)
    await dependencies.settings.update({ history: { ...dependencies.settings.get().history, retentionDays } })
    await dependencies.history.applyRetention(retentionDays)
  }), 'validation')
  handle(IPC.settingsSetScreenshotRetention, (_event, enabled) => mutate(async () => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid screenshot retention setting.')
    await dependencies.settings.update({ history: { ...dependencies.settings.get().history, retainScreenshots: enabled } })
    if (!enabled) await dependencies.history.removeAllScreenshots()
  }), 'validation')
  handle(IPC.settingsTestOnboardingCapture, (event) => {
    if (event.sender.isDestroyed() || !ownsSettingsWebContents(event.sender.id)) throw new Error('Test capture is only available from Settings.')
    return dependencies.onboarding.testCapture()
  }, 'capture-failed')
  handle(IPC.settingsDeleteTemp, () => dependencies.screenshots.cleanup())

  handle(IPC.profilesList, () => dependencies.providers.listProfiles())
  handle(IPC.profilesCreateApiKey, async (_event, provider, name, apiKey) => { const result = await dependencies.providers.profiles.createApiKey(requireApiProvider(provider), requireString(name, 80), requireString(apiKey, 2048)); broadcastSettings(); return result }, 'validation')
  handle(IPC.profilesCreateChatGpt, async (_event, name) => { const result = await dependencies.providers.profiles.createChatGpt(name === undefined ? undefined : requireString(name, 80)); broadcastSettings(); return result }, 'validation')
  handle(IPC.profilesRename, (_event, id, name) => mutate(() => dependencies.providers.profiles.rename(requireId(id), requireString(name, 80))), 'validation')
  handle(IPC.profilesAuthenticate, (_event, id) => mutate(() => dependencies.providers.authenticate(requireId(id))), 'authentication-required')
  handle(IPC.profilesTest, async (_event, id) => { const result = await dependencies.providers.test(requireId(id)); broadcastSettings(); return result }, 'provider-unavailable')
  handle(IPC.profilesSignOut, (_event, id) => mutate(() => dependencies.providers.signOut(requireId(id))))
  handle(IPC.profilesDelete, (_event, id) => mutate(() => dependencies.providers.delete(requireId(id))))
  handle(IPC.profilesSetDefault, (_event, id) => mutate(() => dependencies.providers.profiles.setDefault(requireId(id))))
  handle(IPC.profilesSetDefaults, (_event, id, model, reasoning) => mutate(() => dependencies.providers.profiles.setDefaults(requireId(id), requireNullableString(model, 200), requireNullableString(reasoning, 50))), 'validation')
  handle(IPC.profilesModels, (_event, id) => dependencies.providers.listModels(requireId(id)), 'no-compatible-models')

  handle(IPC.captureStart, (_event, mode) => dependencies.capture.begin(requireCaptureMode(mode)), 'capture-failed')
  handle(IPC.captureGetContext, (event) => dependencies.capture.getContext(event.sender.id), 'capture-failed')
  handle(IPC.captureSelect, (event, rectangle, operations = [], preferWebSearch = false) => { if (!isRectangle(rectangle)) throw new Error('Invalid selection.'); if (!Array.isArray(operations)) throw new Error('Invalid screenshot edits.'); if (typeof preferWebSearch !== 'boolean') throw new Error('Invalid web-search preference.'); return dependencies.capture.select(rectangle, event.sender.id, operations as ImageEditOperation[], preferWebSearch) }, 'capture-failed')
  handle(IPC.captureCancel, () => dependencies.capture.cancel())

  handle(IPC.questionGet, (_event, id) => dependencies.questions.get(requireId(id)))
  handle(IPC.questionGetFullImage, (_event, id, attachmentId) => dependencies.questions.getFullImage(requireId(id), requireId(attachmentId)), 'capture-failed')
  handle(IPC.questionSetSelection, (_event, id, selection) => dependencies.questions.setSelection(requireId(id), requireSelection(selection)), 'validation')
  handle(IPC.questionSetPinned, (_event, id, pinned) => {
    if (typeof pinned !== 'boolean') throw new Error('Invalid pin state.')
    return dependencies.questions.setPinned(requireId(id), pinned)
  }, 'validation')
  handle(IPC.questionSetPreviewOpen, (_event, id, attachmentId) => {
    if (attachmentId !== null && typeof attachmentId !== 'string') throw new Error('Invalid preview attachment.')
    return dependencies.questions.setPreviewOpen(requireId(id), attachmentId === null ? null : requireId(attachmentId))
  }, 'validation')
  handle(IPC.questionRemoveAttachment, (_event, id, attachmentId) => dependencies.questions.removeAttachment(requireId(id), requireId(attachmentId)), 'validation')
  handle(IPC.questionApplyAttachmentEdits, (_event, id, attachmentId, operations) => {
    if (!Array.isArray(operations)) throw new Error('Invalid screenshot edits.')
    return dependencies.questions.applyAttachmentEdits(requireId(id), requireId(attachmentId), operations as ImageEditOperation[])
  }, 'validation')
  handle(IPC.questionSend, (_event, id, text, preferWebSearch = false) => {
    if (typeof preferWebSearch !== 'boolean') throw new Error('Invalid web-search preference.')
    return dependencies.questions.send(requireId(id), requireString(text, 10_000), preferWebSearch)
  }, 'provider-unavailable')
  handle(IPC.questionRetry, (_event, id, exchangeId) => dependencies.questions.retry(requireId(id), requireId(exchangeId)), 'provider-unavailable')
  handle(IPC.questionResolveWebSearch, (_event, id, requestId, approved) => { if (typeof approved !== 'boolean') throw new Error('Invalid web-search approval.'); return dependencies.questions.resolveWebSearch(requireId(id), requireId(requestId), approved) }, 'provider-unavailable')
  handle(IPC.questionStop, (_event, id) => dependencies.questions.stop(requireId(id)))
  handle(IPC.questionClose, (_event, id) => dependencies.questions.close(requireId(id)))
  handle(IPC.questionAddSnip, (_event, id) => dependencies.questions.addSnip(requireId(id)), 'capture-failed')
  handle(IPC.questionNewChat, (_event, id) => dependencies.questions.newChat(requireId(id)), 'capture-failed')
  handle(IPC.historyList, (_event, query = '') => dependencies.history.list(requireString(query, 200)), 'validation')
  handle(IPC.historyOpen, (_event, id) => dependencies.questions.openHistory(requireId(id)))
  handle(IPC.historyDelete, (_event, id) => dependencies.history.delete(requireId(id)))
  handle(IPC.historyClear, () => dependencies.history.clear())
  handle(IPC.applicationOpenSettings, () => showSettingsWindow())

  ipcMain.handle(IPC.windowChromeGetState, (event) => requireWindowChromeController(event).getState())
  ipcMain.on(IPC.windowChromeReady, (event) => getWindowChromeController(event)?.markRendererReady())
  ipcMain.handle(IPC.windowChromeMinimize, (event) => requireWindowChromeController(event).minimizeWindow())
  ipcMain.handle(IPC.windowChromeToggleMaximize, (event) => requireWindowChromeController(event).toggleMaximize())
  ipcMain.handle(IPC.windowChromeClose, (event) => requireWindowChromeController(event).closeWindow())
  ipcMain.handle(IPC.windowChromeBeginResize, (event, edge: unknown) => { if (!isWindowResizeEdge(edge)) throw new Error('Invalid window resize edge.'); requireWindowChromeController(event).beginResize(edge) })
  ipcMain.on(IPC.windowChromeUpdateResize, (event) => getWindowChromeController(event)?.requestResizeUpdate())
  ipcMain.on(IPC.windowChromeEndResize, (event) => getWindowChromeController(event)?.endResize())
  handle(IPC.externalOpen, async (_event, value) => { const url = new URL(requireString(value, 2048)); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only web links can be opened.'); await shell.openExternal(url.toString()) }, 'validation')
}

function requireWindowChromeController(event: IpcMainInvokeEvent | IpcMainEvent): WindowChromeController { const controller = resolveWindowChromeController(event as WindowChromeIpcEvent); const target = BrowserWindow.fromWebContents(event.sender); if (!target || target.isDestroyed() || target.id !== controller.windowId || target.webContents.id !== controller.webContentsId) throw new Error('Window chrome is unavailable for this sender.'); return controller }
function getWindowChromeController(event: IpcMainEvent): WindowChromeController | null { try { return requireWindowChromeController(event) } catch { return null } }
function requireString(value: unknown, max: number): string { if (typeof value !== 'string' || value.length > max) throw new Error('Invalid text value.'); return value }
function requireTrimmedString(value: unknown, max: number): string { const text = requireString(value, max).trim(); if (!text) throw new Error('Text value is required.'); return text }
function requireId(value: unknown): string { return requireString(value, 100) }
function requireNullableString(value: unknown, max: number): string | null { return value === null ? null : requireString(value, max) }
function requireAccelerator(value: unknown): string | null { return requireNullableString(value, 100) }
function requireAppearance(value: unknown): AppearancePreference { if (!['system', 'dark', 'light'].includes(String(value))) throw new Error('Invalid appearance.'); return value as AppearancePreference }
function requireOnboardingOutcome(value: unknown): Exclude<OnboardingStatus, 'pending'> { if (!['skipped', 'completed'].includes(String(value))) throw new Error('Invalid onboarding outcome.'); return value as Exclude<OnboardingStatus, 'pending'> }
function requireShortcutAction(value: unknown): ShortcutAction { if (!['region', 'display', 'window', 'repeat-last', 'settings'].includes(String(value))) throw new Error('Invalid shortcut action.'); return value as ShortcutAction }
function requireCaptureMode(value: unknown): CaptureMode { if (!['region', 'display', 'window', 'repeat-last'].includes(String(value))) throw new Error('Invalid capture mode.'); return value as CaptureMode }
function requireApiProvider(value: unknown): Exclude<ProviderKind, 'chatgpt'> { if (!['openai', 'anthropic', 'openrouter'].includes(String(value))) throw new Error('Invalid API provider.'); return value as Exclude<ProviderKind, 'chatgpt'> }
function requireSelection(value: unknown): ConversationSelection { if (!value || typeof value !== 'object') throw new Error('Invalid conversation selection.'); const item = value as Record<string, unknown>; return { profileId: requireId(item.profileId), provider: String(item.provider) as ProviderKind, modelId: requireString(item.modelId, 200), reasoningEffort: requireNullableString(item.reasoningEffort, 50) } }
function isRectangle(value: unknown): value is Rectangle { return Boolean(value && typeof value === 'object' && ['x','y','width','height'].every((key) => typeof (value as Record<string, unknown>)[key] === 'number' && Number.isFinite((value as Record<string, unknown>)[key]))) }
function requireInteger(value: unknown, minimum: number, maximum: number): number { if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error('Invalid number.'); return value }
