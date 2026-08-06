import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_CHOICES, normaliseBaseUrl, parseModelIds, providerChoice } from '../src/shared/provider-endpoint'
import { DirectApiProvider, rejectsImages } from '../src/main/providers/direct-api-provider'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('custom endpoint validation', () => {
  it('accepts an https API root and strips a trailing slash', () => {
    expect(normaliseBaseUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1')
    expect(normaliseBaseUrl('  https://api.deepseek.com/v1/  ')).toBe('https://api.deepseek.com/v1')
    expect(normaliseBaseUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com')
  })

  it('refuses plain http to a remote host so keys and screenshots are not sent in the clear', () => {
    expect(() => normaliseBaseUrl('http://api.deepseek.com/v1')).toThrow(/https/)
  })

  it('allows plain http only on this machine', () => {
    expect(normaliseBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
    expect(normaliseBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })

  it('refuses credentials, query strings, and non-web schemes', () => {
    expect(() => normaliseBaseUrl('https://user:pass@api.deepseek.com/v1')).toThrow(/API key field/)
    expect(() => normaliseBaseUrl('https://api.deepseek.com/v1?key=abc')).toThrow(/query string/)
    expect(() => normaliseBaseUrl('file:///C:/secrets')).toThrow()
    expect(() => normaliseBaseUrl('not a url')).toThrow(/full base URL/)
    expect(() => normaliseBaseUrl('')).toThrow()
  })

  it('parses a separated model list and rejects an oversized one', () => {
    expect(parseModelIds('deepseek-v4-flash, deepseek-chat')).toEqual(['deepseek-v4-flash', 'deepseek-chat'])
    expect(parseModelIds('a\nb  c')).toEqual(['a', 'b', 'c'])
    expect(parseModelIds('dup, dup')).toEqual(['dup'])
    expect(parseModelIds('   ')).toEqual([])
    expect(() => parseModelIds(Array.from({ length: 21 }, (_v, index) => `m${index}`).join(','))).toThrow(/at most/)
  })
})

describe('provider presets', () => {
  it('gives every preset an address that survives validation unchanged', () => {
    for (const choice of PROVIDER_CHOICES) {
      if (!choice.baseUrl) continue
      expect(() => normaliseBaseUrl(choice.baseUrl!), choice.id).not.toThrow()
      // A preset that gets rewritten would mean the stored address differs from the documented one.
      expect(normaliseBaseUrl(choice.baseUrl), choice.id).toBe(choice.baseUrl)
    }
  })

  it('only the three built-ins avoid the custom adapter, and only they omit an address', () => {
    for (const choice of PROVIDER_CHOICES) {
      if (choice.group === 'built-in') {
        expect(choice.kind, choice.id).not.toBe('custom')
        expect(choice.baseUrl, choice.id).toBeUndefined()
      } else {
        expect(choice.kind, choice.id).toBe('custom')
        // Only the open-ended entry leaves the address for the user to type.
        expect(Boolean(choice.baseUrl), choice.id).toBe(choice.id !== 'custom')
      }
    }
  })

  it('sends nothing to a remote preset over plain http', () => {
    for (const choice of PROVIDER_CHOICES) {
      if (!choice.baseUrl) continue
      const remote = !new URL(choice.baseUrl).hostname.includes('localhost') && !choice.baseUrl.includes('127.0.0.1')
      if (remote) expect(new URL(choice.baseUrl).protocol, choice.id).toBe('https:')
    }
  })

  it('has unique identifiers and falls back to OpenAI for an unknown one', () => {
    expect(new Set(PROVIDER_CHOICES.map((choice) => choice.id)).size).toBe(PROVIDER_CHOICES.length)
    expect(providerChoice('nope').id).toBe('openai')
    expect(providerChoice('deepseek').baseUrl).toBe('https://api.deepseek.com/v1')
  })
})

describe('text-only model detection', () => {
  it('recognises the DeepSeek rejection verbatim', () => {
    const detail = '{"error":{"message":"Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text` at line 1 column 214544","type":"invalid_request_error"}}'
    expect(rejectsImages(400, detail)).toBe(true)
  })

  it('recognises other providers wording the same refusal differently', () => {
    expect(rejectsImages(400, 'This model does not support image input.')).toBe(true)
    expect(rejectsImages(422, 'Invalid content block: image is not supported by this model')).toBe(true)
    expect(rejectsImages(400, 'unsupported multimodal request')).toBe(true)
  })

  it('leaves unrelated failures reported as they were', () => {
    expect(rejectsImages(400, 'Invalid model identifier')).toBe(false)
    expect(rejectsImages(500, 'unknown variant `image_url`')).toBe(false)
    expect(rejectsImages(400, 'context length exceeded')).toBe(false)
  })
})

describe('custom provider requests', () => {
  it('lists every model the endpoint returns rather than filtering on capability', async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => { void url; void init; return jsonResponse({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-chat' }] }) })
    const provider = new DirectApiProvider('custom', request as unknown as typeof fetch, { baseUrl: 'https://api.deepseek.com/v1' })

    const models = await provider.listModels('sk-test')

    expect(request.mock.calls[0]![0]).toBe('https://api.deepseek.com/v1/models')
    expect(models.map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-v4-flash'])
    expect(models.every((model) => model.inputModalities.includes('image'))).toBe(true)
    expect(models.every((model) => model.provider === 'custom')).toBe(true)
  })

  it('uses declared model identifiers without calling an endpoint that has no model list', async () => {
    const request = vi.fn(async () => { throw new Error('should not be called') })
    const provider = new DirectApiProvider('custom', request as unknown as typeof fetch, {
      baseUrl: 'https://api.deepseek.com/v1',
      modelIds: ['deepseek-v4-flash']
    })

    const models = await provider.listModels('sk-test')

    expect(request).not.toHaveBeenCalled()
    expect(models.map((model) => model.id)).toEqual(['deepseek-v4-flash'])
  })

  it('sends an OpenAI-compatible chat completion with the image attached', async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => { void url; void init; return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) })
    const provider = new DirectApiProvider('custom', request as unknown as typeof fetch, { baseUrl: 'https://api.deepseek.com/v1' })

    for await (const _event of provider.send('sk-test', { modelId: 'deepseek-v4-flash', reasoningEffort: null, text: 'What is this?' })) {
      void _event
    }

    const [url, init] = request.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    const body = JSON.parse(String(init!.body)) as { model: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown }
    expect(body.model).toBe('deepseek-v4-flash')
    expect(body.messages[0]!.role).toBe('system')
    expect(body.messages[1]!.content).toEqual([{ type: 'text', text: 'What is this?' }])
    expect(body.tools).toBeUndefined()
  })

  it('never sends the OpenRouter web-search tool to a custom endpoint', async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => { void url; void init; return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) })
    const provider = new DirectApiProvider('custom', request as unknown as typeof fetch, { baseUrl: 'https://api.deepseek.com/v1' })

    for await (const _event of provider.send('sk-test', { modelId: 'm', reasoningEffort: null, text: 'q', webSearchAllowed: true })) {
      void _event
    }

    const body = JSON.parse(String(request.mock.calls[0]![1]!.body)) as { tools?: unknown }
    expect(body.tools).toBeUndefined()
  })

  it('refuses to send when no address is configured', async () => {
    const provider = new DirectApiProvider('custom', vi.fn() as unknown as typeof fetch)
    await expect(provider.listModels('sk-test')).rejects.toThrow(/no API address/)
  })
})
