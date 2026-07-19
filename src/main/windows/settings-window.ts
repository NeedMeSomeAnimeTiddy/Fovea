import { BrowserWindow } from 'electron'
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
    backgroundColor: '#111318',
    title: 'SnipChat Settings',
    autoHideMenuBar: true
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
