import { app, dialog, globalShortcut, safeStorage, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UPDATE_RELEASE_MARKER_FIELD } from '@shared/types/update'
import { AppearanceController } from './appearance/appearance-controller'
import { CaptureService } from './capture/capture-service'
import { ImageEditorService } from './capture/image-editor-service'
import { OmniParserDetectorService, type ScreenshotElementDetector } from './capture/screenshot-element-detector-service'
import { WindowsUiAutomationService } from './capture/windows-ui-automation-service'
import { FileAnalysisService } from './files/file-analysis-service'
import { PdfIngestionService, registerDocumentScheme } from './files/pdf-ingestion-service'
import { registerIpc } from './ipc/register-ipc'
import { parseAnalyseArguments, type AnalyseRequest } from './shell/analyse-arguments'
import { ExplorerIntegration } from './shell/explorer-integration'
import { OnboardingController, shouldShowOnboardingAtStartup } from './onboarding/onboarding-controller'
import { TesseractOcrService } from './ocr/ocr-service'
import { PaddleFirstOcrService, PaddleOcrService, resolvePaddleOcrProfile } from './ocr/paddle-ocr-service'
import { NativeFirstOcrService, WindowsOcrService } from './ocr/windows-ocr-service'
import { CodexAppServerProvider } from './providers/codex-app-server/codex-app-server-provider'
import { ProfileManager } from './providers/profile-manager'
import { ProviderRegistry } from './providers/provider-registry'
import { ShortcutManager } from './shortcuts/shortcut-manager'
import { CredentialStore } from './storage/credential-store'
import { ConversationHistoryStore } from './storage/conversation-history-store'
import { SettingsStore } from './storage/settings-store'
import { TempScreenshotStore } from './storage/temp-screenshot-store'
import { TrayController } from './tray/tray-controller'
import { QuestionSessions } from './windows/question-sessions'
import { CodexRuntimeManager } from './runtime/codex-runtime-manager'
import { showSettingsWindow } from './windows/settings-window'
import { toAppError } from './errors/app-error'
import { UpdateController } from './updates/update-controller'

app.setName('Fovea')
app.setPath('userData', join(app.getPath('appData'), 'Fovea'))
// Fovea is tray-first: closing or cancelling its last window must not end the process.
app.on('window-all-closed', () => undefined)

// The hidden PDF renderer fetches its document over this scheme, which must be declared before ready.
registerDocumentScheme()

/**
 * A context-menu launch can arrive before the services that handle it exist, so the request waits
 * here until the application has finished starting.
 */
let dispatchAnalyseRequest: ((request: AnalyseRequest) => void) | null = null
let pendingAnalyseRequest: AnalyseRequest | null = parseAnalyseArguments(process.argv, { appPath: app.getAppPath() })

function queueAnalyseRequest(request: AnalyseRequest): void {
  if (dispatchAnalyseRequest) dispatchAnalyseRequest(request)
  else pendingAnalyseRequest = request
}

if (!app.requestSingleInstanceLock()) app.quit()
else void startApplication().catch((error) => {
  const appError = toAppError(error)
  console.error(`[app] Startup failed: ${appError.technicalDetails ?? appError.message}`)
  if (app.isReady()) dialog.showErrorBox(appError.title, appError.message)
})

