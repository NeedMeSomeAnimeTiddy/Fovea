import type {
  CaptureRecipe,
  RecipeShortcutBindingState,
  ShortcutAction,
  ShortcutBindingState
} from '@shared/types/app'
import { isCompleteAccelerator } from '../../shared/shortcut-accelerator'
import { DEFAULT_SHORTCUTS, type SettingsStore, type ShortcutSettings } from '../storage/settings-store'

export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

type BindingOwner =
  | { key: `fixed:${ShortcutAction}`; label: string; accelerator: string; handler: () => void }
  | { key: `recipe:${string}`; label: string; accelerator: string; handler: () => void }

export class ShortcutManager {
  private paused = false
  private readonly registered = new Map<string, string>()

  constructor(
    private readonly registrar: ShortcutRegistrar,
    private readonly settings: SettingsStore,
    private readonly handlers: Record<ShortcutAction, () => void>,
    private readonly runRecipe: (recipeId: string) => void = () => undefined
  ) {}

  initialise(): ShortcutBindingState[] {
    if (this.paused) return this.getState()
    this.registered.clear()
    for (const owner of this.desiredBindings(this.settings.get().shortcuts, this.settings.get().recipes)) {
      if (this.registeredAccelerator(owner.accelerator)) continue
      if (this.tryRegister(owner)) this.registered.set(owner.key, owner.accelerator)
    }
    return this.getState()
  }

  getState(): ShortcutBindingState[] {
    const configured = this.settings.get().shortcuts
    return (Object.keys(configured) as ShortcutAction[]).map((action) => ({
      action,
      accelerator: configured[action],
      registered: !this.paused && configured[action] !== null && sameAccelerator(this.registered.get(`fixed:${action}`), configured[action]),
      ...(!this.paused && configured[action] && !sameAccelerator(this.registered.get(`fixed:${action}`), configured[action])
        ? { error: this.conflictMessage(configured[action], `fixed:${action}`) }
        : {})
    }))
  }

  getRecipeState(): RecipeShortcutBindingState[] {
    return this.settings.get().recipes.map((recipe) => {
      const key = `recipe:${recipe.id}`
      const registered = recipe.enabled && !this.paused && Boolean(recipe.shortcut) && sameAccelerator(this.registered.get(key), recipe.shortcut)
      const conflictOwner = recipe.shortcut ? this.conflictOwner(recipe.shortcut, key) : undefined
      return {
        recipeId: recipe.id,
        name: recipe.name,
        accelerator: recipe.shortcut,
        registered,
        ...(!this.paused && recipe.enabled && recipe.shortcut && !registered
          ? { error: conflictOwner ? `Shortcut is owned by ${conflictOwner}.` : 'Unavailable or used by another application.', ...(conflictOwner ? { conflictOwner } : {}) }
          : {})
      }
    })
  }

  async set(action: ShortcutAction, accelerator: string | null): Promise<void> {
    const next = normalizeAccelerator(accelerator)
    const current = this.settings.get()
    if (current.shortcuts[action] === next) return
    if (next) this.assertNoConfiguredConflict(next, `fixed:${action}`, current.shortcuts, current.recipes)
    await this.applyAndPersist(
      { ...current.shortcuts, [action]: next },
      current.recipes,
      () => this.settings.update({ shortcuts: { ...current.shortcuts, [action]: next } })
    )
  }

  async setRecipes(recipes: CaptureRecipe[]): Promise<void> {
    const current = this.settings.get()
    this.assertRecipeConfiguration(current.shortcuts, recipes)
    await this.applyAndPersist(current.shortcuts, recipes, () => this.settings.update({ recipes }))
  }

  async reset(): Promise<void> {
    const current = this.settings.get()
    this.assertRecipeConfiguration(DEFAULT_SHORTCUTS, current.recipes)
    await this.applyAndPersist({ ...DEFAULT_SHORTCUTS }, current.recipes, () => this.settings.update({ shortcuts: { ...DEFAULT_SHORTCUTS } }))
  }

  pause(): void {
    if (this.paused) return
    this.unregisterAll()
    this.paused = true
  }

  resume(): ShortcutBindingState[] {
    if (!this.paused) return this.getState()
    this.paused = false
    return this.initialise()
  }

  dispose(): void { this.pause() }

