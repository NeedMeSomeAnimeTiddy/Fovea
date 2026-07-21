import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  AppearancePreference,
  ProviderKind,
  ProfileAuthentication,
  ShortcutAction
} from '@shared/types/app'

export interface StoredProviderProfile {
  id: string
  name: string
  provider: ProviderKind
  authentication: ProfileAuthentication
  accountLabel?: string
  defaultModelId: string | null
  defaultReasoningEffort: string | null
  health: 'unknown' | 'available' | 'unavailable'
  healthMessage?: string
  lastHealthCheckAt?: string
}

export type ShortcutSettings = Record<ShortcutAction, string | null>

export interface AppSettings {
  version: 2
  appearance: AppearancePreference
  onboardingCompleted: boolean
  launchAtLogin: boolean
  shortcuts: ShortcutSettings
  profiles: StoredProviderProfile[]
  defaultProfileId: string | null
}

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  region: 'CommandOrControl+Alt+Shift+Space',
  display: null,
  window: null,
  'repeat-last': null,
  settings: null
}

const DEFAULTS: AppSettings = {
  version: 2,
  appearance: 'light',
  onboardingCompleted: false,
  launchAtLogin: false,
  shortcuts: { ...DEFAULT_SHORTCUTS },
  profiles: [],
  defaultProfileId: null
}

const APPEARANCES = new Set<AppearancePreference>(['system', 'dark', 'light'])
const SHORTCUT_ACTIONS: ShortcutAction[] = ['region', 'display', 'window', 'repeat-last', 'settings']

export class SettingsStore {
  private value: AppSettings = clone(DEFAULTS)

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<AppSettings>
      this.value = sanitize(parsed)
    } catch {
      this.value = clone(DEFAULTS)
    }
  }

  get(): AppSettings {
    return clone(this.value)
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const previous = this.value
    this.value = sanitize({ ...this.value, ...patch })
    try {
      await this.persist()
    } catch (error) {
      this.value = previous
      throw error
    }
    return this.get()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(this.value, null, 2), 'utf8')
    await rename(temporary, this.path)
  }
}

function sanitize(value: Partial<AppSettings>): AppSettings {
  const shortcuts = { ...DEFAULT_SHORTCUTS }
  if (value.shortcuts && typeof value.shortcuts === 'object') {
    for (const action of SHORTCUT_ACTIONS) {
      const candidate = value.shortcuts[action]
      shortcuts[action] = typeof candidate === 'string' && candidate.length <= 100 ? candidate : null
    }
  }
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.filter(isStoredProfile).map((profile) => ({ ...profile }))
    : []
  const defaultProfileId =
    typeof value.defaultProfileId === 'string' && profiles.some((profile) => profile.id === value.defaultProfileId)
      ? value.defaultProfileId
      : profiles[0]?.id ?? null
  return {
    version: 2,
    appearance: APPEARANCES.has(value.appearance as AppearancePreference)
      ? (value.appearance as AppearancePreference)
      : 'light',
    onboardingCompleted: value.onboardingCompleted === true,
    launchAtLogin: value.launchAtLogin === true,
    shortcuts,
    profiles,
    defaultProfileId
  }
}

function isStoredProfile(value: unknown): value is StoredProviderProfile {
  if (!value || typeof value !== 'object') return false
  const profile = value as Partial<StoredProviderProfile>
  return Boolean(
    typeof profile.id === 'string' &&
    profile.id.length <= 100 &&
    typeof profile.name === 'string' &&
    profile.name.length > 0 &&
    ['chatgpt', 'openai', 'anthropic', 'openrouter'].includes(String(profile.provider)) &&
    ['chatgpt-oauth', 'api-key'].includes(String(profile.authentication))
  )
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
