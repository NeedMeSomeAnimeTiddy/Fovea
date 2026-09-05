import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { WindowMaterial } from '@shared/contracts/ipc'

const preload = join(__dirname, '../preload/index.js')
const rendererDirectory = {
  settings: 'settings',
  overlay: 'capture-overlay',
  question: 'question-window',
  preview: 'image-preview',
  'document-render': 'document-render'
} as const
const windowMaterials = new WeakMap<BrowserWindow, WindowMaterial>()

export interface SecureWindowOptions {
  /**
   * Whether the `window.fovea` preload bridge is attached. A page that is driven purely from the
   * main process (the hidden PDF renderer) has no use for it, and omitting it keeps the whole IPC
   * surface out of reach should that page ever be compromised. Defaults to true.
   */
  preload?: boolean
}

export function secureWindow(options: BrowserWindowConstructorOptions, { preload: withPreload = true }: SecureWindowOptions = {}): BrowserWindow {
  const window = new BrowserWindow({
    ...options,
    webPreferences: {
      ...(withPreload ? { preload } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // `process.env.NODE_ENV` is not substituted in the main bundle, so it cannot tell a packaged
      // build apart from a development run; `app.isPackaged` can.
      devTools: !app.isPackaged,
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
  page: 'settings' | 'overlay' | 'question' | 'preview' | 'document-render',
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
