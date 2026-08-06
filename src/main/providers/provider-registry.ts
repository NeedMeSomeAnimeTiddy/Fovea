import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ChatGptRuntimeStatus, ConversationSelection, ProviderModelCapability, ProviderProfileSummary } from '@shared/types/app'
import type { ProviderEvent, ProviderStatus, VisionTurnInput } from '@shared/types/provider'
import { createAppError, FoveaError } from '../errors/app-error'
import type { CodexAppServerProvider } from './codex-app-server/codex-app-server-provider'
import { DirectApiProvider } from './direct-api-provider'
import type { ProfileManager } from './profile-manager'
import type { StoredProviderProfile } from '../storage/settings-store'
import type { CodexRuntimeManager } from '../runtime/codex-runtime-manager'

export class ProviderRegistry extends EventEmitter {
  private readonly direct = {
    openai: new DirectApiProvider('openai'),
    anthropic: new DirectApiProvider('anthropic'),
    openrouter: new DirectApiProvider('openrouter')
  }
  /**
   * Custom endpoints vary per profile, so their adapter is built from the stored profile rather
   * than shared. Built-in providers keep their single long-lived instance.
   */
  private adapterFor(profile: StoredProviderProfile): DirectApiProvider {
    if (profile.provider === 'chatgpt') throw new Error('ChatGPT profiles do not use a direct API adapter.')
    if (profile.provider !== 'custom') return this.direct[profile.provider]
    if (!profile.baseUrl) throw new Error('This profile has no API address configured.')
    return new DirectApiProvider('custom', undefined, {
      baseUrl: profile.baseUrl,
      ...(profile.modelIds?.length ? { modelIds: profile.modelIds } : {})
    })
  }
  private readonly controllers = new Map<string, AbortController>()
  private chatgptStatus: ProviderStatus | null = null
  private statusRefresh: Promise<void> = Promise.resolve()
  private readonly handleRuntimeStatus = (): void => {
    this.emit('status', structuredClone(this.chatgptStatus))
  }
  private readonly handleChatGptStatus = (status: ProviderStatus): void => {
    this.chatgptStatus = structuredClone(status)
    this.emit('status', structuredClone(status))
    if (status.state === 'starting') return
    this.statusRefresh = this.statusRefresh
      .then(() => this.refreshChatGptHealth(status))
      .catch(() => undefined)
      .then(() => {
        if (JSON.stringify(this.chatgptStatus) === JSON.stringify(status)) {
          this.emit('status', structuredClone(status))
        }
      })
  }

  constructor(
    readonly profiles: ProfileManager,
    private readonly chatgpt: CodexAppServerProvider,
    private readonly chatgptRuntime?: CodexRuntimeManager
  ) {
    super()
    this.chatgpt.on('status', this.handleChatGptStatus)
    this.chatgptRuntime?.on('changed', this.handleRuntimeStatus)
  }

  async initialise(): Promise<void> {
    await this.chatgptRuntime?.initialise()
    if (!this.chatgptRuntime || this.chatgptRuntime.isInstalled()) {
      await this.chatgpt.initialise().catch(() => undefined)
    }
    this.chatgptStatus = await this.chatgpt.getStatus()
    await this.refreshChatGptHealth(this.chatgptStatus)
  }

  getChatGptRuntimeStatus(): ChatGptRuntimeStatus {
    return this.chatgptRuntime?.getStatus() ?? {
      state: 'installed',
      version: 'development',
      architecture: process.arch,
      downloadBytes: 0,
      downloadedBytes: 0,
      installedBytes: 0,
      removable: false
    }
  }

  async installChatGptRuntime(): Promise<ChatGptRuntimeStatus> {
    if (!this.chatgptRuntime) return this.getChatGptRuntimeStatus()
    const status = await this.chatgptRuntime.install()
    await this.chatgpt.initialise()
    this.chatgptStatus = await this.chatgpt.getStatus()
    await this.refreshChatGptHealth(this.chatgptStatus)
    return status
  }

  async removeChatGptRuntime(): Promise<ChatGptRuntimeStatus> {
    if (!this.chatgptRuntime) throw new Error('The ChatGPT runtime is not managed by this build.')
    await this.chatgpt.dispose()
    const status = await this.chatgptRuntime.remove()
    this.chatgptStatus = await this.chatgpt.getStatus()
    await this.refreshChatGptHealth(this.chatgptStatus)
    return status
  }

  listProfiles(): ProviderProfileSummary[] {
    return this.profiles.list().map((profile) => (
      profile.provider === 'chatgpt' && this.chatgptStatus
        ? { ...profile, status: structuredClone(this.chatgptStatus) }
        : profile
    ))
  }

  async authenticate(profileId: string): Promise<void> {
    const profile = this.profiles.require(profileId)
    if (profile.provider !== 'chatgpt') throw new Error('API-key profiles are authenticated when they are created.')
    if (this.chatgptRuntime && !this.chatgptRuntime.isInstalled()) {
      throw new Error('Install the optional ChatGPT runtime before signing in. API-key providers remain available without it.')
    }
    await this.chatgpt.signInWithChatGPT()
    await this.refreshChatGptHealth()
  }

