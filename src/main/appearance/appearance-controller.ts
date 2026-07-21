import { BrowserWindow, nativeTheme } from 'electron'
import { IPC } from '@shared/contracts/ipc'
import type { AppearancePreference, AppearanceState } from '@shared/types/app'
import type { SettingsStore } from '../storage/settings-store'
import { resolveWindowBackgroundColor, setWindowBackgroundAppearance } from '../windows/window-appearance'
import { getCreatedWindowMaterial } from '../windows/window-factory'

export class AppearanceController {
  constructor(private readonly settings: SettingsStore) {}

  initialise(): void {
    nativeTheme.themeSource = this.settings.get().appearance
    setWindowBackgroundAppearance(nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    nativeTheme.on('updated', this.broadcast)
  }

  getState(): AppearanceState {
    const preference = this.settings.get().appearance
    return { preference, resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' }
  }

  async setPreference(preference: AppearancePreference): Promise<void> {
    if (!['system', 'dark', 'light'].includes(preference)) throw new Error('Invalid appearance preference.')
    await this.settings.update({ appearance: preference })
    nativeTheme.themeSource = preference
    this.broadcast()
  }

  dispose(): void {
    nativeTheme.off('updated', this.broadcast)
  }

  private readonly broadcast = (): void => {
    const state = this.getState()
    setWindowBackgroundAppearance(state.resolved)
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.setBackgroundColor(resolveWindowBackgroundColor(getCreatedWindowMaterial(window), state.resolved))
      if (!window.webContents.isDestroyed()) window.webContents.send(IPC.appearanceChanged, state)
    }
  }
}
