import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ConversationSelection, ProviderModelCapability, ProviderProfileSummary } from '@shared/types/app'
import type { ProviderEvent, ProviderStatus, VisionTurnInput } from '@shared/types/provider'
import { createAppError, FoveaError } from '../errors/app-error'
import type { CodexAppServerProvider } from './codex-app-server/codex-app-server-provider'
import { DirectApiProvider } from './direct-api-provider'
import type { ProfileManager } from './profile-manager'

export class ProviderRegistry extends EventEmitter {
  private readonly direct = {
    openai: new DirectApiProvider('openai'),
    anthropic: new DirectApiProvider('anthropic'),
    openrouter: new DirectApiProvider('openrouter')
  }
  private readonly controllers = new Map<string, AbortController>()
  private chatgptStatus: ProviderStatus | null = null
  private statusRefresh: Promise<void> = Promise.resolve()
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
    private readonly chatgpt: CodexAppServerProvider
  ) {
    super()
    this.chatgpt.on('status', this.handleChatGptStatus)
  }

  async initialise(): Promise<void> {
    await this.chatgpt.initialise()
    this.chatgptStatus = await this.chatgpt.getStatus()
    await this.refreshChatGptHealth(this.chatgptStatus)
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
      models = await this.direct[profile.provider].listModels(secret)
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
      yield* this.direct[selection.provider].send(secret, turn, controller.signal)
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
