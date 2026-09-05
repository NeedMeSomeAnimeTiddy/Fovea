import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ProviderKind, ProviderModelCapability } from '@shared/types/app'
import type { ProviderEvent, VisionTurnInput } from '@shared/types/provider'
import { createAppError, FoveaError, redactTechnicalDetails, toAppError } from '../errors/app-error'
import { parseSse } from './sse'

type DirectKind = Exclude<ProviderKind, 'chatgpt'>
type Fetch = typeof fetch

const ENDPOINTS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  // Custom profiles always supply their own base URL; this is never used.
  custom: ''
} satisfies Record<DirectKind, string>

const WEB_SEARCH_REQUEST_INSTRUCTION = `Web search is disabled for this turn. First inspect the screenshot carefully and answer from visible evidence and stable knowledge when you are confident. If you cannot confidently identify a visible object, product, logo, place, artwork, interface, error, or other subject and a focused web search could identify or explain it, do not stop at saying it is unidentifiable. Request approval by responding with exactly <fovea-web-search-request>{"query":"a concise search query based on the visible clues"}</fovea-web-search-request>. Use the same request when current or unfamiliar information is essential and you are not confident. Do not request web access when the screenshot lacks enough clues for a useful search or for ordinary stable facts you already know.`
const WEB_SEARCH_APPROVED_INSTRUCTION = `The user approved web access for this turn. Use web search only if it is necessary to resolve the uncertainty in their question. Prefer authoritative sources and cite them with links. Do not use any other tools.`
const WEB_SEARCH_PREFERRED_INSTRUCTION = `The user explicitly prioritised web search for this turn. Search before answering whenever current sources could improve identification, accuracy, context, or verification. Do not stop at "I don't know" without attempting a focused search from the visible clues. Prefer authoritative sources, cite them with links, and do not use any other tools.`
/**
 * Anthropic stops generating at this many output tokens and reports `stop_reason: "max_tokens"`
 * rather than failing, so the stream watches for that signal to surface the truncation.
 */
const ANTHROPIC_MAX_OUTPUT_TOKENS = 8192
/**
 * OpenAI model identifiers that can never read a screenshot even when they share a vision-capable
 * family prefix: speech, transcription, embeddings, moderation, search-tuned, legacy completion
 * models, image generation, and coding agents.
 */
const OPENAI_NON_VISION_MODEL = /audio|realtime|tts|transcribe|whisper|embedding|moderation|search|instruct|image|codex|davinci|babbage/

type HistoryEntry = NonNullable<VisionTurnInput['history']>[number]

export interface DirectApiOptions {
  /** Overrides the built-in endpoint. Required for the `custom` kind. */
  baseUrl?: string
  /** Model identifiers declared by the user for endpoints without a usable `GET /models`. */
  modelIds?: string[]
}

export class DirectApiProvider {
  constructor(
    readonly kind: DirectKind,
    private readonly request: Fetch = fetch,
    private readonly options: DirectApiOptions = {}
  ) {}

