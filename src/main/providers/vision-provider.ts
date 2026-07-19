import type { ProviderEvent, ProviderStatus, VisionModel } from '@shared/types/provider'

export interface VisionProvider {
  initialise(): Promise<void>
  getStatus(): Promise<ProviderStatus>
  signInWithChatGPT(): Promise<void>
  signInWithApiKey?(apiKey: string): Promise<void>
  signOut(): Promise<void>
  listModels(): Promise<VisionModel[]>
  createConversation(): Promise<string>
  sendMessage(
    conversationId: string,
    input: { text: string; imagePath?: string }
  ): AsyncIterable<ProviderEvent>
  cancel(conversationId: string): Promise<void>
  dispose(): Promise<void>
}
