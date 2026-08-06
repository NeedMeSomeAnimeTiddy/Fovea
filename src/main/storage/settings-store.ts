import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  AppearancePreference,
  CaptureRecipe,
  CustomPrompt,
  HistorySettings,
  OnboardingStatus,
  ProviderKind,
  ProfileAuthentication,
  ShortcutAction
} from '@shared/types/app'
import { MAX_CUSTOM_MODEL_IDS, normaliseBaseUrl } from '@shared/provider-endpoint'

export interface StoredProviderProfile {
  id: string
  name: string
  provider: ProviderKind
  authentication: ProfileAuthentication
  /** Required for `custom` profiles: the OpenAI-compatible API root. */
  baseUrl?: string
  /** Optional manual model list for endpoints that do not implement `GET /models`. */
  modelIds?: string[]
  accountLabel?: string
  defaultModelId: string | null
  defaultReasoningEffort: string | null
  health: 'unknown' | 'available' | 'unavailable'
  healthMessage?: string
  lastHealthCheckAt?: string
}

export type ShortcutSettings = Record<ShortcutAction, string | null>

export interface AppSettings {
  version: 4
  appearance: AppearancePreference
  onboardingStatus: OnboardingStatus
  launchAtLogin: boolean
  /** Whether the "Analyse with Fovea" entry is registered in the Windows Explorer context menu. */
  shellIntegrationEnabled: boolean
  shortcuts: ShortcutSettings
  profiles: StoredProviderProfile[]
  defaultProfileId: string | null
  customPrompts: CustomPrompt[]
  recipes: CaptureRecipe[]
  history: HistorySettings
  ocrLanguageCode: string
}

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  region: 'CommandOrControl+Alt+Shift+Space',
  display: null,
  window: null,
  'repeat-last': null,
  settings: null
}

const DEFAULTS: AppSettings = {
  version: 4,
  appearance: 'light',
  onboardingStatus: 'pending',
  launchAtLogin: false,
  shellIntegrationEnabled: false,
  shortcuts: { ...DEFAULT_SHORTCUTS },
  profiles: [],
  defaultProfileId: null,
  customPrompts: [],
  recipes: [],
  ocrLanguageCode: '',
  history: {
    privateMode: false,
    retentionDays: 30,
    retainScreenshots: false
  }
}

const APPEARANCES = new Set<AppearancePreference>(['system', 'dark', 'light'])
const ONBOARDING_STATUSES = new Set<OnboardingStatus>(['pending', 'skipped', 'completed'])
const SHORTCUT_ACTIONS: ShortcutAction[] = ['region', 'display', 'window', 'repeat-last', 'settings']
const CAPTURE_MODES = new Set(['region', 'display', 'window', 'repeat-last'])

type StoredSettingsInput = Partial<AppSettings> & { onboardingCompleted?: unknown }

