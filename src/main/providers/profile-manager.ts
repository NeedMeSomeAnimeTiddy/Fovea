import { randomUUID } from 'node:crypto'
import type { ProviderKind, ProviderProfileSummary } from '@shared/types/app'
import type { CredentialStore } from '../storage/credential-store'
import type { SettingsStore, StoredProviderProfile } from '../storage/settings-store'

export class ProfileManager {
  constructor(
    private readonly settings: SettingsStore,
    private readonly credentials: CredentialStore
  ) {}

  list(): ProviderProfileSummary[] {
    const state = this.settings.get()
    return state.profiles.map((profile) => toSummary(profile, state.defaultProfileId, this.credentials.has(profile.id)))
  }

  require(id: string): StoredProviderProfile {
    const profile = this.settings.get().profiles.find((candidate) => candidate.id === id)
    if (!profile) throw new Error('That provider profile no longer exists.')
    return profile
  }

  async createApiKey(provider: Exclude<ProviderKind, 'chatgpt'>, name: string, apiKey: string): Promise<ProviderProfileSummary> {
    const cleanName = validateName(name)
    const cleanKey = apiKey.trim()
    if (!cleanKey || cleanKey.length > 2_048) throw new Error('Enter a valid API key.')
    const id = randomUUID()
    const profile: StoredProviderProfile = {
      id,
      name: cleanName,
      provider,
      authentication: 'api-key',
      defaultModelId: null,
      defaultReasoningEffort: null,
      health: 'unknown'
    }
    await this.credentials.set(id, cleanKey)
    try {
      const state = this.settings.get()
      await this.settings.update({
        profiles: [...state.profiles, profile],
        defaultProfileId: state.defaultProfileId ?? id
      })
    } catch (error) {
      await this.credentials.delete(id).catch(() => undefined)
      throw error
    }
    return this.list().find((candidate) => candidate.id === id)!
  }

  async createChatGpt(name = 'ChatGPT'): Promise<ProviderProfileSummary> {
    const state = this.settings.get()
    if (state.profiles.some((profile) => profile.provider === 'chatgpt')) {
      throw new Error('Fovea supports one ChatGPT subscription profile at a time.')
    }
    const id = randomUUID()
    const profile: StoredProviderProfile = {
      id,
      name: validateName(name),
      provider: 'chatgpt',
      authentication: 'chatgpt-oauth',
      defaultModelId: null,
      defaultReasoningEffort: null,
      health: 'unknown'
    }
    await this.settings.update({
      profiles: [...state.profiles, profile],
      defaultProfileId: state.defaultProfileId ?? id
    })
    return this.list().find((candidate) => candidate.id === id)!
  }

  async rename(id: string, name: string): Promise<void> {
    await this.patch(id, { name: validateName(name) })
  }

  async setDefault(id: string): Promise<void> {
    this.require(id)
    await this.settings.update({ defaultProfileId: id })
  }

  async setDefaults(id: string, modelId: string | null, reasoningEffort: string | null): Promise<void> {
    if (modelId !== null && (typeof modelId !== 'string' || modelId.length > 200)) throw new Error('Invalid model.')
    if (reasoningEffort !== null && reasoningEffort.length > 50) throw new Error('Invalid reasoning effort.')
    await this.patch(id, { defaultModelId: modelId, defaultReasoningEffort: reasoningEffort })
  }

  async setHealth(id: string, health: 'available' | 'unavailable', healthMessage?: string, accountLabel?: string): Promise<void> {
    await this.patch(id, {
      health,
      healthMessage: healthMessage?.slice(0, 500),
      accountLabel: accountLabel?.slice(0, 200),
      lastHealthCheckAt: new Date().toISOString()
    })
  }

  async delete(id: string): Promise<void> {
    const profile = this.require(id)
    const state = this.settings.get()
    const profiles = state.profiles.filter((candidate) => candidate.id !== id)
    await this.settings.update({
      profiles,
      defaultProfileId: state.defaultProfileId === id ? profiles[0]?.id ?? null : state.defaultProfileId
    })
    if (profile.authentication === 'api-key') await this.credentials.delete(profile.id)
  }

  async signOutApiKey(id: string): Promise<void> {
    const profile = this.require(id)
    if (profile.authentication !== 'api-key') throw new Error('That profile does not use an API key.')
    await this.credentials.delete(id)
    await this.patch(id, { health: 'unknown', healthMessage: undefined, lastHealthCheckAt: undefined })
  }

  async getSecret(profile: StoredProviderProfile): Promise<string> {
    if (profile.authentication !== 'api-key') throw new Error('This profile does not use an API key.')
    return this.credentials.get(profile.id)
  }

  private async patch(id: string, patch: Partial<StoredProviderProfile>): Promise<void> {
    const state = this.settings.get()
    if (!state.profiles.some((profile) => profile.id === id)) throw new Error('That provider profile no longer exists.')
    await this.settings.update({
      profiles: state.profiles.map((profile) => profile.id === id ? { ...profile, ...patch } : profile)
    })
  }
}

function toSummary(profile: StoredProviderProfile, defaultProfileId: string | null, hasCredential: boolean): ProviderProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    authentication: profile.authentication,
    authenticationState: profile.provider === 'chatgpt'
      ? profile.health === 'available' ? 'signed-in' : profile.health === 'unavailable' ? 'error' : 'signed-out'
      : hasCredential ? 'signed-in' : 'signed-out',
    accountLabel: profile.accountLabel,
    defaultModelId: profile.defaultModelId,
    defaultReasoningEffort: profile.defaultReasoningEffort,
    health: profile.health,
    healthMessage: profile.healthMessage,
    lastHealthCheckAt: profile.lastHealthCheckAt,
    isDefault: profile.id === defaultProfileId
  }
}

function validateName(name: string): string {
  const clean = name.trim()
  if (!clean || clean.length > 80) throw new Error('Profile names must be between 1 and 80 characters.')
  return clean
}
