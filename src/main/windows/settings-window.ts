import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
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
  surfaceSize: { width: 600, height: 640 },
  minimumSurfaceSize: { width: 600, height: 640 }
}

export const SETTINGS_WINDOW_READY_TIMEOUT_MS = WINDOW_CHROME_READY_TIMEOUT_MS

let settingsWindow: BrowserWindow | null = null
let settingsWindowOpening: Promise<BrowserWindow> | null = null
let materialModeLogged = false

export async function showSettingsWindow(trayBounds?: Rectangle): Promise<BrowserWindow> {
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
    canMinimize: false,
    canMaximize: false,
    canResize: false,
    createWindow: (attempt) => createSettingsBrowserWindow(attempt, trayBounds),
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

function createSettingsBrowserWindow(material: WindowMaterial, trayBounds?: Rectangle): BrowserWindow {
  const appearance = getWindowAppearanceOptions(
    SETTINGS_WINDOW_SIZES,
    material,
    screen.getPrimaryDisplay().workArea
  )
  const placement = trayBounds ? placeBesideTray(trayBounds, appearance.size) : null
  const window = secureWindow({
    ...(placement ?? {}),
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
    resizable: false,
    maximizable: false,
    minimizable: false,
    closable: appearance.closable,
    movable: appearance.movable,
    fullscreenable: appearance.fullscreenable,
    thickFrame: false,
    roundedCorners: appearance.roundedCorners,
    skipTaskbar: true,
    title: 'Fovea Settings',
    autoHideMenuBar: true
  })
  settingsWindow = window

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.on('blur', () => {
    if (settingsWindow === window && !window.isDestroyed()) window.hide()
  })
  window.once('closed', () => {
    if (settingsWindow === window) settingsWindow = null
  })
  return window
}

export function placeBesideTray(tray: Rectangle, size: { width: number; height: number }): { x: number; y: number } {
  const workArea = screen.getDisplayNearestPoint({ x: tray.x + tray.width / 2, y: tray.y + tray.height / 2 }).workArea
  const distances = { left: Math.abs(tray.x - workArea.x), right: Math.abs(workArea.x + workArea.width - (tray.x + tray.width)), top: Math.abs(tray.y - workArea.y), bottom: Math.abs(workArea.y + workArea.height - (tray.y + tray.height)) }
  const edge = (Object.entries(distances).sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'bottom') as keyof typeof distances
  let x = tray.x + tray.width - size.width; let y = tray.y - size.height - 8
  if (edge === 'top') y = tray.y + tray.height + 8
  if (edge === 'left') { x = tray.x + tray.width + 8; y = tray.y + tray.height - size.height }
  if (edge === 'right') { x = tray.x - size.width - 8; y = tray.y + tray.height - size.height }
  return { x: Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width))), y: Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size.height))) }
}

function logMaterialModeOnce(material: WindowMaterial): void {
  if (materialModeLogged) return
  materialModeLogged = true
  console.info(`[window] Settings material mode: ${material}.`)
}
