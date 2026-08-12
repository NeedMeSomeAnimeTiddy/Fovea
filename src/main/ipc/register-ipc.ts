import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { IPC, isSettingsCategory, isWindowResizeEdge, type CaptureFreezeReason, type CaptureVideoFrameMetadata, type SettingsCategory, type SettingsViewState } from '@shared/contracts/ipc'
import type { AppearancePreference, CaptureMode, CaptureRecipe, ConversationExportOptions, ConversationSelection, ImageEditOperation, OcrExternalActionKind, OnboardingStatus, ProviderKind, ShortcutAction } from '@shared/types/app'
import type { Rectangle } from '@shared/types/geometry'
import type { AppErrorCode } from '@shared/types/app-error'
import { MAX_BASE_URL_LENGTH, MAX_CUSTOM_MODEL_IDS, normaliseBaseUrl } from '@shared/provider-endpoint'
import { toIpcResult } from '../errors/app-error'
import { conversationExportPreview, exportConversation, type ConversationExportRecord } from '../export/conversation-export-service'
import type { CustomEndpoint } from '../providers/profile-manager'
import { ocrEntityExternalTarget } from '../external/ocr-entity-target'
import type { AppearanceController } from '../appearance/appearance-controller'
import type { CaptureService } from '../capture/capture-service'
import type { OnboardingController } from '../onboarding/onboarding-controller'
import type { ProviderRegistry } from '../providers/provider-registry'
import type { ExplorerIntegration } from '../shell/explorer-integration'
import type { ShortcutManager } from '../shortcuts/shortcut-manager'
import type { SettingsStore } from '../storage/settings-store'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'
import type { ConversationHistoryStore } from '../storage/conversation-history-store'
import type { UpdateController } from '../updates/update-controller'
import type { QuestionSessions } from '../windows/question-sessions'
import { ownsSettingsWebContents, showSettingsWindow } from '../windows/settings-window'
import { resolveWindowChromeController, type WindowChromeController, type WindowChromeIpcEvent } from '../windows/window-chrome'

export interface IpcDependencies { providers: ProviderRegistry; settings: SettingsStore; screenshots: TempScreenshotStore; history: ConversationHistoryStore; capture: CaptureService; onboarding: OnboardingController; questions: QuestionSessions; shortcuts: ShortcutManager; appearance: AppearanceController; explorer: ExplorerIntegration; updates: UpdateController }