  private async applyAndPersist(
    shortcuts: ShortcutSettings,
    recipes: CaptureRecipe[],
    persist: () => Promise<unknown>
  ): Promise<void> {
    const previous = this.settings.get()
    if (!this.paused) this.rebuild(shortcuts, recipes)
    try {
      await persist()
    } catch (error) {
      if (!this.paused) this.rebuild(previous.shortcuts, previous.recipes, false)
      throw error
    }
  }

  private rebuild(shortcuts: ShortcutSettings, recipes: CaptureRecipe[], failOnUnavailable = true): void {
    const previous = this.settings.get()
    this.unregisterAll()
    try {
      for (const owner of this.desiredBindings(shortcuts, recipes)) {
        if (!this.tryRegister(owner)) {
          if (failOnUnavailable) throw new Error(`The shortcut for ${owner.label} is unavailable, invalid, or used by another application.`)
          continue
        }
        this.registered.set(owner.key, owner.accelerator)
      }
    } catch (error) {
      this.unregisterAll()
      for (const owner of this.desiredBindings(previous.shortcuts, previous.recipes)) {
        if (this.tryRegister(owner)) this.registered.set(owner.key, owner.accelerator)
      }
      throw error
    }
  }

  private desiredBindings(shortcuts: ShortcutSettings, recipes: CaptureRecipe[]): BindingOwner[] {
    const fixed = (Object.entries(shortcuts) as Array<[ShortcutAction, string | null]>).flatMap(([action, accelerator]) => accelerator
      ? [{ key: `fixed:${action}` as const, label: fixedLabel(action), accelerator, handler: this.handlers[action] }]
      : [])
    const dynamic = recipes.flatMap((recipe) => recipe.enabled && recipe.shortcut
      ? [{ key: `recipe:${recipe.id}` as const, label: `recipe “${recipe.name}”`, accelerator: recipe.shortcut, handler: () => this.runRecipe(recipe.id) }]
      : [])
    return [...fixed, ...dynamic]
  }

  private assertRecipeConfiguration(shortcuts: ShortcutSettings, recipes: CaptureRecipe[]): void {
    const seen = new Map<string, string>()
    for (const owner of this.desiredBindings(shortcuts, recipes)) {
      const normalized = owner.accelerator.toLocaleLowerCase()
      const existing = seen.get(normalized)
      if (existing) throw new Error(`That shortcut is already assigned to ${existing}.`)
      seen.set(normalized, owner.label)
    }
  }

  private assertNoConfiguredConflict(accelerator: string, key: string, shortcuts: ShortcutSettings, recipes: CaptureRecipe[]): void {
    const conflict = this.desiredBindings(shortcuts, recipes).find((owner) => owner.key !== key && sameAccelerator(owner.accelerator, accelerator))
    if (conflict) throw new Error(`That shortcut is already assigned to ${conflict.label}.`)
  }

  private conflictMessage(accelerator: string, key: string): string {
    const owner = this.conflictOwner(accelerator, key)
    return owner ? `Shortcut is owned by ${owner}.` : 'Unavailable or used by another application.'
  }

  private conflictOwner(accelerator: string, key: string): string | undefined {
    return this.desiredBindings(this.settings.get().shortcuts, this.settings.get().recipes)
      .find((owner) => owner.key !== key && sameAccelerator(owner.accelerator, accelerator))?.label
  }

  private registeredAccelerator(accelerator: string): boolean {
    return [...this.registered.values()].some((value) => sameAccelerator(value, accelerator))
  }

  private unregisterAll(): void {
    for (const accelerator of new Set(this.registered.values())) this.registrar.unregister(accelerator)
    this.registered.clear()
  }

  private tryRegister(owner: BindingOwner): boolean {
    if (!isCompleteAccelerator(owner.accelerator)) return false
    try { return this.registrar.register(owner.accelerator, owner.handler) }
    catch { return false }
  }
}

function normalizeAccelerator(value: string | null): string | null {
  const accelerator = value?.trim() || null
  if (accelerator && accelerator.length > 100) throw new Error('Shortcut is too long.')
  if (accelerator && !isCompleteAccelerator(accelerator)) throw new Error('Press a non-modifier key as part of the shortcut, such as Ctrl+Shift+S.')
  return accelerator
}

function sameAccelerator(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLocaleLowerCase() === right.toLocaleLowerCase())
}

function fixedLabel(action: ShortcutAction): string {
  return ({ region: 'region capture', display: 'current display', window: 'focused window', 'repeat-last': 'repeat last capture', settings: 'Settings' })[action]
}
