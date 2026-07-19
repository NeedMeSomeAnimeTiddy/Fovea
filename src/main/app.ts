import { app, dialog, globalShortcut, shell } from 'electron'
import { join } from 'node:path'
import { CaptureService } from './capture/capture-service'
import { registerIpc } from './ipc/register-ipc'
import { CodexAppServerProvider } from './providers/codex-app-server/codex-app-server-provider'
import { SettingsStore } from './storage/settings-store'
import { TempScreenshotStore } from './storage/temp-screenshot-store'
import { QuestionSessions } from './windows/question-sessions'
import { showSettingsWindow } from './windows/settings-window'

const SHORTCUT = 'CommandOrControl+Shift+Space'

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void startApplication()
}

async function startApplication(): Promise<void> {
  app.setAppUserModelId('com.snipchat.prototype')
  await app.whenReady()

  const userData = app.getPath('userData')
  const settings = new SettingsStore(join(userData, 'settings.json'))
  const screenshots = new TempScreenshotStore(join(userData, 'temporary-screenshots'))
  await settings.load()
  await screenshots.initialise()
  await screenshots.cleanup()

  const runtimeRoot = join(userData, 'runtime')
  const binaryPath = app.isPackaged
    ? join(process.resourcesPath, 'sidecar', 'codex.exe')
    : join(app.getAppPath(), 'resources', 'sidecar', 'codex.exe')

  const provider = new CodexAppServerProvider({
    binaryPath,
    codexHome: join(runtimeRoot, 'codex-home'),
    workingDirectory: join(runtimeRoot, 'workspace'),
    openExternal: (url) => shell.openExternal(url),
    getSelectedModel: () => settings.get().selectedModelId
  })
  let lastModelRateLimitDiagnostic = 0
  provider.on('diagnostic', (message: string) => {
    const isModelRateLimit = /failed to refresh available models:.*(?:\b429\b|too many requests)/is.test(message)
    if (isModelRateLimit && Date.now() - lastModelRateLimitDiagnostic < 60_000) return
    if (isModelRateLimit) lastModelRateLimitDiagnostic = Date.now()
    console.info(`[codex] ${message}`)
  })
  provider.on('warning', (message: string) => console.warn(`[codex] ${message}`))

  const services: { questions?: QuestionSessions } = {}
  const capture = new CaptureService(
    screenshots,
    async (completed) => services.questions!.open(completed),
    (message) => dialog.showErrorBox('SnipChat capture', message)
  )
  const questions = new QuestionSessions(provider, screenshots, () => capture.begin())
  services.questions = questions
  registerIpc({ provider, settings, screenshots, capture, questions, shortcut: 'Ctrl+Shift+Space' })

  try {
    await provider.initialise()
  } catch (error) {
    dialog.showErrorBox(
      'Codex app-server unavailable',
      error instanceof Error ? error.message : 'The bundled Codex service could not be started.'
    )
  }

  const registered = globalShortcut.register(SHORTCUT, () => {
    void capture.begin().catch((error) =>
      dialog.showErrorBox('Screen capture failed', error instanceof Error ? error.message : String(error))
    )
  })
  if (!registered) dialog.showErrorBox('Shortcut unavailable', 'Ctrl+Shift+Space is already used by another application.')

  app.setLoginItemSettings({ openAtLogin: settings.get().launchAtLogin, path: process.execPath })
  await showSettingsWindow()

  app.on('second-instance', () => void showSettingsWindow())
  app.on('activate', () => void showSettingsWindow())
  app.on('will-quit', () => globalShortcut.unregisterAll())
  app.on('before-quit', () => {
    capture.cancel()
    void questions.dispose()
    void provider.dispose()
  })
}
