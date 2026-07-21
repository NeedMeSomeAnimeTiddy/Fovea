import { app, BrowserWindow, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC, isWindowResizeEdge, type SettingsViewState } from '@shared/contracts/ipc'
import type { AppearancePreference, CaptureMode, ConversationSelection, ProviderKind, ShortcutAction } from '@shared/types/app'
import type { Rectangle } from '@shared/types/geometry'
import type { AppearanceController } from '../appearance/appearance-controller'
import type { CaptureService } from '../capture/capture-service'
import type { ProviderRegistry } from '../providers/provider-registry'
import type { ShortcutManager } from '../shortcuts/shortcut-manager'
import type { SettingsStore } from '../storage/settings-store'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'
import type { QuestionSessions } from '../windows/question-sessions'
import { getSettingsWindow, showSettingsWindow } from '../windows/settings-window'
import { resolveWindowChromeController, type WindowChromeController, type WindowChromeIpcEvent } from '../windows/window-chrome'

export interface IpcDependencies { providers: ProviderRegistry; settings: SettingsStore; screenshots: TempScreenshotStore; capture: CaptureService; questions: QuestionSessions; shortcuts: ShortcutManager; appearance: AppearanceController }

export function registerIpc(dependencies: IpcDependencies): void {
  ipcMain.on(IPC.appearanceGet, (event) => { event.returnValue = dependencies.appearance.getState() })
  const buildSettingsState = (): SettingsViewState => ({ appearance: dependencies.appearance.getState(), profiles: dependencies.providers.listProfiles(), shortcuts: dependencies.shortcuts.getState(), launchAtLogin: dependencies.settings.get().launchAtLogin, onboardingCompleted: dependencies.settings.get().onboardingCompleted, tempLocation: dependencies.screenshots.directory, appVersion: app.getVersion() })
  const broadcastSettings = (): void => { const window = getSettingsWindow(); if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(IPC.settingsChanged, buildSettingsState()) }
  const mutate = async (operation: () => Promise<unknown>): Promise<void> => { await operation(); broadcastSettings() }

  ipcMain.handle(IPC.settingsGet, buildSettingsState)
  ipcMain.handle(IPC.settingsSetAppearance, (_event, value: unknown) => mutate(() => dependencies.appearance.setPreference(requireAppearance(value))))
  ipcMain.handle(IPC.settingsSetLaunchAtLogin, (_event, enabled: unknown) => mutate(async () => { if (typeof enabled !== 'boolean') throw new Error('Invalid launch setting.'); app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath }); await dependencies.settings.update({ launchAtLogin: enabled }) }))
  ipcMain.handle(IPC.settingsSetShortcut, (_event, action: unknown, accelerator: unknown) => mutate(() => dependencies.shortcuts.set(requireShortcutAction(action), requireAccelerator(accelerator))))
  ipcMain.handle(IPC.settingsResetShortcuts, () => mutate(() => dependencies.shortcuts.reset()))
  ipcMain.handle(IPC.settingsCompleteOnboarding, () => mutate(() => dependencies.settings.update({ onboardingCompleted: true })))
  ipcMain.handle(IPC.settingsDeleteTemp, () => dependencies.screenshots.cleanup())

  ipcMain.handle(IPC.profilesList, () => dependencies.providers.listProfiles())
  ipcMain.handle(IPC.profilesCreateApiKey, async (_event, provider: unknown, name: unknown, apiKey: unknown) => { const result = await dependencies.providers.profiles.createApiKey(requireApiProvider(provider), requireString(name, 80), requireString(apiKey, 2048)); broadcastSettings(); return result })
  ipcMain.handle(IPC.profilesCreateChatGpt, async (_event, name: unknown) => { const result = await dependencies.providers.profiles.createChatGpt(name === undefined ? undefined : requireString(name, 80)); broadcastSettings(); return result })
  ipcMain.handle(IPC.profilesRename, (_event, id: unknown, name: unknown) => mutate(() => dependencies.providers.profiles.rename(requireId(id), requireString(name, 80))))
  ipcMain.handle(IPC.profilesAuthenticate, (_event, id: unknown) => mutate(() => dependencies.providers.authenticate(requireId(id))))
  ipcMain.handle(IPC.profilesTest, async (_event, id: unknown) => { const result = await dependencies.providers.test(requireId(id)); broadcastSettings(); return result })
  ipcMain.handle(IPC.profilesSignOut, (_event, id: unknown) => mutate(() => dependencies.providers.signOut(requireId(id))))
  ipcMain.handle(IPC.profilesDelete, (_event, id: unknown) => mutate(() => dependencies.providers.delete(requireId(id))))
  ipcMain.handle(IPC.profilesSetDefault, (_event, id: unknown) => mutate(() => dependencies.providers.profiles.setDefault(requireId(id))))
  ipcMain.handle(IPC.profilesSetDefaults, (_event, id: unknown, model: unknown, reasoning: unknown) => mutate(() => dependencies.providers.profiles.setDefaults(requireId(id), requireNullableString(model, 200), requireNullableString(reasoning, 50))))
  ipcMain.handle(IPC.profilesModels, (_event, id: unknown) => dependencies.providers.listModels(requireId(id)))

  ipcMain.handle(IPC.captureStart, (_event, mode: unknown) => dependencies.capture.begin(requireCaptureMode(mode)))
  ipcMain.handle(IPC.captureGetContext, (event) => dependencies.capture.getContext(event.sender.id))
  ipcMain.handle(IPC.captureSelect, (event, rectangle: unknown) => { if (!isRectangle(rectangle)) throw new Error('Invalid selection.'); return dependencies.capture.select(rectangle, event.sender.id) })
  ipcMain.handle(IPC.captureCancel, () => dependencies.capture.cancel())

  ipcMain.handle(IPC.questionGet, (_event, id: unknown) => dependencies.questions.get(requireId(id)))
  ipcMain.handle(IPC.questionSetSelection, (_event, id: unknown, selection: unknown) => dependencies.questions.setSelection(requireId(id), requireSelection(selection)))
  ipcMain.handle(IPC.questionSend, (_event, id: unknown, text: unknown) => dependencies.questions.send(requireId(id), requireString(text, 10_000)))
  ipcMain.handle(IPC.questionStop, (_event, id: unknown) => dependencies.questions.stop(requireId(id)))
  ipcMain.handle(IPC.questionClose, (_event, id: unknown) => dependencies.questions.close(requireId(id)))
  ipcMain.handle(IPC.questionNewSnip, (_event, id: unknown) => dependencies.questions.newSnip(requireId(id)))
  ipcMain.handle(IPC.applicationOpenSettings, () => showSettingsWindow())

  ipcMain.handle(IPC.windowChromeGetState, (event) => requireWindowChromeController(event).getState())
  ipcMain.on(IPC.windowChromeReady, (event) => getWindowChromeController(event)?.markRendererReady())
  ipcMain.handle(IPC.windowChromeMinimize, (event) => requireWindowChromeController(event).minimizeWindow())
  ipcMain.handle(IPC.windowChromeToggleMaximize, (event) => requireWindowChromeController(event).toggleMaximize())
  ipcMain.handle(IPC.windowChromeClose, (event) => requireWindowChromeController(event).closeWindow())
  ipcMain.handle(IPC.windowChromeBeginResize, (event, edge: unknown) => { if (!isWindowResizeEdge(edge)) throw new Error('Invalid window resize edge.'); requireWindowChromeController(event).beginResize(edge) })
  ipcMain.on(IPC.windowChromeUpdateResize, (event) => getWindowChromeController(event)?.requestResizeUpdate())
  ipcMain.on(IPC.windowChromeEndResize, (event) => getWindowChromeController(event)?.endResize())
  ipcMain.handle(IPC.externalOpen, async (_event, value: unknown) => { const url = new URL(requireString(value, 2048)); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only web links can be opened.'); await shell.openExternal(url.toString()) })
}

function requireWindowChromeController(event: IpcMainInvokeEvent | IpcMainEvent): WindowChromeController { const controller = resolveWindowChromeController(event as WindowChromeIpcEvent); const target = BrowserWindow.fromWebContents(event.sender); if (!target || target.isDestroyed() || target.id !== controller.windowId || target.webContents.id !== controller.webContentsId) throw new Error('Window chrome is unavailable for this sender.'); return controller }
function getWindowChromeController(event: IpcMainEvent): WindowChromeController | null { try { return requireWindowChromeController(event) } catch { return null } }
function requireString(value: unknown, max: number): string { if (typeof value !== 'string' || value.length > max) throw new Error('Invalid text value.'); return value }
function requireId(value: unknown): string { return requireString(value, 100) }
function requireNullableString(value: unknown, max: number): string | null { return value === null ? null : requireString(value, max) }
function requireAccelerator(value: unknown): string | null { return requireNullableString(value, 100) }
function requireAppearance(value: unknown): AppearancePreference { if (!['system', 'dark', 'light'].includes(String(value))) throw new Error('Invalid appearance.'); return value as AppearancePreference }
function requireShortcutAction(value: unknown): ShortcutAction { if (!['region', 'display', 'window', 'repeat-last', 'settings'].includes(String(value))) throw new Error('Invalid shortcut action.'); return value as ShortcutAction }
function requireCaptureMode(value: unknown): CaptureMode { if (!['region', 'display', 'window', 'repeat-last'].includes(String(value))) throw new Error('Invalid capture mode.'); return value as CaptureMode }
function requireApiProvider(value: unknown): Exclude<ProviderKind, 'chatgpt'> { if (!['openai', 'anthropic', 'openrouter'].includes(String(value))) throw new Error('Invalid API provider.'); return value as Exclude<ProviderKind, 'chatgpt'> }
function requireSelection(value: unknown): ConversationSelection { if (!value || typeof value !== 'object') throw new Error('Invalid conversation selection.'); const item = value as Record<string, unknown>; return { profileId: requireId(item.profileId), provider: String(item.provider) as ProviderKind, modelId: requireString(item.modelId, 200), reasoningEffort: requireNullableString(item.reasoningEffort, 50) } }
function isRectangle(value: unknown): value is Rectangle { return Boolean(value && typeof value === 'object' && ['x','y','width','height'].every((key) => typeof (value as Record<string, unknown>)[key] === 'number' && Number.isFinite((value as Record<string, unknown>)[key]))) }
