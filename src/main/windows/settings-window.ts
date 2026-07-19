import { BrowserWindow, screen } from 'electron'
import { WINDOW_BACKGROUND_COLOR } from './window-appearance'
import { registerBrowserWindowChrome } from './window-chrome'
import { loadRenderer, secureWindow } from './window-factory'

let settingsWindow: BrowserWindow | null = null

export async function showSettingsWindow(): Promise<BrowserWindow> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }
  settingsWindow = secureWindow({
    width: 650,
    height: 760,
    minWidth: 560,
    minHeight: 640,
    show: false,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    title: 'SnipChat Settings',
    autoHideMenuBar: true
  })
  registerBrowserWindowChrome(settingsWindow, screen, {
    kind: 'settings',
    material: 'solid',
    surfaceSize: { width: 650, height: 760 },
    minimumSurfaceSize: { width: 560, height: 640 },
    fallbackRetryEligible: false
  })
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
  await loadRenderer(settingsWindow, 'settings')
  settingsWindow.show()
  return settingsWindow
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null
}