  async listModels(apiKey: string): Promise<ProviderModelCapability[]> {
    // A declared list is authoritative: some endpoints do not implement `GET /models` at all.
    if (this.options.modelIds?.length) {
      return this.options.modelIds.map((id) => this.customModel(id)).sort((a, b) => a.displayName.localeCompare(b.displayName))
    }
    const response = await requestSafely(this.request, `${this.baseUrl()}/models`, { headers: this.headers(apiKey) })
    await requireOk(response, apiKey)
    const payload = await response.json() as { data?: unknown[] }
    const models = (payload.data ?? []).flatMap((entry) => this.normaliseModel(entry))
    return models.sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  async *send(apiKey: string, input: VisionTurnInput, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const images = await Promise.all((input.imagePaths ?? []).map(async (imagePath) => ({
      data: (await readFile(imagePath)).toString('base64'),
      mediaType: imageMediaType(imagePath)
    })))
    const response = await requestSafely(this.request, this.sendEndpoint(), {
      method: 'POST',
      headers: { ...this.headers(apiKey), 'content-type': 'application/json' },
      body: JSON.stringify(this.requestBody(input, images)),
      signal
    })
    await requireOk(response, apiKey)
    yield { type: 'started', turnId: crypto.randomUUID() }
    for await (const event of parseSse(response, signal)) {
      if (event.data === '[DONE]') continue
      let payload: Record<string, unknown>
      try { payload = JSON.parse(event.data) as Record<string, unknown> } catch { continue }
      const failure = streamFailure(payload, event.event)
      if (failure) {
        const detail = redactTechnicalDetails(describeStreamFailure(failure), [apiKey])
        throw new FoveaError(streamFailureAppError(failure, detail))
      }
      const delta = this.extractDelta(payload, event.event)
      if (delta) yield { type: 'delta', text: delta }
      // Checked after the delta so any text carried by the same frame reaches the user before the
      // notice that the answer was cut short.
      const truncation = this.streamTruncation(payload)
      if (truncation) {
        const detail = redactTechnicalDetails(describeStreamFailure(truncation), [apiKey])
        throw new FoveaError(streamFailureAppError(truncation, detail))
      }
    }
    yield { type: 'completed' }
  }

  private baseUrl(): string {
    const configured = this.options.baseUrl ?? ENDPOINTS[this.kind]
    if (!configured) throw new Error('This profile has no API address configured.')
    return configured
  }

  private headers(apiKey: string): Record<string, string> {
    if (this.kind === 'anthropic') return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    if (this.kind === 'openrouter') return { authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://fovea.app', 'X-Title': 'Fovea' }
    return { authorization: `Bearer ${apiKey}` }
  }

  private sendEndpoint(): string {
    const base = this.baseUrl()
    if (this.kind === 'openai') return `${base}/responses`
    if (this.kind === 'anthropic') return `${base}/messages`
    return `${base}/chat/completions`
  }

  /**
   * Fovea cannot inspect an arbitrary endpoint's capabilities, so a custom model is offered on
   * the user's authority. Choosing a text-only model surfaces the endpoint's own error.
   */
  private customModel(id: string): ProviderModelCapability {
    return { id, displayName: id, provider: 'custom', inputModalities: ['text', 'image'], supportedReasoningEfforts: [], isDefault: false }
  }

  private normaliseModel(value: unknown): ProviderModelCapability[] {
    if (!value || typeof value !== 'object') return []
    const item = value as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : ''
    if (!id) return []
    if (this.kind === 'openai') {
      const family = openAiVisionFamily(id)
      if (!family) return []
      const reasoning = family.reasoning ? ['low', 'medium', 'high'] : []
      return [{ id, displayName: id, provider: this.kind, inputModalities: ['text', 'image'], supportedReasoningEfforts: reasoning, defaultReasoningEffort: reasoning[0], isDefault: false }]
    }
    if (this.kind === 'anthropic') {
      if (!id.startsWith('claude-')) return []
      return [{ id, displayName: typeof item.display_name === 'string' ? item.display_name : id, provider: this.kind, inputModalities: ['text', 'image'], supportedReasoningEfforts: [], isDefault: false }]
    }
    if (this.kind === 'custom') return [this.customModel(id)]
    const architecture = item.architecture as { input_modalities?: unknown } | undefined
    if (!Array.isArray(architecture?.input_modalities) || !architecture.input_modalities.includes('image')) return []
    return [{ id, displayName: typeof item.name === 'string' ? item.name : id, provider: this.kind, inputModalities: ['text', 'image'], supportedReasoningEfforts: [], isDefault: false }]
  }

  private requestBody(input: VisionTurnInput, images: Array<{ data: string; mediaType: string }>): Record<string, unknown> {
    const instructions = input.webSearchPreferred
      ? WEB_SEARCH_PREFERRED_INSTRUCTION
      : input.webSearchAllowed ? WEB_SEARCH_APPROVED_INSTRUCTION : WEB_SEARCH_REQUEST_INSTRUCTION
    // These endpoints hold no conversation state, so every earlier exchange travels with the
    // request as real prior messages. Images belong only to the current turn.
    const history = usableHistory(input.history)
    if (this.kind === 'openai') {
      return {
        model: input.modelId,
        stream: true,
        instructions,
        ...(input.webSearchAllowed ? { tools: [{ type: 'web_search' }] } : {}),
        ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
        input: [
          ...history.map((entry) => entry.role === 'user'
            ? { role: 'user', content: [{ type: 'input_text', text: entry.text }] }
            : { role: 'assistant', content: [{ type: 'output_text', text: entry.text }] }),
          { role: 'user', content: [
            { type: 'input_text', text: input.text },
            ...images.map((image) => ({ type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}` }))
          ] }
        ]
      }
    }
    if (this.kind === 'anthropic') {
      const content = [
        ...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })),
        { type: 'text', text: input.text }
      ]
      return {
        model: input.modelId,
        max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
        stream: true,
        system: instructions,
        ...(input.webSearchAllowed ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] } : {}),
        messages: anthropicMessages([
          ...history.map((entry) => ({ role: entry.role, content: [{ type: 'text', text: entry.text }] })),
          { role: 'user', content }
        ])
      }
    }
    // OpenAI-compatible chat completions, shared by OpenRouter and any custom endpoint. The
    // web-search tool is an OpenRouter extension, so a custom endpoint never receives it.
    return {
      model: input.modelId,
      stream: true,
      ...(input.webSearchAllowed && this.kind === 'openrouter' ? { tools: [{ type: 'openrouter:web_search' }] } : {}),
      messages: [
        { role: 'system', content: instructions },
        ...history.map((entry) => ({ role: entry.role, content: entry.text })),
        { role: 'user', content: [
          { type: 'text', text: input.text },
          ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } }))
        ] }
      ]
    }
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

  /**
   * A response that ran out of output tokens ends as a normal stream: Anthropic reports it on the
   * final `message_delta`, chat completions on the last choice. The OpenAI Responses API sends
   * `response.incomplete`, which {@link streamFailure} already catches.
   */
  private streamTruncation(payload: Record<string, unknown>): StreamFailure | null {
    if (this.kind === 'anthropic') {
      if (payload.type !== 'message_delta') return null
      const delta = recordValue(payload.delta)
      return delta?.stop_reason === 'max_tokens'
        ? { signal: 'message_delta', error: undefined, outcome: 'incomplete', reason: 'max_tokens' }
        : null
    }
    if (this.kind === 'openai') return null
    const choices = payload.choices as Array<{ finish_reason?: unknown }> | undefined
    return choices?.[0]?.finish_reason === 'length'
      ? { signal: 'finish_reason', error: undefined, outcome: 'incomplete', reason: 'length' }
      : null
  }
}

function usableHistory(history: VisionTurnInput['history']): HistoryEntry[] {
  return (history ?? []).filter((entry) => entry.text.trim().length > 0)
}

/**
 * Anthropic insists on strictly alternating roles that begin with `user`, so neighbouring entries
 * from the same speaker are folded into one message and anything before the first user turn is
 * dropped.
 */
function anthropicMessages(messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }>): Array<{ role: 'user' | 'assistant'; content: unknown[] }> {
  const merged: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
  for (const message of messages) {
    if (!merged.length && message.role !== 'user') continue
    const previous = merged.at(-1)
    if (previous && previous.role === message.role) previous.content.push(...message.content)
    else merged.push({ role: message.role, content: [...message.content] })
  }
  return merged
}

/**
 * OpenAI keeps releasing vision-capable models under the `gpt-<major>` and `o<n>` families, so
 * the allow-list keys on the family number rather than on an enumerated list of ids: every GPT
 * generation from 4 onwards reads images, as does every o-series reasoning model from o3. Ids
 * whose name marks them as a different modality are refused whatever their family.
 */
export function openAiVisionFamily(id: string): { reasoning: boolean } | null {
  const lower = id.toLocaleLowerCase()
  if (OPENAI_NON_VISION_MODEL.test(lower)) return null
  const gpt = /^gpt-(\d+)/.exec(lower)
  if (gpt) {
    const major = Number(gpt[1])
    return major >= 4 ? { reasoning: major >= 5 } : null
  }
  const reasoning = /^o(\d+)/.exec(lower)
  if (reasoning) return Number(reasoning[1]) >= 3 ? { reasoning: true } : null
  return null
}

function imageMediaType(path: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  const extension = extname(path).toLocaleLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  return 'image/png'
}

async function requireOk(response: Response, apiKey: string): Promise<void> {
  if (response.ok) return
  const detail = redactTechnicalDetails(await response.text(), [apiKey])
  const technicalDetails = `Provider request failed (${response.status})${detail ? `: ${detail}` : '.'}`
  if (response.status === 401 || response.status === 403) {
    throw new FoveaError(createAppError('authentication-required', 'Authentication required', 'Update this provider profile before continuing.', 'authenticate', technicalDetails))
  }
  if (response.status === 408 || response.status === 504) {
    throw new FoveaError(createAppError('timeout', 'Request timed out', 'The provider took too long to respond.', 'retry', technicalDetails))
  }
  if (response.status === 429) {
    throw new FoveaError(createAppError('rate-limited', 'Provider is busy', 'The provider rate limit was reached. Wait a moment, then try again.', 'retry', technicalDetails))
  }
  if (rejectsImages(response.status, detail)) {
    throw new FoveaError(createAppError(
      'no-compatible-models',
      'This model cannot read images',
      'The selected model only accepts text, and Fovea always sends a picture. Choose a vision-capable model for this profile, or add a profile for a provider that offers one.',
      'choose-provider',
      technicalDetails
    ))
  }
  throw new FoveaError(createAppError('provider-unavailable', 'Provider unavailable', 'The selected provider could not complete the operation.', 'open-settings', technicalDetails))
}

interface StreamFailure {
  signal?: string
  error: unknown
  outcome?: 'failed' | 'incomplete' | 'cancelled'
  reason?: string
}

function streamFailure(payload: Record<string, unknown>, eventName?: string): StreamFailure | null {
  const payloadType = typeof payload.type === 'string' ? payload.type : undefined
  const response = recordValue(payload.response)
  const responseStatus = typeof response?.status === 'string' ? response.status : undefined
  const outcome = streamOutcome(eventName, payloadType, responseStatus)
  const signalled = eventName === 'error' || payloadType === 'error' || outcome !== undefined
  const error = response?.error ?? payload.error

  // OpenAI-compatible chat endpoints often return an error object without an SSE event name.
  if (!signalled && !hasImplicitStreamError(error)) return null
  const incompleteDetails = recordValue(response?.incomplete_details)
  const reason = typeof incompleteDetails?.reason === 'string' ? incompleteDetails.reason : undefined
  return {
    signal: eventName ?? payloadType ?? responseStatus,
    error: error ?? response ?? payload,
    ...(outcome ? { outcome } : {}),
    ...(reason ? { reason } : {})
  }
}

function describeStreamFailure(failure: StreamFailure): string {
  const error = recordValue(failure.error)
  const details = error
    ? [error.type, error.code, error.message, failure.reason]
        .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
        .map(String)
    : [typeof failure.error === 'string' ? failure.error : undefined, failure.reason]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
  const uniqueDetails = [...new Set(details)]
  const signal = failure.signal ? ` (${failure.signal})` : ''
  return `Provider stream failed${signal}${uniqueDetails.length ? `: ${uniqueDetails.join(' - ')}` : '.'}`
}

function streamFailureAppError(failure: StreamFailure, technicalDetails: string): ReturnType<typeof toAppError> {
  const error = recordValue(failure.error)
  const classification = [error?.type, error?.code]
    .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
    .join(' ')
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')

  if (/\b(?:authentication|authorization) (?:error|failed|required)\b|\binvalid (?:api|x api) key\b|\bunauthori[sz]ed\b/.test(classification)) {
    return createAppError('authentication-required', 'Authentication required', 'Update this provider profile before continuing.', 'authenticate', technicalDetails)
  }
  if (/\brate limit(?:ed| error| exceeded)?\b|\btoo many requests\b/.test(classification)) {
    return createAppError('rate-limited', 'Provider is busy', 'The provider rate limit was reached. Wait a moment, then try again.', 'retry', technicalDetails)
  }
  if (failure.outcome === 'incomplete') {
    return createAppError('provider-unavailable', 'Provider response incomplete', 'The provider stopped before finishing its response. Try again.', 'retry', technicalDetails)
  }
  if (failure.outcome === 'cancelled') {
    return createAppError('provider-unavailable', 'Provider stopped the response', 'The provider cancelled the response before it finished. Try again.', 'retry', technicalDetails)
  }
  return toAppError(new Error(technicalDetails), 'provider-unavailable')
}

function streamOutcome(...signals: Array<string | undefined>): StreamFailure['outcome'] {
  for (const signal of signals) {
    if (signal === 'response.incomplete' || signal === 'incomplete') return 'incomplete'
    if (signal === 'response.cancelled' || signal === 'cancelled' || signal === 'canceled') return 'cancelled'
    if (signal === 'response.failed' || signal === 'failed') return 'failed'
  }
  return undefined
}

function hasImplicitStreamError(error: unknown): boolean {
  if (typeof error === 'string') return error.trim().length > 0
  if (typeof error === 'boolean') return error
  if (typeof error === 'number') return error !== 0
  return error !== null && typeof error === 'object'
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/**
 * A text-only model rejects the image part rather than the request as a whole, and each provider
 * words it differently — DeepSeek returns a serde error naming the `image_url` variant, others
 * say the model does not support images. Fovea always sends a picture, so this is worth naming
 * precisely instead of reporting a bare 400.
 */
export function rejectsImages(status: number, detail: string): boolean {
  if (![400, 415, 422].includes(status)) return false
  const lower = detail.toLocaleLowerCase()
  if (/image_url|input_image|image content|image block/.test(lower)) return true
  return /\b(?:image|images|vision|multimodal)\b/.test(lower) &&
    /unsupported|not support|unknown|invalid|cannot|unexpected|expected/.test(lower)
}

async function requestSafely(request: Fetch, input: string, init: RequestInit): Promise<Response> {
  try {
    return await request(input, init)
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /aborted|request stopped/i.test(error.message))) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new FoveaError(createAppError('offline', 'You appear to be offline', 'Check the network connection, then try again.', 'retry', detail))
  }
}