async function startApplication(): Promise<void> {
  app.setAppUserModelId('com.fovea.desktop')
  await app.whenReady()
  const userData = app.getPath('userData')
  const settings = new SettingsStore(join(userData, 'settings.v2.json'))
  const credentials = new CredentialStore(join(userData, 'credentials.v1.json'), safeStorage)
  const screenshots = new TempScreenshotStore(join(userData, 'temporary-screenshots'))
  const history = new ConversationHistoryStore(
    join(userData, 'history.v2.sqlite'),
    join(userData, 'conversation-images'),
    join(userData, 'history.v1.json')
  )
  await Promise.all([settings.load(), credentials.load(), screenshots.initialise(), history.initialise()])
  await Promise.all([screenshots.cleanup(), history.applyRetention(settings.get().history.retentionDays)])

  const updates = new UpdateController({
    runtime: {
      isPackaged: app.isPackaged,
      platform: process.platform,
      architecture: process.arch,
      currentVersion: app.getVersion(),
      ...(app.isPackaged ? { releaseMarker: readPackagedUpdateMarker() } : {})
    },
    preferences: {
      getAutomaticChecks: () => settings.get().automaticUpdateChecks,
      setAutomaticChecks: async (enabled) => { await settings.update({ automaticUpdateChecks: enabled }) }
    },
    updater: autoUpdater
  })
  updates.initialise()

  const appearance = new AppearanceController(settings)
  appearance.initialise()
  const runtimeRoot = join(userData, 'runtime')
  const codexRuntime = new CodexRuntimeManager({
    runtimeDirectory: join(runtimeRoot, 'providers', 'codex'),
    ...(!app.isPackaged ? { bundledBinaryPath: join(app.getAppPath(), 'resources', 'sidecar', 'codex.exe') } : {})
  })
  const codex = new CodexAppServerProvider({
    binaryPath: codexRuntime.binaryPath,
    codexHome: join(runtimeRoot, 'codex-home'), workingDirectory: join(runtimeRoot, 'workspace'), openExternal: (url) => shell.openExternal(url), getSelectedModel: () => null
  })
  codex.on('diagnostic', (message: string) => console.info(`[codex] ${redact(message)}`))
  codex.on('warning', (message: string) => console.warn(`[codex] ${redact(message)}`))
  const profiles = new ProfileManager(settings, credentials)
  const providers = new ProviderRegistry(profiles, codex, codexRuntime)
  const services: { questions?: QuestionSessions } = {}
  const imageEditor = new ImageEditorService(screenshots)
  const tesseractOcr = new TesseractOcrService(
    app.isPackaged
      ? join(process.resourcesPath, 'ocr', 'lang')
      : join(app.getAppPath(), 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int')
  )
  const windowsOcr = new WindowsOcrService(
    app.isPackaged
      ? join(process.resourcesPath, 'ocr', 'windows-ocr.ps1')
      : join(app.getAppPath(), 'resources', 'ocr', 'windows-ocr.ps1')
  )
  const paddleOcr = new PaddleOcrService({
    pythonPath: process.env.FOVEA_PADDLE_PYTHON?.trim() || (app.isPackaged
      ? join(process.resourcesPath, 'ocr', 'paddle', 'python.exe')
      : join(app.getAppPath(), '.venv-paddleocr', 'Scripts', 'python.exe')),
    scriptPath: app.isPackaged
      ? join(process.resourcesPath, 'ocr', 'paddle-ocr.py')
      : join(app.getAppPath(), 'resources', 'ocr', 'paddle-ocr.py'),
    runtimePath: app.isPackaged
      ? join(runtimeRoot, 'paddle-ocr')
      : join(app.getAppPath(), '.paddle-ocr-cache'),
    profile: resolvePaddleOcrProfile(process.env.FOVEA_PADDLE_OCR_PROFILE)
  })
  const ocr = new NativeFirstOcrService(windowsOcr, new PaddleFirstOcrService(paddleOcr, tesseractOcr))
  const uiAutomation = new WindowsUiAutomationService(
    app.isPackaged
      ? join(process.resourcesPath, 'automation', 'windows-ui-elements.ps1')
      : join(app.getAppPath(), 'resources', 'automation', 'windows-ui-elements.ps1')
  )
  const screenshotDetector = createScreenshotDetector(app.getAppPath(), runtimeRoot)
  const capture = new CaptureService(
    screenshots,
    (completed) => services.questions!.open(completed),
    (message) => showSafeError(message, 'capture-failed'),
    imageEditor,
    ocr,
    uiAutomation,
    screenshotDetector
  )
  // Built before the sessions so they can share one ingestion path: the Explorer context menu
  // and images dropped, pasted, or picked into a conversation all normalise the same way.
  const files = new FileAnalysisService(
    screenshots,
    (analysis) => services.questions!.openFiles(analysis),
    (message) => showSafeError(message, 'capture-failed'),
    new PdfIngestionService()
  )
  const questions = new QuestionSessions(providers, screenshots, (destination) => capture.begin('region', destination), undefined, history, settings, imageEditor, ocr, files)
  services.questions = questions
  const explorer = new ExplorerIntegration(
    {
      executablePath: process.execPath,
      // A development run launches Electron against the project, which Explorer must repeat.
      ...(app.isPackaged ? {} : { appPath: app.getAppPath() })
    },
    process.platform,
    undefined,
    () => settings.get().customPrompts.map(({ id, label }) => ({ id, label }))
  )

  let tray: TrayController | null = null
  const onboarding = new OnboardingController(capture, screenshots, async () => {
    await showSettingsWindow(tray?.getBounds())
  })
  const openSettingsSafely = (): void => {
    void showSettingsWindow(tray?.getBounds()).catch((error) => {
      const appError = toAppError(error)
      console.error(`[window] Settings failed to open: ${appError.technicalDetails ?? appError.message}`)
      dialog.showErrorBox(appError.title, appError.message)
    })
  }
  const captureSafely = (mode: Parameters<CaptureService['begin']>[0]): void => { void capture.begin(mode).catch((error) => showSafeError(error, 'capture-failed')) }
  const runRecipeSafely = (recipeId: string): void => {
    const recipe = settings.get().recipes.find((item) => item.id === recipeId && item.enabled)
    if (!recipe) return
    void capture.begin(recipe.captureMode, {
      onCompleted: (completed) => questions.open(completed, recipe)
    }).catch((error) => showSafeError(error, 'capture-failed'))
  }
  const shortcuts = new ShortcutManager(globalShortcut, settings, {
    region: () => captureSafely('region'), display: () => captureSafely('display'), window: () => captureSafely('window'), 'repeat-last': () => captureSafely('repeat-last'), settings: openSettingsSafely
  }, runRecipeSafely)
  shortcuts.initialise()
  tray = new TrayController(async (mode) => capture.begin(mode), shortcuts, providers, settings, updates)
  tray.initialise()
  providers.on('status', () => tray?.refreshStatus())
  updates.onStateChanged(() => tray?.refreshStatus())
  registerIpc({ providers, settings, screenshots, history, capture, onboarding, questions, shortcuts, appearance, explorer, updates })
  capture.prewarm()
  app.setLoginItemSettings({ openAtLogin: settings.get().launchAtLogin, path: process.execPath })
  // The executable path changes when Fovea is reinstalled, so an enabled entry is re-asserted.
  if (settings.get().shellIntegrationEnabled) {
    void explorer.enable().catch((error) => {
      console.warn(`[shell] The Explorer context-menu entry could not be refreshed: ${redact(error instanceof Error ? error.message : String(error))}`)
    })
  }

  const analyseSafely = (request: AnalyseRequest): void => {
    // The prompt text is resolved here rather than carried on the command line, so a prompt that
    // has since been edited or deleted simply falls back to an empty question.
    const prompt = request.promptId
      ? settings.get().customPrompts.find((item) => item.id === request.promptId)?.prompt
      : undefined
    void files.analyse(request.paths, request.dropped, request.action, prompt)
      .catch((error) => showSafeError(error, 'capture-failed'))
  }
  dispatchAnalyseRequest = analyseSafely
  if (pendingAnalyseRequest) {
    const request = pendingAnalyseRequest
    pendingAnalyseRequest = null
    analyseSafely(request)
  }

  try { await providers.initialise() }
  catch (error) { console.warn(`[provider] ChatGPT adapter unavailable: ${redact(error instanceof Error ? error.message : String(error))}`) }
  if (shouldShowOnboardingAtStartup(settings.get().onboardingStatus)) openSettingsSafely()

  app.on('second-instance', (_event, argv) => {
    // A context-menu click on an already-running Fovea arrives here rather than as a new process.
    const request = parseAnalyseArguments(argv, { appPath: app.getAppPath() })
    if (request) queueAnalyseRequest(request)
    else openSettingsSafely()
  })
  app.on('activate', openSettingsSafely)
  let shuttingDown = false
  app.on('before-quit', (event) => {
    if (shuttingDown) return
    event.preventDefault()
    shuttingDown = true
    capture.dispose()
    shortcuts.dispose()
    tray.dispose()
    updates.dispose()
    appearance.dispose()
    void questions.dispose()
      .catch(() => undefined)
      .then(() => providers.dispose())
      .catch(() => undefined)
      .finally(() => {
        history.dispose()
        app.quit()
      })
  })
}

function readPackagedUpdateMarker(): unknown {
  try {
    const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as Record<string, unknown>
    return metadata[UPDATE_RELEASE_MARKER_FIELD]
  } catch (error) {
    console.warn(`[updates] Packaged release metadata is unavailable: ${redact(error instanceof Error ? error.message : String(error))}`)
    return undefined
  }
}

function redact(message: string): string { return message.replace(/(?:sk|key)-[\w-]+/gi, '[redacted]') }

function createScreenshotDetector(appPath: string, runtimeRoot: string): ScreenshotElementDetector | undefined {
  const backend = process.env.FOVEA_ANALYZE_BACKEND?.trim().toLocaleLowerCase() || 'auto'
  if (['heuristic', 'legacy', 'off'].includes(backend)) return undefined
  const omniParserRoot = process.env.FOVEA_OMNIPARSER_ROOT?.trim() || (app.isPackaged
    ? join(process.resourcesPath, 'analysis', 'omniparser')
    : join(appPath, '.omniparser-runtime', 'source'))
  const pythonPath = process.env.FOVEA_OMNIPARSER_PYTHON?.trim() || (app.isPackaged
    ? join(process.resourcesPath, 'analysis', 'omniparser-python', 'python.exe')
    : join(appPath, '.venv-omniparser', 'Scripts', 'python.exe'))
  const modelPath = process.env.FOVEA_OMNIPARSER_MODEL?.trim() ||
    join(omniParserRoot, 'weights', 'icon_detect_v3', 'model.pt')
  const configuredFaceModelPath = process.env.FOVEA_FACE_MODEL?.trim() ||
    join(omniParserRoot, 'weights', 'face_detection_yunet', 'face_detection_yunet_2023mar.onnx')
  const available = [
    pythonPath,
    join(omniParserRoot, 'util', 'yolov9.py'),
    modelPath
  ].every((path) => existsSync(path))
  if (!available) {
    if (backend !== 'auto') {
      console.warn(
        '[omniparser] Analyze requested the screenshot detector, but its runtime is incomplete. ' +
        'Run npm run omniparser:setup or configure FOVEA_OMNIPARSER_ROOT.'
      )
    }
    return undefined
  }
  const faceModelPath = existsSync(configuredFaceModelPath) ? configuredFaceModelPath : undefined
  console.info(
    `[omniparser] Screenshot-anchored Analyze backend is enabled` +
    `${faceModelPath ? ' with frozen-screen face detection' : ' (face model not installed)'}.`
  )
  return new OmniParserDetectorService({
    pythonPath,
    scriptPath: app.isPackaged
      ? join(process.resourcesPath, 'analysis', 'omniparser-detector.py')
      : join(appPath, 'resources', 'analysis', 'omniparser-detector.py'),
    runtimePath: join(runtimeRoot, 'omniparser'),
    omniParserRoot,
    modelPath,
    faceModelPath,
    device: process.env.FOVEA_OMNIPARSER_DEVICE?.trim() || 'auto',
    confidence: environmentNumber('FOVEA_OMNIPARSER_CONFIDENCE', 0.08, 0.01, 0.95),
    faceConfidence: environmentNumber('FOVEA_FACE_CONFIDENCE', 0.82, 0.5, 0.99),
    tileSize: environmentNumber('FOVEA_OMNIPARSER_TILE_SIZE', 1280, 512, 2048),
    tileOverlap: environmentNumber('FOVEA_OMNIPARSER_TILE_OVERLAP', 0.125, 0.05, 0.35),
    fullFrameLongSide: environmentNumber('FOVEA_OMNIPARSER_FULL_FRAME', 1920, 960, 4096),
    fullNative: process.env.FOVEA_OMNIPARSER_FULL_NATIVE === '1',
    maxDetections: environmentNumber('FOVEA_OMNIPARSER_MAX_DETECTIONS', 500, 20, 1000)
  })
}

function environmentNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback
}

function showSafeError(error: unknown, fallbackCode: 'capture-failed' | 'unexpected'): void {
  const appError = toAppError(error, fallbackCode)
  console.error(`[app] ${appError.title}: ${appError.technicalDetails ?? appError.message}`)
  dialog.showErrorBox(appError.title, appError.message)
}