  async signOut(profileId: string): Promise<void> {
    const profile = this.profiles.require(profileId)
    if (profile.provider === 'chatgpt') {
      await this.chatgpt.signOut()
      await this.profiles.setHealth(profileId, 'unavailable', 'Signed out.')
      return
    }
    await this.profiles.signOutApiKey(profileId)
  }

  async delete(profileId: string): Promise<void> {
    const profile = this.profiles.require(profileId)
    if (profile.provider === 'chatgpt') await this.chatgpt.signOut().catch(() => undefined)
    await this.profiles.delete(profileId)
  }

  async test(profileId: string): Promise<ProviderModelCapability[]> {
    try {
      const models = await this.listModels(profileId)
      await this.profiles.setHealth(profileId, 'available')
      return models
    } catch (error) {
      await this.profiles.setHealth(profileId, 'unavailable', safeMessage(error))
      throw error
    }
  }

  async listModels(profileId: string): Promise<ProviderModelCapability[]> {
    const profile = this.profiles.require(profileId)
    let models: ProviderModelCapability[]
    if (profile.provider === 'chatgpt') {
      models = (await this.chatgpt.listModels())
        .filter((model) => model.inputModalities.includes('image'))
        .map((model) => ({ ...model, provider: 'chatgpt' }))
    } else {
      const secret = await this.profiles.getSecret(profile)
      models = await this.adapterFor(profile).listModels(secret)
    }
    if (!models.length) {
      throw new FoveaError(createAppError('no-compatible-models', 'No compatible models', 'This profile does not currently offer an image-capable model.', 'choose-provider'))
    }
    return models
  }

  async validateSelection(selection: ConversationSelection): Promise<ProviderModelCapability> {
    const profile = this.profiles.require(selection.profileId)
    if (profile.provider !== selection.provider) throw new Error('The selected profile and provider do not match.')
    const models = await this.listModels(selection.profileId)
    const model = models.find((candidate) => candidate.id === selection.modelId)
    if (!model) throw new Error('That image-capable model is no longer available for this profile.')
    if (selection.reasoningEffort && !model.supportedReasoningEfforts.includes(selection.reasoningEffort)) {
      throw new Error('That reasoning effort is not supported by the selected model.')
    }
    return model
  }

  async createConversation(selection: ConversationSelection): Promise<string> {
    await this.validateSelection(selection)
    return selection.provider === 'chatgpt'
      ? this.chatgpt.createConversation(selection.modelId)
      : randomUUID()
  }

  async *send(conversationId: string, selection: ConversationSelection, input: Omit<VisionTurnInput, 'modelId' | 'reasoningEffort'>): AsyncIterable<ProviderEvent> {
    await this.validateSelection(selection)
    const turn: VisionTurnInput = { ...input, modelId: selection.modelId, reasoningEffort: selection.reasoningEffort }
    if (selection.provider === 'chatgpt') {
      yield* this.chatgpt.sendMessage(conversationId, turn)
      return
    }
    const profile = this.profiles.require(selection.profileId)
    const secret = await this.profiles.getSecret(profile)
    const controller = new AbortController()
    this.controllers.set(conversationId, controller)
    try {
      yield* this.adapterFor(profile).send(secret, turn, controller.signal)
    } finally {
      this.controllers.delete(conversationId)
    }
  }

  async cancel(conversationId: string, provider: ConversationSelection['provider']): Promise<void> {
    if (provider === 'chatgpt') await this.chatgpt.cancel(conversationId)
    else this.controllers.get(conversationId)?.abort(new Error('Request stopped.'))
  }

  async deleteConversation(conversationId: string, provider: ConversationSelection['provider']): Promise<void> {
    if (provider === 'chatgpt') await this.chatgpt.deleteConversation(conversationId)
    this.controllers.get(conversationId)?.abort()
    this.controllers.delete(conversationId)
  }

  async dispose(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    this.chatgpt.off('status', this.handleChatGptStatus)
    this.chatgptRuntime?.off('changed', this.handleRuntimeStatus)
    await this.statusRefresh
    await this.chatgpt.dispose()
  }

  private async refreshChatGptHealth(currentStatus?: ProviderStatus): Promise<void> {
    const profile = this.profiles.list().find((candidate) => candidate.provider === 'chatgpt')
    if (!profile) return
    const status = currentStatus ?? await this.chatgpt.getStatus()
    await this.profiles.setHealth(
      profile.id,
      status.state === 'ready' && status.account ? 'available' : 'unavailable',
      status.error?.message,
      status.account?.email ?? status.account?.planType ?? undefined
    )
  }
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(?:sk|key)-[\w-]+/gi, '[redacted]').slice(0, 500)
}
