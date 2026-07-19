import { app, screen, type BrowserWindow } from 'electron'
import type { WindowMaterial } from '@shared/contracts/ipc'
import {
  getWindowAppearanceOptions,
  selectWindowMaterial,
  type WindowSurfaceSizes
} from './window-appearance'
import { registerBrowserWindowChrome } from './window-chrome'
import { loadRenderer, secureWindow } from './window-factory'

const SETTINGS_WINDOW_SIZES: WindowSurfaceSizes = {
  surfaceSize: { width: 650, height: 760 },
  minimumSurfaceSize: { width: 560, height: 640 }
}

export const SETTINGS_WINDOW_READY_TIMEOUT_MS = 10_000

let settingsWindow: BrowserWindow | null = null
let settingsWindowOpening: Promise<BrowserWindow> | null = null
let materialModeLogged = false

export async function showSettingsWindow(): Promise<BrowserWindow> {
  if (settingsWindowOpening) return settingsWindowOpening
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }

  const material = selectWindowMaterial({
    disableTransparentWindows: app.commandLine.hasSwitch('disable-transparent-windows')
  })
  const opening = createSettingsWindowAttempt(material, material === 'transparent')
  settingsWindowOpening = opening

  try {
    return await opening
  } finally {
    if (settingsWindowOpening === opening) settingsWindowOpening = null
  }
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null
}

async function createSettingsWindowAttempt(
  material: WindowMaterial,
  fallbackRetryEligible: boolean
): Promise<BrowserWindow> {
  const appearance = getWindowAppearanceOptions(
    SETTINGS_WINDOW_SIZES,
    material,
    screen.getPrimaryDisplay().workArea
  )
  const window = secureWindow({
    width: appearance.size.width,
    height: appearance.size.height,
    minWidth: appearance.minimumSize.width,
    minHeight: appearance.minimumSize.height,
    frame: appearance.frame,
    transparent: appearance.transparent,
    backgroundColor: appearance.backgroundColor,
    show: appearance.show,
    useContentSize: appearance.useContentSize,
    hasShadow: appearance.hasShadow,
    resizable: appearance.resizable,
    maximizable: appearance.maximizable,
    minimizable: appearance.minimizable,
    closable: appearance.closable,
    movable: appearance.movable,
    fullscreenable: appearance.fullscreenable,
    thickFrame: appearance.thickFrame,
    roundedCorners: appearance.roundedCorners,
    title: 'SnipChat Settings',
    autoHideMenuBar: true
  })
  settingsWindow = window

  let settled = false
  let settleReadiness!: (outcome: SettingsReadinessOutcome) => void
  const readiness = new Promise<SettingsReadinessOutcome>((resolve) => {
    settleReadiness = (outcome): void => {
      if (settled) return
      settled = true
      clearTimeout(readinessTimer)
      resolve(outcome)
    }
  })

  const controller = registerBrowserWindowChrome(window, screen, {
    kind: 'settings',
    material,
    ...SETTINGS_WINDOW_SIZES,
    fallbackRetryEligible,
    onReady: () => settleReadiness('ready')
  })
  const refitMaximizedBounds = (): void => controller.refitMaximizedBounds()
  screen.on('display-metrics-changed', refitMaximizedBounds)
  screen.on('display-removed', refitMaximizedBounds)

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.once('closed', () => {
    screen.off('display-metrics-changed', refitMaximizedBounds)
    screen.off('display-removed', refitMaximizedBounds)
    if (settingsWindow === window) settingsWindow = null
    settleReadiness('closed')
  })
  const readinessTimer = setTimeout(
    () => settleReadiness('timeout'),
    SETTINGS_WINDOW_READY_TIMEOUT_MS
  )

  try {
    const navigation = loadRenderer(window, 'settings').then(() => readiness)
    const outcome = await Promise.race([readiness, navigation])

    if (outcome === 'ready' && !window.isDestroyed() && settingsWindow === window) {
      logMaterialModeOnce(material)
      window.show()
      return window
    }

    if (outcome === 'timeout') {
      const snapshot = controller.getSnapshot()
      console.warn(
        `[window] Settings readiness timed out (ready-to-show=${snapshot.readyToShow}, renderer-ready=${snapshot.rendererReady}).`
      )
      const shouldRetrySolid = controller.claimFallbackRetry()
      if (settingsWindow === window) settingsWindow = null
      if (!window.isDestroyed()) window.destroy()
      if (shouldRetrySolid) return createSettingsWindowAttempt('solid', false)
      throw new Error('Settings window readiness timed out in solid mode.')
    }

    throw new Error('Settings window closed before startup readiness completed.')
  } catch (error) {
    clearTimeout(readinessTimer)
    if (settingsWindow === window) settingsWindow = null
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
}

function logMaterialModeOnce(material: WindowMaterial): void {
  if (materialModeLogged) return
  materialModeLogged = true
  console.info(`[window] Settings material mode: ${material}.`)
}

type SettingsReadinessOutcome = 'ready' | 'timeout' | 'closed'
