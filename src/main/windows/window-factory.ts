import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { WindowMaterial } from '@shared/contracts/ipc'

const preload = join(__dirname, '../preload/index.js')
const rendererDirectory = {
  settings: 'settings',
  overlay: 'capture-overlay',
  question: 'question-window'
} as const
const windowMaterials = new WeakMap<BrowserWindow, WindowMaterial>()

export function secureWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
  const window = new BrowserWindow({
    ...options,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !process.env.NODE_ENV || process.env.NODE_ENV === 'development',
      ...options.webPreferences
    }
  })
  windowMaterials.set(window, options.transparent === true ? 'transparent' : 'solid')
  return window
}

export function getCreatedWindowMaterial(window: BrowserWindow): WindowMaterial {
  return windowMaterials.get(window) ?? 'solid'
}

export async function loadRenderer(
  window: BrowserWindow,
  page: 'settings' | 'overlay' | 'question',
  query: Record<string, string> = {}
): Promise<void> {
  const directory = rendererDirectory[page]
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) {
    const url = new URL(`${devServer.replace(/\/$/, '')}/${directory}/index.html`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    await window.loadURL(url.toString())
  } else {
    await window.loadFile(join(__dirname, `../renderer/${directory}/index.html`), { query })
  }
}