export class SettingsStore {
  private value: AppSettings = clone(DEFAULTS)

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as StoredSettingsInput
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

function sanitize(value: StoredSettingsInput): AppSettings {
  const shortcuts = { ...DEFAULT_SHORTCUTS }
  if (value.shortcuts && typeof value.shortcuts === 'object') {
    for (const action of SHORTCUT_ACTIONS) {
      const candidate = value.shortcuts[action]
      shortcuts[action] = typeof candidate === 'string' && candidate.length <= 100 ? candidate : null
    }
  }
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.filter(isStoredProfile).map(sanitizeProfile)
    : []
  const defaultProfileId =
    typeof value.defaultProfileId === 'string' && profiles.some((profile) => profile.id === value.defaultProfileId)
      ? value.defaultProfileId
      : profiles[0]?.id ?? null
  const customPrompts = Array.isArray(value.customPrompts)
    ? value.customPrompts
        .filter(isStoredCustomPrompt)
        .filter((prompt, index, prompts) => prompts.findIndex((item) => item.id === prompt.id) === index)
        .slice(0, 20)
        .map((prompt) => ({
          id: prompt.id,
          label: prompt.label.trim(),
          prompt: prompt.prompt.trim()
        }))
    : []
  const recipes = Array.isArray(value.recipes)
    ? value.recipes
        .filter(isStoredRecipe)
        .filter((recipe, index, items) => items.findIndex((item) => item.id === recipe.id) === index)
        .slice(0, 50)
        .map(sanitizeRecipe)
    : []
  return {
    version: 4,
    appearance: APPEARANCES.has(value.appearance as AppearancePreference)
      ? (value.appearance as AppearancePreference)
      : 'light',
    onboardingStatus: ONBOARDING_STATUSES.has(value.onboardingStatus as OnboardingStatus)
      ? (value.onboardingStatus as OnboardingStatus)
      : value.onboardingCompleted === true
        ? 'completed'
        : 'pending',
    launchAtLogin: value.launchAtLogin === true,
    shellIntegrationEnabled: value.shellIntegrationEnabled === true,
    shortcuts,
    profiles,
    defaultProfileId,
    customPrompts,
    recipes,
    history: sanitizeHistorySettings(value.history),
    ocrLanguageCode: typeof value.ocrLanguageCode === 'string' && /^(?:|[A-Za-z0-9-]{2,35})$/.test(value.ocrLanguageCode)
      ? value.ocrLanguageCode
      : ''
  }
}

function isStoredRecipe(value: unknown): value is CaptureRecipe {
  if (!value || typeof value !== 'object') return false
  const recipe = value as Partial<CaptureRecipe>
  if (
    typeof recipe.id !== 'string' || recipe.id.length < 1 || recipe.id.length > 100 ||
    typeof recipe.name !== 'string' || recipe.name.trim().length < 1 || recipe.name.length > 80 ||
    !CAPTURE_MODES.has(String(recipe.captureMode)) ||
    typeof recipe.prompt !== 'string' || recipe.prompt.trim().length < 1 || recipe.prompt.length > 10_000 ||
    !recipe.provider || typeof recipe.provider !== 'object'
  ) return false
  if (recipe.provider.mode === 'current-default') return true
  return recipe.provider.mode === 'fixed' && isConversationSelection(recipe.provider.selection)
}

function sanitizeRecipe(recipe: CaptureRecipe): CaptureRecipe {
  const shortcut = typeof recipe.shortcut === 'string' && recipe.shortcut.trim().length <= 100
    ? recipe.shortcut.trim()
    : null
  const extractText = recipe.extractText === true
  const ocrLanguageCode = extractText && typeof recipe.ocrLanguageCode === 'string' && /^[A-Za-z0-9-]{2,35}$/.test(recipe.ocrLanguageCode)
    ? recipe.ocrLanguageCode
    : undefined
  return {
    id: recipe.id,
    name: recipe.name.trim(),
    enabled: recipe.enabled === true,
    captureMode: recipe.captureMode,
    prompt: recipe.prompt.trim(),
    preferWebSearch: recipe.preferWebSearch === true,
    extractText,
    ...(ocrLanguageCode ? { ocrLanguageCode } : {}),
    provider: structuredClone(recipe.provider),
    shortcut,
    autoSend: recipe.autoSend === true && recipe.autoSendConsentVersion === 1,
    autoSendConsentVersion: recipe.autoSend === true && recipe.autoSendConsentVersion === 1 ? 1 : 0
  }
}

function isConversationSelection(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const selection = value as { profileId?: unknown; provider?: unknown; modelId?: unknown; reasoningEffort?: unknown }
  return Boolean(
    typeof selection.profileId === 'string' && selection.profileId.length > 0 && selection.profileId.length <= 100 &&
    ['chatgpt', 'openai', 'anthropic', 'openrouter'].includes(String(selection.provider)) &&
    typeof selection.modelId === 'string' && selection.modelId.length > 0 && selection.modelId.length <= 200 &&
    (selection.reasoningEffort === null || typeof selection.reasoningEffort === 'string')
  )
}

function sanitizeHistorySettings(value: unknown): HistorySettings {
  if (!value || typeof value !== 'object') return clone(DEFAULTS.history)
  const candidate = value as Partial<HistorySettings>
  const retentionDays = typeof candidate.retentionDays === 'number' && Number.isInteger(candidate.retentionDays)
    ? Math.min(3650, Math.max(1, candidate.retentionDays))
    : DEFAULTS.history.retentionDays
  return {
    privateMode: candidate.privateMode === true,
    retentionDays,
    retainScreenshots: candidate.retainScreenshots === true
  }
}

function isStoredCustomPrompt(value: unknown): value is CustomPrompt {
  if (!value || typeof value !== 'object') return false
  const prompt = value as Partial<CustomPrompt>
  return Boolean(
    typeof prompt.id === 'string' &&
    prompt.id.length > 0 &&
    prompt.id.length <= 100 &&
    typeof prompt.label === 'string' &&
    prompt.label.trim().length > 0 &&
    prompt.label.length <= 80 &&
    typeof prompt.prompt === 'string' &&
    prompt.prompt.trim().length > 0 &&
    prompt.prompt.length <= 2_000
  )
}

function isStoredProfile(value: unknown): value is StoredProviderProfile {
  if (!value || typeof value !== 'object') return false
  const profile = value as Partial<StoredProviderProfile>
  if (!(
    typeof profile.id === 'string' &&
    profile.id.length <= 100 &&
    typeof profile.name === 'string' &&
    profile.name.length > 0 &&
    ['chatgpt', 'openai', 'anthropic', 'openrouter', 'custom'].includes(String(profile.provider)) &&
    ['chatgpt-oauth', 'api-key'].includes(String(profile.authentication))
  )) return false
  // A custom profile without a usable endpoint could never be reached, so it is dropped rather
  // than kept in a state the rest of the app has to keep re-checking.
  if (profile.provider === 'custom') {
    if (typeof profile.baseUrl !== 'string') return false
    try { normaliseBaseUrl(profile.baseUrl) } catch { return false }
  }
  return true
}

function sanitizeProfile(profile: StoredProviderProfile): StoredProviderProfile {
  const clean: StoredProviderProfile = { ...profile }
  if (clean.provider === 'custom' && clean.baseUrl) clean.baseUrl = normaliseBaseUrl(clean.baseUrl)
  else delete clean.baseUrl
  const modelIds = Array.isArray(clean.modelIds)
    ? [...new Set(clean.modelIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 200))]
        .slice(0, MAX_CUSTOM_MODEL_IDS)
    : []
  if (clean.provider === 'custom' && modelIds.length) clean.modelIds = modelIds
  else delete clean.modelIds
  return clean
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
