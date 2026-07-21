import { app, dialog, globalShortcut, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { AppearanceController } from './appearance/appearance-controller'
import { CaptureService } from './capture/capture-service'
import { registerIpc } from './ipc/register-ipc'
import { CodexAppServerProvider } from './providers/codex-app-server/codex-app-server-provider'
import { ProfileManager } from './providers/profile-manager'
import { ProviderRegistry } from './providers/provider-registry'
import { ShortcutManager } from './shortcuts/shortcut-manager'
import { CredentialStore } from './storage/credential-store'
import { SettingsStore } from './storage/settings-store'
import { TempScreenshotStore } from './storage/temp-screenshot-store'
import { TrayController } from './tray/tray-controller'
import { QuestionSessions } from './windows/question-sessions'
import { showSettingsWindow } from './windows/settings-window'

app.setName('Fovea')
app.setPath('userData', join(app.getPath('appData'), 'Fovea'))

if (!app.requestSingleInstanceLock()) app.quit()
else void startApplication().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[app] Startup failed: ${redact(message)}`)
  if (app.isReady()) dialog.showErrorBox('Fovea could not start', message)
})

async function startApplication(): Promise<void> {
  app.setAppUserModelId('com.fovea.desktop')
  await app.whenReady()
  const userData = app.getPath('userData')
  const settings = new SettingsStore(join(userData, 'settings.v2.json'))
  const credentials = new CredentialStore(join(userData, 'credentials.v1.json'), safeStorage)
  const screenshots = new TempScreenshotStore(join(userData, 'temporary-screenshots'))
  await Promise.all([settings.load(), credentials.load(), screenshots.initialise()])
  await screenshots.cleanup()

  const appearance = new AppearanceController(settings)
  appearance.initialise()
  const runtimeRoot = join(userData, 'runtime')
  const codex = new CodexAppServerProvider({
    binaryPath: app.isPackaged ? join(process.resourcesPath, 'sidecar', 'codex.exe') : join(app.getAppPath(), 'resources', 'sidecar', 'codex.exe'),
    codexHome: join(runtimeRoot, 'codex-home'), workingDirectory: join(runtimeRoot, 'workspace'), openExternal: (url) => shell.openExternal(url), getSelectedModel: () => null
  })
  codex.on('diagnostic', (message: string) => console.info(`[codex] ${redact(message)}`))
  codex.on('warning', (message: string) => console.warn(`[codex] ${redact(message)}`))
  const profiles = new ProfileManager(settings, credentials)
  const providers = new ProviderRegistry(profiles, codex)
  const services: { questions?: QuestionSessions } = {}
  const capture = new CaptureService(screenshots, (completed) => services.questions!.open(completed), (message) => dialog.showErrorBox('Fovea capture', message))
  const questions = new QuestionSessions(providers, screenshots, () => capture.begin('region'))
  services.questions = questions

  let tray: TrayController | null = null
  const openSettingsSafely = (): void => {
    void showSettingsWindow(tray?.getBounds()).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[window] Settings failed to open: ${redact(message)}`)
      dialog.showErrorBox('Fovea Settings', message)
    })
  }
  const captureSafely = (mode: Parameters<CaptureService['begin']>[0]): void => { void capture.begin(mode).catch((error) => dialog.showErrorBox('Fovea capture', error instanceof Error ? error.message : String(error))) }
  const shortcuts = new ShortcutManager(globalShortcut, settings, {
    region: () => captureSafely('region'), display: () => captureSafely('display'), window: () => captureSafely('window'), 'repeat-last': () => captureSafely('repeat-last'), settings: openSettingsSafely
  })
  shortcuts.initialise()
  tray = new TrayController(async (mode) => capture.begin(mode), shortcuts, providers, settings)
  tray.initialise()
  registerIpc({ providers, settings, screenshots, capture, questions, shortcuts, appearance })
  app.setLoginItemSettings({ openAtLogin: settings.get().launchAtLogin, path: process.execPath })

  try { await providers.initialise() }
  catch (error) { console.warn(`[provider] ChatGPT adapter unavailable: ${redact(error instanceof Error ? error.message : String(error))}`) }
  if (!settings.get().onboardingCompleted) openSettingsSafely()

  app.on('second-instance', openSettingsSafely)
  app.on('activate', openSettingsSafely)
  let shuttingDown = false
  app.on('before-quit', () => { if (shuttingDown) return; shuttingDown = true; capture.dispose(); shortcuts.dispose(); tray.dispose(); appearance.dispose(); void questions.dispose(); void providers.dispose() })
}

function redact(message: string): string { return message.replace(/(?:sk|key)-[\w-]+/gi, '[redacted]') }
