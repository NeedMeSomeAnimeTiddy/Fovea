import type { ProviderKind } from './types/app'

/**
 * Validation for user-supplied OpenAI-compatible endpoints. Shared so the renderer can warn
 * before submitting and the main process can enforce the same rule at the boundary.
 */
export const MAX_BASE_URL_LENGTH = 300
export const MAX_CUSTOM_MODEL_IDS = 20

export function normaliseBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_BASE_URL_LENGTH) throw new Error('Enter the base URL of an OpenAI-compatible API.')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Enter a full base URL, for example https://api.deepseek.com/v1.')
  }
  if (url.username || url.password) throw new Error('Put credentials in the API key field, not in the URL.')
  if (url.search || url.hash) throw new Error('The base URL cannot contain a query string or fragment.')
  // Screenshots and the API key travel to this host, so plaintext is only allowed on this machine.
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    throw new Error('Use an https:// address. Plain http is only allowed for localhost.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https addresses are supported.')
  // Endpoints are joined as `${baseUrl}/models`, so a trailing slash would double up.
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function isLoopback(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

export type ProviderChoiceGroup = 'built-in' | 'compatible' | 'local'

export interface ProviderChoice {
  /** Identifies the choice in the picker. Not persisted; profiles store the kind and address. */
  id: string
  label: string
  group: ProviderChoiceGroup
  kind: Exclude<ProviderKind, 'chatgpt'>
  /** Prefilled address for a compatible provider. Absent for built-ins and a blank custom entry. */
  baseUrl?: string
  /** Default profile name. */
  name: string
}

/**
 * Addresses taken from each provider's own OpenAI-compatibility documentation. Everything below
 * `built-in` is stored as a `custom` profile: the picker only prefills the address, so the user
 * can still correct it and nothing here is baked into how requests are made.
 *
 * Fovea needs a vision model, and not every provider listed serves one — the model picker shows
 * whatever the endpoint reports, so the choice remains the user's.
 */
export const PROVIDER_CHOICES: ProviderChoice[] = [
  { id: 'openai', label: 'OpenAI API', group: 'built-in', kind: 'openai', name: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic', group: 'built-in', kind: 'anthropic', name: 'Anthropic' },
  { id: 'openrouter', label: 'OpenRouter', group: 'built-in', kind: 'openrouter', name: 'OpenRouter' },
  { id: 'deepseek', label: 'DeepSeek', group: 'compatible', kind: 'custom', baseUrl: 'https://api.deepseek.com/v1', name: 'DeepSeek' },
  { id: 'gemini', label: 'Google Gemini', group: 'compatible', kind: 'custom', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', name: 'Gemini' },
  { id: 'xai', label: 'xAI (Grok)', group: 'compatible', kind: 'custom', baseUrl: 'https://api.x.ai/v1', name: 'xAI' },
  { id: 'mistral', label: 'Mistral', group: 'compatible', kind: 'custom', baseUrl: 'https://api.mistral.ai/v1', name: 'Mistral' },
  { id: 'groq', label: 'Groq', group: 'compatible', kind: 'custom', baseUrl: 'https://api.groq.com/openai/v1', name: 'Groq' },
  { id: 'together', label: 'Together AI', group: 'compatible', kind: 'custom', baseUrl: 'https://api.together.ai/v1', name: 'Together AI' },
  { id: 'fireworks', label: 'Fireworks AI', group: 'compatible', kind: 'custom', baseUrl: 'https://api.fireworks.ai/inference/v1', name: 'Fireworks AI' },
  { id: 'deepinfra', label: 'DeepInfra', group: 'compatible', kind: 'custom', baseUrl: 'https://api.deepinfra.com/v1/openai', name: 'DeepInfra' },
  { id: 'cerebras', label: 'Cerebras', group: 'compatible', kind: 'custom', baseUrl: 'https://api.cerebras.ai/v1', name: 'Cerebras' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', group: 'compatible', kind: 'custom', baseUrl: 'https://api.moonshot.ai/v1', name: 'Moonshot' },
  { id: 'zai', label: 'Z.AI (GLM)', group: 'compatible', kind: 'custom', baseUrl: 'https://api.z.ai/api/paas/v4', name: 'Z.AI' },
  { id: 'qwen', label: 'Alibaba (Qwen)', group: 'compatible', kind: 'custom', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', name: 'Qwen' },
  { id: 'ollama', label: 'Ollama', group: 'local', kind: 'custom', baseUrl: 'http://localhost:11434/v1', name: 'Ollama' },
  { id: 'lmstudio', label: 'LM Studio', group: 'local', kind: 'custom', baseUrl: 'http://localhost:1234/v1', name: 'LM Studio' },
  { id: 'vllm', label: 'vLLM', group: 'local', kind: 'custom', baseUrl: 'http://localhost:8000/v1', name: 'vLLM' },
  { id: 'custom', label: 'Other (OpenAI-compatible)', group: 'compatible', kind: 'custom', name: 'Custom provider' }
]

export const PROVIDER_CHOICE_GROUP_LABELS: Record<ProviderChoiceGroup, string> = {
  'built-in': 'Built in',
  compatible: 'OpenAI-compatible',
  local: 'On this computer'
}

export function providerChoice(id: string): ProviderChoice {
  return PROVIDER_CHOICES.find((choice) => choice.id === id) ?? PROVIDER_CHOICES[0]!
}

/** Accepts a comma-, space-, or newline-separated list of model identifiers. */
export function parseModelIds(value: string): string[] {
  const ids = value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  const unique = [...new Set(ids)]
  if (unique.length > MAX_CUSTOM_MODEL_IDS) throw new Error(`Enter at most ${MAX_CUSTOM_MODEL_IDS} model identifiers.`)
  if (unique.some((id) => id.length > 200)) throw new Error('Model identifiers must be 200 characters or fewer.')
  return unique
}
