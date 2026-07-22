import type { ProviderEvent, ProviderStatus, VisionModel, VisionTurnInput } from '@shared/types/provider'

export interface VisionProvider {
  initialise(): Promise<void>
  getStatus(): Promise<ProviderStatus>
  signInWithChatGPT(): Promise<void>
  signInWithApiKey?(apiKey: string): Promise<void>
  signOut(): Promise<void>
  listModels(): Promise<VisionModel[]>
  createConversation(modelId?: string): Promise<string>
  sendMessage(
    conversationId: string,
    input: VisionTurnInput
  ): AsyncIterable<ProviderEvent>
  cancel(conversationId: string): Promise<void>
  dispose(): Promise<void>
}
