import type { ShortcutAction, ShortcutBindingState } from '@shared/types/app'
import { DEFAULT_SHORTCUTS, type SettingsStore } from '../storage/settings-store'

export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export class ShortcutManager {
  private paused = false
  private readonly registered = new Map<ShortcutAction, string>()

  constructor(
    private readonly registrar: ShortcutRegistrar,
    private readonly settings: SettingsStore,
    private readonly handlers: Record<ShortcutAction, () => void>
  ) {}

  initialise(): ShortcutBindingState[] {
    for (const [action, accelerator] of Object.entries(this.settings.get().shortcuts) as Array<[ShortcutAction, string | null]>) {
      if (accelerator && this.registrar.register(accelerator, this.handlers[action])) this.registered.set(action, accelerator)
    }
    return this.getState()
  }

  getState(): ShortcutBindingState[] {
    const configured = this.settings.get().shortcuts
    return (Object.keys(configured) as ShortcutAction[]).map((action) => ({
      action,
      accelerator: configured[action],
      registered: !this.paused && configured[action] !== null && this.registered.get(action) === configured[action],
      ...(!this.paused && configured[action] && this.registered.get(action) !== configured[action] ? { error: 'Unavailable or used by another application.' } : {})
    }))
  }

  async set(action: ShortcutAction, accelerator: string | null): Promise<void> {
    const next = accelerator?.trim() || null
    if (next && next.length > 100) throw new Error('Shortcut is too long.')
    const currentSettings = this.settings.get()
    const duplicate = (Object.entries(currentSettings.shortcuts) as Array<[ShortcutAction, string | null]>).find(([other, value]) => other !== action && value?.toLowerCase() === next?.toLowerCase())
    if (duplicate) throw new Error(`That shortcut is already assigned to ${duplicate[0]}.`)
    const previous = this.registered.get(action) ?? null
    if (previous === next) return
    if (!this.paused && next && !this.registrar.register(next, this.handlers[action])) throw new Error(`The shortcut for ${action} is unavailable.`)
    try {
      await this.settings.update({ shortcuts: { ...currentSettings.shortcuts, [action]: next } })
    } catch (error) {
      if (!this.paused && next) this.registrar.unregister(next)
      throw error
    }
    if (!this.paused && previous) this.registrar.unregister(previous)
    if (next && !this.paused) this.registered.set(action, next)
    else this.registered.delete(action)
  }

  async reset(): Promise<void> {
    for (const action of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) await this.set(action, DEFAULT_SHORTCUTS[action])
  }

  pause(): void {
    if (this.paused) return
    for (const accelerator of this.registered.values()) this.registrar.unregister(accelerator)
    this.registered.clear()
    this.paused = true
  }

  resume(): ShortcutBindingState[] {
    if (!this.paused) return this.getState()
    this.paused = false
    return this.initialise()
  }

  dispose(): void { this.pause() }
}
