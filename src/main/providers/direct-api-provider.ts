import { readFile } from 'node:fs/promises'
import type { ProviderKind, ProviderModelCapability } from '@shared/types/app'
import type { ProviderEvent, VisionTurnInput } from '@shared/types/provider'
import { parseSse } from './sse'

type DirectKind = Exclude<ProviderKind, 'chatgpt'>
type Fetch = typeof fetch

const ENDPOINTS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  openrouter: 'https://openrouter.ai/api/v1'
} satisfies Record<DirectKind, string>

export class DirectApiProvider {
  constructor(
    readonly kind: DirectKind,
    private readonly request: Fetch = fetch
  ) {}

  async listModels(apiKey: string): Promise<ProviderModelCapability[]> {
    const response = await this.request(`${ENDPOINTS[this.kind]}/models`, { headers: this.headers(apiKey) })
    await requireOk(response)
    const payload = await response.json() as { data?: unknown[] }
    const models = (payload.data ?? []).flatMap((entry) => this.normaliseModel(entry))
    return models.sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  async *send(apiKey: string, input: VisionTurnInput, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const image = input.imagePath ? (await readFile(input.imagePath)).toString('base64') : null
    const response = await this.request(this.sendEndpoint(), {
      method: 'POST',
      headers: { ...this.headers(apiKey), 'content-type': 'application/json' },
      body: JSON.stringify(this.requestBody(input, image)),
      signal
    })
    await requireOk(response)
    yield { type: 'started', turnId: crypto.randomUUID() }
    for await (const event of parseSse(response, signal)) {
      if (event.data === '[DONE]') continue
      let payload: Record<string, unknown>
      try { payload = JSON.parse(event.data) as Record<string, unknown> } catch { continue }
      const delta = this.extractDelta(payload, event.event)
      if (delta) yield { type: 'delta', text: delta }
    }
    yield { type: 'completed' }
  }

  private headers(apiKey: string): Record<string, string> {
    if (this.kind === 'anthropic') return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    if (this.kind === 'openrouter') return { authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://fovea.app', 'X-Title': 'Fovea' }
    return { authorization: `Bearer ${apiKey}` }
  }

  private sendEndpoint(): string {
    if (this.kind === 'openai') return `${ENDPOINTS.openai}/responses`
    if (this.kind === 'anthropic') return `${ENDPOINTS.anthropic}/messages`
    return `${ENDPOINTS.openrouter}/chat/completions`
  }

  private normaliseModel(value: unknown): ProviderModelCapability[] {
    if (!value || typeof value !== 'object') return []
    const item = value as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : ''
    if (!id) return []
    if (this.kind === 'openai') {
      const imageCapable = /^(gpt-5|gpt-4\.1|gpt-4o|o[34])/.test(id)
      if (!imageCapable) return []
      const reasoning = /^(gpt-5|o[34])/.test(id) ? ['low', 'medium', 'high'] : []
      return [{ id, displayName: id, provider: this.kind, inputModalities: ['text', 'image'], supportedReasoningEfforts: reasoning, defaultReasoningEffort: reasoning[0], isDefault: false }]
    }
    if (this.kind === 'anthropic') {
      if (!id.startsWith('claude-')) return []
      return [{ id, displayName: typeof item.display_name === 'string' ? item.display_name : id, provider: this.kind, inputModalities: ['text', 'image'], supportedReasoningEfforts: [], isDefault: false }]
    }
    const architecture = item.architecture as { input_modalities?: unknown } | undefined
    if (!Array.isArray(architecture?.input_modalities) || !architecture.input_modalities.includes('image')) return []
    return [{ id, displayName: typeof item.name === 'string' ? item.name : id, provider: this.kind, inputModalities: ['text', 'image'], supportedReasoningEfforts: [], isDefault: false }]
  }

  private requestBody(input: VisionTurnInput, image: string | null): Record<string, unknown> {
    if (this.kind === 'openai') {
      return {
        model: input.modelId,
        stream: true,
        ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
        input: [{ role: 'user', content: [
          { type: 'input_text', text: input.text },
          ...(image ? [{ type: 'input_image', image_url: `data:image/png;base64,${image}` }] : [])
        ] }]
      }
    }
    const content = [
      ...(image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] : []),
      { type: 'text', text: input.text }
    ]
    if (this.kind === 'anthropic') return { model: input.modelId, max_tokens: 4096, stream: true, messages: [{ role: 'user', content }] }
    return { model: input.modelId, stream: true, messages: [{ role: 'user', content: [
      { type: 'text', text: input.text },
      ...(image ? [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }] : [])
    ] }] }
  }

  private extractDelta(payload: Record<string, unknown>, eventName?: string): string {
    if (this.kind === 'openai') return eventName === 'response.output_text.delta' && typeof payload.delta === 'string' ? payload.delta : ''
    if (this.kind === 'anthropic') {
      const delta = payload.delta as { text?: unknown } | undefined
      return typeof delta?.text === 'string' ? delta.text : ''
    }
    const choices = payload.choices as Array<{ delta?: { content?: unknown } }> | undefined
    return typeof choices?.[0]?.delta?.content === 'string' ? choices[0].delta.content : ''
  }
}

async function requireOk(response: Response): Promise<void> {
  if (response.ok) return
  const detail = (await response.text()).slice(0, 500).replace(/(?:sk|key)-[\w-]+/gi, '[redacted]')
  throw new Error(`Provider request failed (${response.status})${detail ? `: ${detail}` : '.'}`)
}
