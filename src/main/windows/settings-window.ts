import { app, screen, type BrowserWindow } from 'electron'
import type { WindowMaterial } from '@shared/contracts/ipc'
import {
  getWindowAppearanceOptions,
  selectWindowMaterial,
  type WindowSurfaceSizes
} from './window-appearance'
import {
  openBrowserWindowWithChrome,
  WINDOW_CHROME_READY_TIMEOUT_MS
} from './window-chrome'
import { loadRenderer, secureWindow } from './window-factory'

const SETTINGS_WINDOW_SIZES: WindowSurfaceSizes = {
  surfaceSize: { width: 650, height: 760 },
  minimumSurfaceSize: { width: 560, height: 640 }
}

export const SETTINGS_WINDOW_READY_TIMEOUT_MS = WINDOW_CHROME_READY_TIMEOUT_MS

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
  const opening = openBrowserWindowWithChrome({
    kind: 'settings',
    label: 'Settings',
    initialMaterial: material,
    surfaceSize: SETTINGS_WINDOW_SIZES.surfaceSize,
    minimumSurfaceSize: SETTINGS_WINDOW_SIZES.minimumSurfaceSize,
    screenSource: screen,
    timeoutMs: SETTINGS_WINDOW_READY_TIMEOUT_MS,
    createWindow: createSettingsBrowserWindow,
    loadRenderer: (window) => loadRenderer(window, 'settings'),
    isWindowCurrent: (window) => settingsWindow === window
  }).then((opened) => {
    logMaterialModeOnce(opened.material)
    return opened.window
  })
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

function createSettingsBrowserWindow(material: WindowMaterial): BrowserWindow {
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

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.once('closed', () => {
    if (settingsWindow === window) settingsWindow = null
  })
  return window
}

function logMaterialModeOnce(material: WindowMaterial): void {
  if (materialModeLogged) return
  materialModeLogged = true
  console.info(`[window] Settings material mode: ${material}.`)
}