export function registerIpc(dependencies: IpcDependencies): void {
  ipcMain.on(IPC.appearanceGet, (event) => { event.returnValue = dependencies.appearance.getState() })
  // Reading the registry is asynchronous, so the last verified result is cached for the sync snapshot.
  let shellRegistered = false
  const buildSettingsState = (): SettingsViewState => {
    const settings = dependencies.settings.get()
    return {
      appearance: dependencies.appearance.getState(),
      profiles: dependencies.providers.listProfiles(),
      chatGptRuntime: dependencies.providers.getChatGptRuntimeStatus(),
      shortcuts: dependencies.shortcuts.getState(),
      recipeShortcuts: dependencies.shortcuts.getRecipeState(),
      customPrompts: settings.customPrompts,
      recipes: settings.recipes,
      launchAtLogin: settings.launchAtLogin,
      shellIntegration: { enabled: settings.shellIntegrationEnabled, supported: process.platform === 'win32', registered: shellRegistered },
      onboardingStatus: settings.onboardingStatus,
      history: settings.history,
      ocrLanguageCode: settings.ocrLanguageCode,
      tempLocation: dependencies.screenshots.directory,
      appVersion: app.getVersion(),
      updates: dependencies.updates.getState()
    }
  }
  const broadcastSettings = (): void => {
    const state = buildSettingsState()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(IPC.settingsChanged, state)
    }
  }
  const refreshShellIntegration = async (): Promise<void> => {
    shellRegistered = await dependencies.explorer.verify() === 'registered'
  }
  /** The Ask submenu lists the saved prompts, so editing one has to rewrite the menu. */
  const rewriteShellIntegration = async (): Promise<void> => {
    if (!dependencies.settings.get().shellIntegrationEnabled) return
    await dependencies.explorer.enable()
    await refreshShellIntegration()
  }
  void refreshShellIntegration().then(broadcastSettings).catch(() => undefined)
  dependencies.providers.on('status', broadcastSettings)
  dependencies.updates.onStateChanged(broadcastSettings)
  const mutate = async (operation: () => Promise<unknown>): Promise<void> => { await operation(); broadcastSettings() }
  const handle = (
    channel: string,
    operation: (event: IpcMainInvokeEvent, ...arguments_: unknown[]) => unknown,
    fallbackCode?: AppErrorCode
  ): void => {
    ipcMain.handle(channel, (event, ...arguments_) => toIpcResult(() => operation(event, ...arguments_), fallbackCode))
  }

  handle(IPC.settingsGet, buildSettingsState)
  handle(IPC.settingsOpenOcrLanguages, () => shell.openExternal('ms-settings:regionlanguage'))
  handle(IPC.settingsSetAppearance, (_event, value) => mutate(() => dependencies.appearance.setPreference(requireAppearance(value))), 'validation')
  handle(IPC.settingsSetLaunchAtLogin, (_event, enabled) => mutate(async () => { if (typeof enabled !== 'boolean') throw new Error('Invalid launch setting.'); app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath }); await dependencies.settings.update({ launchAtLogin: enabled }) }), 'validation')
  handle(IPC.settingsSetShellIntegration, (_event, enabled) => mutate(async () => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid context-menu setting.')
    if (enabled) await dependencies.explorer.enable()
    else await dependencies.explorer.disable()
    await dependencies.settings.update({ shellIntegrationEnabled: enabled })
    await refreshShellIntegration()
  }), 'validation')
  handle(IPC.settingsSetShortcut,(_event, action, accelerator) => mutate(() => dependencies.shortcuts.set(requireShortcutAction(action), requireAccelerator(accelerator))), 'validation')
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
    await rewriteShellIntegration()
  }), 'validation')
  handle(IPC.settingsDeleteCustomPrompt, (_event, id) => mutate(async () => {
    const promptId = requireId(id)
    const settings = dependencies.settings.get()
    if (!settings.customPrompts.some((item) => item.id === promptId)) throw new Error('Custom prompt not found.')
    await dependencies.settings.update({ customPrompts: settings.customPrompts.filter((item) => item.id !== promptId) })
    await rewriteShellIntegration()
  }), 'validation')
  handle(IPC.settingsSaveRecipe, (_event, value) => mutate(async () => {
    const recipe = requireCaptureRecipe(value)
    const current = dependencies.settings.get().recipes
    const index = current.findIndex((item) => item.id === recipe.id)
    if (index < 0 && current.length >= 50) throw new Error('Capture recipe limit reached.')
    const previous = current[index]
    const nextRecipe = previous && recipeMaterial(previous) !== recipeMaterial(recipe)
      ? { ...recipe, autoSend: false, autoSendConsentVersion: 0 as const }
      : recipe
    const recipes = [...current]
    if (index >= 0) recipes[index] = nextRecipe
    else recipes.push(nextRecipe)
    await dependencies.shortcuts.setRecipes(recipes)
  }), 'validation')
  handle(IPC.settingsDuplicateRecipe, (_event, value) => mutate(async () => {
    const id = requireId(value)
    const current = dependencies.settings.get().recipes
    const recipe = current.find((item) => item.id === id)
    if (!recipe) throw new Error('Capture recipe not found.')
    if (current.length >= 50) throw new Error('Capture recipe limit reached.')
    await dependencies.shortcuts.setRecipes([...current, {
      ...structuredClone(recipe), id: randomUUID(), name: `${recipe.name} copy`.slice(0, 80), enabled: false,
      shortcut: null, autoSend: false, autoSendConsentVersion: 0
    }])
  }), 'validation')
  handle(IPC.settingsDeleteRecipe, (_event, value) => mutate(async () => {
    const id = requireId(value)
    const current = dependencies.settings.get().recipes
    if (!current.some((item) => item.id === id)) throw new Error('Capture recipe not found.')
    await dependencies.shortcuts.setRecipes(current.filter((item) => item.id !== id))
  }), 'validation')
  handle(IPC.settingsReorderRecipes, (_event, value) => mutate(async () => {
    if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) throw new Error('Invalid recipe order.')
    const current = dependencies.settings.get().recipes
    if (value.length !== current.length || new Set(value).size !== current.length || value.some((id) => !current.some((item) => item.id === id))) throw new Error('Recipe order is incomplete.')
    await dependencies.shortcuts.setRecipes(value.map((id) => current.find((item) => item.id === id)!))
  }), 'validation')
  handle(IPC.settingsExportRecipes, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options = {
      title: 'Export capture recipes', defaultPath: 'fovea-capture-recipes.json',
      filters: [{ name: 'Fovea capture recipes', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    const payload = {
      schemaVersion: 1,
      recipes: dependencies.settings.get().recipes.map((recipe) => ({ ...recipe, enabled: false, autoSend: false, autoSendConsentVersion: 0 }))
    }
    const temporary = `${result.filePath}.tmp`
    await writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, result.filePath)
    return true
  }, 'validation')
  handle(IPC.settingsImportRecipes, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: OpenDialogOptions = {
      title: 'Import capture recipes', properties: ['openFile'],
      filters: [{ name: 'Fovea capture recipes', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return 0
    const parsed = JSON.parse(await readFile(result.filePaths[0], 'utf8')) as { schemaVersion?: unknown; recipes?: unknown }
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.recipes)) throw new Error('This is not a supported Fovea recipe export.')
    const current = dependencies.settings.get().recipes
    const available = Math.max(0, 50 - current.length)
    const imported = parsed.recipes.slice(0, available).map((value) => ({
      ...requireCaptureRecipe(value), id: randomUUID(), enabled: false, autoSend: false, autoSendConsentVersion: 0 as const
    }))
    await dependencies.shortcuts.setRecipes([...current, ...imported])
    broadcastSettings()
    return imported.length
  }, 'validation')
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
  // Files created by this process still belong to capture overlays or question sessions. Their
  // owners delete them when they close; manual cleanup removes only orphaned files from older runs.
  handle(IPC.settingsDeleteTemp, () => dependencies.screenshots.cleanup(0, { preserveActive: true }))

  handle(IPC.updatesSetAutomaticChecks, (event, enabled) => {
    requireSettingsSender(event)
    if (typeof enabled !== 'boolean') throw new Error('Invalid automatic update setting.')
    return dependencies.updates.setAutomaticChecks(enabled)
  }, 'validation')
  handle(IPC.updatesCheck, (event) => { requireSettingsSender(event); return dependencies.updates.check('manual') })
  handle(IPC.updatesDownload, (event) => { requireSettingsSender(event); return dependencies.updates.download() })
  handle(IPC.updatesInstall, (event) => { requireSettingsSender(event); return dependencies.updates.install() })

  handle(IPC.profilesList, () => dependencies.providers.listProfiles())
  handle(IPC.profilesCreateApiKey, async (_event, provider, name, apiKey, endpoint) => { const result = await dependencies.providers.profiles.createApiKey(requireApiProvider(provider), requireString(name, 80), requireString(apiKey, 2048), requireCustomEndpoint(endpoint)); broadcastSettings(); return result }, 'validation')
  handle(IPC.profilesCreateChatGpt, async (_event, name) => { const result = await dependencies.providers.profiles.createChatGpt(name === undefined ? undefined : requireString(name, 80)); broadcastSettings(); return result }, 'validation')
  handle(IPC.profilesRename, (_event, id, name) => mutate(() => dependencies.providers.profiles.rename(requireId(id), requireString(name, 80))), 'validation')
  handle(IPC.profilesAuthenticate, (_event, id) => mutate(() => dependencies.providers.authenticate(requireId(id))), 'authentication-required')
  handle(IPC.profilesTest, async (_event, id) => { const result = await dependencies.providers.test(requireId(id)); broadcastSettings(); return result }, 'provider-unavailable')
  handle(IPC.profilesSignOut, (_event, id) => mutate(() => dependencies.providers.signOut(requireId(id))))
  handle(IPC.profilesDelete, (_event, id) => mutate(() => dependencies.providers.delete(requireId(id))))
  handle(IPC.profilesSetDefault, (_event, id) => mutate(() => dependencies.providers.profiles.setDefault(requireId(id))))
  handle(IPC.profilesSetDefaults, (_event, id, model, reasoning) => mutate(() => dependencies.providers.profiles.setDefaults(requireId(id), requireNullableString(model, 200), requireNullableString(reasoning, 50))), 'validation')
  handle(IPC.profilesModels, (_event, id) => dependencies.providers.listModels(requireId(id)), 'no-compatible-models')
  handle(IPC.chatGptRuntimeInstall, () => mutate(() => dependencies.providers.installChatGptRuntime()), 'provider-unavailable')
  handle(IPC.chatGptRuntimeRemove, () => mutate(() => dependencies.providers.removeChatGptRuntime()), 'provider-unavailable')

  handle(IPC.captureStart, (_event, mode) => dependencies.capture.begin(requireCaptureMode(mode)), 'capture-failed')
  handle(IPC.captureGetContext, (event) => dependencies.capture.getContext(event.sender.id), 'capture-failed')
  handle(IPC.captureReadyToShow, (event) => dependencies.capture.readyToShow(event.sender.id), 'capture-failed')
  handle(IPC.captureArmVideoFrame, (event) => dependencies.capture.armVideoFrame(event.sender.id), 'capture-failed')
  handle(IPC.captureProvideVideoFrame, (event, png, metadata) => dependencies.capture.provideVideoFrame(event.sender.id, requireCaptureFrame(png), requireCaptureVideoFrameMetadata(metadata)), 'capture-failed')
  handle(IPC.captureCancelVideoFrame, (event) => dependencies.capture.cancelVideoFrame(event.sender.id), 'capture-failed')
  handle(IPC.captureFreeze, (event, reason) => dependencies.capture.freeze(event.sender.id, requireCaptureFreezeReason(reason)), 'capture-failed')
  handle(IPC.captureAnalyze, (event, requestId) => {
    const id = requireId(requestId)
    return dependencies.capture.analyze(event.sender.id, (analysis) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.captureAnalysisProgress, { requestId: id, analysis })
    })
  }, 'capture-failed')
  handle(IPC.captureCancelAnalysis, (event) => dependencies.capture.cancelAnalysis(event.sender.id), 'capture-failed')
  handle(IPC.captureGetOcrLanguages, () => dependencies.questions.listOcrLanguages())
  handle(IPC.captureSetOcrLanguage, async (_event, value) => {
    const code = requireOcrLanguagePreference(value)
    if (code) {
      const languages = await dependencies.questions.listOcrLanguages()
      if (!languages.some((language) => language.code === code)) throw new Error('OCR language is not installed.')
    }
    await dependencies.settings.update({ ocrLanguageCode: code })
  }, 'validation')
  handle(IPC.captureSelect, (event, rectangle, operations = [], preferWebSearch = false, extractText = false, ocrLanguageCode, initialQuestion) => {
    if (!isRectangle(rectangle)) throw new Error('Invalid selection.')
    if (!Array.isArray(operations)) throw new Error('Invalid screenshot edits.')
    if (typeof preferWebSearch !== 'boolean') throw new Error('Invalid web-search preference.')
    if (typeof extractText !== 'boolean') throw new Error('Invalid text-extraction preference.')
    if (preferWebSearch && extractText) throw new Error('Web search and text extraction cannot both be enabled.')
    if (ocrLanguageCode !== undefined && (typeof ocrLanguageCode !== 'string' || !/^[A-Za-z0-9-]{2,35}$/.test(ocrLanguageCode))) throw new Error('Invalid OCR language.')
    if (!extractText && ocrLanguageCode !== undefined) throw new Error('OCR language requires text extraction.')
    if (initialQuestion !== undefined && (typeof initialQuestion !== 'string' || !initialQuestion.trim() || initialQuestion.length > 500)) throw new Error('Invalid initial question.')
    return dependencies.capture.select(rectangle, event.sender.id, operations as ImageEditOperation[], preferWebSearch, extractText, ocrLanguageCode, initialQuestion?.trim())
  }, 'capture-failed')
  handle(IPC.captureCancel, () => dependencies.capture.cancel())

  handle(IPC.questionGet, (_event, id) => dependencies.questions.get(requireId(id)))
  handle(IPC.questionGetFullImage, (_event, id, attachmentId) => dependencies.questions.getFullImage(requireId(id), requireId(attachmentId)), 'capture-failed')
  handle(IPC.questionRunOcr, (_event, id, attachmentId) => dependencies.questions.runOcr(requireId(id), requireId(attachmentId)), 'ocr-failed')
  handle(IPC.questionGetOcrResult, (_event, id, attachmentId) => dependencies.questions.getOcrResult(requireId(id), requireId(attachmentId)), 'ocr-failed')
  handle(IPC.questionSetOcrSelection, (_event, id, attachmentId, regionIds, includeNextRequest) => {
    if (!Array.isArray(regionIds) || regionIds.length > 2_000 || !regionIds.every((regionId) => typeof regionId === 'string' && regionId.length <= 100)) throw new Error('Invalid OCR region selection.')
    if (typeof includeNextRequest !== 'boolean') throw new Error('Invalid OCR inclusion preference.')
    return dependencies.questions.setOcrSelection(requireId(id), requireId(attachmentId), regionIds, includeNextRequest)
  }, 'validation')
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
  handle(IPC.questionImportClipboardImage, (event, value) => {
    const id = requireId(value)
    if (!dependencies.questions.owns(id, event.sender.id)) throw new Error('Images can only be attached from their question window.')
    const image = clipboard.readImage()
    if (image.isEmpty()) throw new Error('The clipboard does not contain an image.')
    return dependencies.questions.importClipboardImage(id, image.toPNG())
  }, 'validation')
  handle(IPC.questionPickImages, async (event, value) => {
    const id = requireId(value)
    if (!dependencies.questions.owns(id, event.sender.id)) throw new Error('Images can only be attached from their question window.')
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) throw new Error('The question window is unavailable.')
    const result = await dialog.showOpenDialog(owner, {
      title: 'Attach images', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled) return { added: 0, failures: [], cancelled: true }
    return dependencies.questions.importImagePaths(id, result.filePaths)
  }, 'validation')
  handle(IPC.questionImportDroppedFiles, (event, value, rawPaths) => {
    const id = requireId(value)
    if (!dependencies.questions.owns(id, event.sender.id)) throw new Error('Images can only be attached from their question window.')
    if (!Array.isArray(rawPaths) || rawPaths.length < 1 || rawPaths.length > 20 || !rawPaths.every((path) => typeof path === 'string' && path.length > 0 && path.length <= 32_767)) throw new Error('Drop local image files only.')
    return dependencies.questions.importImagePaths(id, rawPaths)
  }, 'validation')
  handle(IPC.questionExportPreview, async (event, value) => {
    const id = requireId(value)
    if (!dependencies.questions.owns(id, event.sender.id)) throw new Error('A conversation can only be exported from its question window.')
    return conversationExportPreview(await dependencies.questions.getExportRecord(id))
  })
  handle(IPC.questionExport, async (event, value, rawOptions) => {
    const id = requireId(value)
    if (!dependencies.questions.owns(id, event.sender.id)) throw new Error('A conversation can only be exported from its question window.')
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    return exportConversation(owner, await dependencies.questions.getExportRecord(id), requireExportOptions(rawOptions))
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
  handle(IPC.historyExportPreview, (_event, value) => {
    const record = dependencies.history.get(requireId(value))
    if (!record) throw new Error('That saved conversation no longer exists.')
    return conversationExportPreview(historyExportRecord(record))
  })
  handle(IPC.historyExport, (event, value, rawOptions) => {
    const record = dependencies.history.get(requireId(value))
    if (!record) throw new Error('That saved conversation no longer exists.')
    return exportConversation(BrowserWindow.fromWebContents(event.sender) ?? undefined, historyExportRecord(record), requireExportOptions(rawOptions))
  }, 'validation')
  handle(IPC.applicationOpenSettings, (_event, category) => showSettingsWindow(undefined, requireOptionalSettingsCategory(category)), 'validation')
  handle(IPC.clipboardWriteText, (_event, value) => {
    const text = requireString(value, 200_000)
    clipboard.writeText(text)
  }, 'validation')

  ipcMain.handle(IPC.windowChromeGetState, (event) => requireWindowChromeController(event).getState())
  ipcMain.on(IPC.windowChromeReady, (event) => getWindowChromeController(event)?.markRendererReady())
  ipcMain.handle(IPC.windowChromeMinimize, (event) => requireWindowChromeController(event).minimizeWindow())
  ipcMain.handle(IPC.windowChromeToggleMaximize, (event) => requireWindowChromeController(event).toggleMaximize())
  ipcMain.handle(IPC.windowChromeClose, (event) => requireWindowChromeController(event).closeWindow())
  ipcMain.handle(IPC.windowChromeBeginResize, (event, edge: unknown) => { if (!isWindowResizeEdge(edge)) throw new Error('Invalid window resize edge.'); requireWindowChromeController(event).beginResize(edge) })
  ipcMain.on(IPC.windowChromeUpdateResize, (event) => getWindowChromeController(event)?.requestResizeUpdate())
  ipcMain.on(IPC.windowChromeEndResize, (event) => getWindowChromeController(event)?.endResize())
  handle(IPC.externalOpen, async (_event, value) => { const url = new URL(requireString(value, 2048)); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only web links can be opened.'); await shell.openExternal(url.toString()) }, 'validation')
  handle(IPC.externalOpenOcrEntity, async (_event, kind, value) => {
    await shell.openExternal(ocrEntityExternalTarget(requireOcrExternalActionKind(kind), requireString(value, 2_048)))
  }, 'validation')
}

function requireSettingsSender(event: IpcMainInvokeEvent): void { if (event.sender.isDestroyed() || !ownsSettingsWebContents(event.sender.id)) throw new Error('Application updates are only available from Settings.') }
function requireWindowChromeController(event: IpcMainInvokeEvent | IpcMainEvent): WindowChromeController { const controller = resolveWindowChromeController(event as WindowChromeIpcEvent); const target = BrowserWindow.fromWebContents(event.sender); if (!target || target.isDestroyed() || target.id !== controller.windowId || target.webContents.id !== controller.webContentsId) throw new Error('Window chrome is unavailable for this sender.'); return controller }
function getWindowChromeController(event: IpcMainEvent): WindowChromeController | null { try { return requireWindowChromeController(event) } catch { return null } }
function requireString(value: unknown, max: number): string { if (typeof value !== 'string' || value.length > max) throw new Error('Invalid text value.'); return value }
function requireTrimmedString(value: unknown, max: number): string { const text = requireString(value, max).trim(); if (!text) throw new Error('Text value is required.'); return text }
function requireId(value: unknown): string { return requireString(value, 100) }
function requireNullableString(value: unknown, max: number): string | null { return value === null ? null : requireString(value, max) }
function requireAccelerator(value: unknown): string | null { return requireNullableString(value, 100) }
function requireAppearance(value: unknown): AppearancePreference { if (!['system', 'dark', 'light'].includes(String(value))) throw new Error('Invalid appearance.'); return value as AppearancePreference }
function requireOptionalSettingsCategory(value: unknown): SettingsCategory | undefined { if (value === undefined) return undefined; if (!isSettingsCategory(value)) throw new Error('Invalid Settings category.'); return value }
function requireOnboardingOutcome(value: unknown): Exclude<OnboardingStatus, 'pending'> { if (!['skipped', 'completed'].includes(String(value))) throw new Error('Invalid onboarding outcome.'); return value as Exclude<OnboardingStatus, 'pending'> }
function requireShortcutAction(value: unknown): ShortcutAction { if (!['region', 'display', 'window', 'repeat-last', 'settings'].includes(String(value))) throw new Error('Invalid shortcut action.'); return value as ShortcutAction }
function requireCaptureMode(value: unknown): CaptureMode { if (!['region', 'display', 'window', 'repeat-last'].includes(String(value))) throw new Error('Invalid capture mode.'); return value as CaptureMode }
function requireCaptureFreezeReason(value: unknown): CaptureFreezeReason { if (!['edit', 'analyze'].includes(String(value))) throw new Error('Invalid capture freeze reason.'); return value as CaptureFreezeReason }
function requireCaptureFrame(value: unknown): Uint8Array { if (!(value instanceof Uint8Array) || value.byteLength < 24 || value.byteLength > 64 * 1024 * 1024) throw new Error('Invalid live capture frame.'); return value }
function requireCaptureVideoFrameMetadata(value: unknown): CaptureVideoFrameMetadata {
  if (!value || typeof value !== 'object') throw new Error('Invalid live capture metadata.')
  const item = value as Record<string, unknown>
  if (!item.viewport || typeof item.viewport !== 'object') throw new Error('Invalid live capture viewport.')
  const viewport = item.viewport as Record<string, unknown>
  const width = requireInteger(viewport.width, 1, 32_768)
  const height = requireInteger(viewport.height, 1, 32_768)
  if (item.rectangle === undefined) return { viewport: { width, height } }
  if (!isRectangle(item.rectangle)) throw new Error('Invalid live capture selection.')
  return { viewport: { width, height }, rectangle: item.rectangle }
}
function requireOcrExternalActionKind(value: unknown): OcrExternalActionKind { if (!['url', 'email', 'phone'].includes(String(value))) throw new Error('Invalid OCR action.'); return value as OcrExternalActionKind }
function requireOcrLanguagePreference(value: unknown): string { const code = requireString(value, 35); if (code && !/^[A-Za-z0-9-]{2,35}$/.test(code)) throw new Error('Invalid OCR language.'); return code }
function requireApiProvider(value: unknown): Exclude<ProviderKind, 'chatgpt'> { if (!['openai', 'anthropic', 'openrouter', 'custom'].includes(String(value))) throw new Error('Invalid API provider.'); return value as Exclude<ProviderKind, 'chatgpt'> }
function requireCustomEndpoint(value: unknown): CustomEndpoint {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object') throw new Error('Invalid API address.')
  const candidate = value as Record<string, unknown>
  const modelIds = candidate.modelIds
  if (modelIds !== undefined && (!Array.isArray(modelIds) || modelIds.length > MAX_CUSTOM_MODEL_IDS || !modelIds.every((id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 200))) {
    throw new Error('Invalid model identifiers.')
  }
  return {
    // normaliseBaseUrl enforces https, rejects embedded credentials, and strips query strings.
    ...(candidate.baseUrl === undefined ? {} : { baseUrl: normaliseBaseUrl(requireString(candidate.baseUrl, MAX_BASE_URL_LENGTH)) }),
    ...(modelIds === undefined ? {} : { modelIds: modelIds as string[] })
  }
}
function requireSelection(value: unknown): ConversationSelection { if (!value || typeof value !== 'object') throw new Error('Invalid conversation selection.'); const item = value as Record<string, unknown>; const provider = String(item.provider); if (!['chatgpt', 'openai', 'anthropic', 'openrouter', 'custom'].includes(provider)) throw new Error('Invalid provider selection.'); return { profileId: requireTrimmedString(item.profileId, 100), provider: provider as ProviderKind, modelId: requireTrimmedString(item.modelId, 200), reasoningEffort: requireNullableString(item.reasoningEffort, 50) } }
function isRectangle(value: unknown): value is Rectangle { return Boolean(value && typeof value === 'object' && ['x','y','width','height'].every((key) => typeof (value as Record<string, unknown>)[key] === 'number' && Number.isFinite((value as Record<string, unknown>)[key]))) }
function requireInteger(value: unknown, minimum: number, maximum: number): number { if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error('Invalid number.'); return value }

function requireCaptureRecipe(value: unknown): CaptureRecipe {
  if (!value || typeof value !== 'object') throw new Error('Invalid capture recipe.')
  const item = value as Record<string, unknown>
  const providerValue = item.provider
  if (!providerValue || typeof providerValue !== 'object') throw new Error('Invalid recipe provider.')
  const providerItem = providerValue as Record<string, unknown>
  const provider = providerItem.mode === 'current-default'
    ? { mode: 'current-default' as const }
    : providerItem.mode === 'fixed'
      ? { mode: 'fixed' as const, selection: requireSelection(providerItem.selection) }
      : (() => { throw new Error('Invalid recipe provider.') })()
  const captureMode = requireCaptureMode(item.captureMode)
  const shortcut = requireAccelerator(item.shortcut)
  const extractText = item.extractText === true
  const ocrLanguageCode = item.ocrLanguageCode === undefined
    ? undefined
    : requireOcrLanguagePreference(item.ocrLanguageCode)
  if (!extractText && ocrLanguageCode) throw new Error('A recipe OCR language requires local text extraction.')
  const autoSend = item.autoSend === true
  const consent = item.autoSendConsentVersion === 1 ? 1 : 0
  if (autoSend && consent !== 1) throw new Error('Auto-send requires explicit per-recipe consent.')
  return {
    id: requireTrimmedString(item.id, 100),
    name: requireTrimmedString(item.name, 80),
    enabled: item.enabled === true,
    captureMode,
    prompt: requireTrimmedString(item.prompt, 10_000),
    preferWebSearch: item.preferWebSearch === true,
    extractText,
    ...(ocrLanguageCode ? { ocrLanguageCode } : {}),
    provider,
    shortcut,
    autoSend,
    autoSendConsentVersion: consent
  }
}

function recipeMaterial(recipe: CaptureRecipe): string {
  return JSON.stringify({
    captureMode: recipe.captureMode,
    prompt: recipe.prompt,
    preferWebSearch: recipe.preferWebSearch,
    extractText: recipe.extractText,
    ocrLanguageCode: recipe.ocrLanguageCode ?? null,
    provider: recipe.provider
  })
}

function requireExportOptions(value: unknown): ConversationExportOptions {
  if (!value || typeof value !== 'object') throw new Error('Invalid export options.')
  const options = value as Record<string, unknown>
  if (!['markdown', 'json'].includes(String(options.format))) throw new Error('Invalid export format.')
  if (typeof options.includeScreenshots !== 'boolean' || typeof options.includeProviderMetadata !== 'boolean') throw new Error('Invalid export privacy options.')
  return { format: options.format as ConversationExportOptions['format'], includeScreenshots: options.includeScreenshots, includeProviderMetadata: options.includeProviderMetadata }
}

function historyExportRecord(record: ReturnType<ConversationHistoryStore['get']> & {}): ConversationExportRecord {
  if (!record) throw new Error('Conversation history is unavailable.')
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    exchanges: structuredClone(record.exchanges),
    segments: structuredClone(record.segments),
    selection: record.selection ? structuredClone(record.selection) : null,
    attachments: record.attachments.map((attachment) => ({ ...attachment, ocr: null }))
  }
}
