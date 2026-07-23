import { app, Menu, nativeImage, Tray, type Rectangle } from 'electron'
import { join } from 'node:path'
import type { CaptureMode } from '@shared/types/app'
import type { ProviderRegistry } from '../providers/provider-registry'
import type { ShortcutManager } from '../shortcuts/shortcut-manager'
import type { SettingsStore } from '../storage/settings-store'
import { showSettingsWindow } from '../windows/settings-window'

export class TrayController {
  private tray: Tray | null = null
  private paused = false
  constructor(private readonly capture: (mode: CaptureMode) => Promise<void>, private readonly shortcuts: ShortcutManager, private readonly providers: ProviderRegistry, private readonly settings: SettingsStore) {}

  initialise(): void {
    if (this.tray) return
    this.tray = new Tray(this.icon('idle'))
    this.tray.setToolTip('Fovea')
    this.tray.on('click', () => void this.openSettings().catch((error) => console.error('[window] Tray could not open Settings.', error)))
    this.tray.on('right-click', () => { this.refreshMenu(); this.tray?.popUpContextMenu() })
    this.refreshMenu()
  }

  getBounds(): Rectangle | undefined { return this.tray?.getBounds() }
  setBusy(busy: boolean): void { this.tray?.setImage(this.icon(busy ? 'busy' : this.paused ? 'paused' : 'idle')) }
  refreshStatus(): void { this.refreshMenu() }
  dispose(): void { this.tray?.destroy(); this.tray = null }

  private refreshMenu(): void {
    if (!this.tray) return
    const available = this.providers.listProfiles().filter((profile) => profile.health === 'available').length
    const total = this.providers.listProfiles().length
    this.tray.setImage(this.icon(this.paused ? 'paused' : total > 0 && available === 0 ? 'disconnected' : 'idle'))
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Capture region', accelerator: 'Ctrl+Alt+Shift+Space', enabled: !this.paused, click: () => void this.capture('region') },
      { label: 'Capture current display', enabled: !this.paused, click: () => void this.capture('display') },
      { label: 'Capture focused window', enabled: !this.paused, click: () => void this.capture('window') },
      { label: 'Repeat last capture', enabled: !this.paused, click: () => void this.capture('repeat-last') },
      { type: 'separator' },
      { label: this.paused ? 'Resume shortcuts' : 'Pause shortcuts', click: () => { this.paused = !this.paused; if (this.paused) this.shortcuts.pause(); else this.shortcuts.resume(); this.tray?.setImage(this.icon(this.paused ? 'paused' : 'idle')); this.refreshMenu() } },
      { label: `Providers: ${available}/${total} available`, enabled: false },
      { label: 'Launch at login', type: 'checkbox', checked: this.settings.get().launchAtLogin, click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath }); void this.settings.update({ launchAtLogin: item.checked }) } },
      { label: 'Settings', click: () => void this.openSettings().catch((error) => console.error('[window] Tray could not open Settings.', error)) },
      { type: 'separator' },
      { label: 'Quit Fovea', click: () => app.quit() }
    ]))
  }

  private async openSettings(): Promise<void> { await showSettingsWindow(this.tray?.getBounds()) }
  private icon(state: 'idle' | 'busy' | 'paused' | 'disconnected'): Electron.NativeImage { const path = app.isPackaged ? join(process.resourcesPath, 'assets', `tray-${state}-20.png`) : join(app.getAppPath(), 'resources', 'assets', 'generated', `tray-${state}-20.png`); return nativeImage.createFromPath(path) }
}
