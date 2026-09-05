import { describe, expect, it, vi } from 'vitest'
import { FoveaError, redactTechnicalDetails } from '../src/main/errors/app-error'
import { DirectApiProvider } from '../src/main/providers/direct-api-provider'
import type { ProviderEvent } from '../src/shared/types/provider'

const API_KEY = 'opaque-provider-secret.123+/='

function streamResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function captureStreamFailure(provider: DirectApiProvider): Promise<{ error: FoveaError; events: ProviderEvent[] }> {
  const events: ProviderEvent[] = []
  try {
    for await (const event of provider.send(API_KEY, { modelId: 'vision-model', reasoningEffort: null, text: 'What is this?' })) {
      events.push(event)
    }
  } catch (error) {
    expect(error).toBeInstanceOf(FoveaError)
    return { error: error as FoveaError, events }
  }
  throw new Error('Expected the provider stream to fail.')
}

describe('provider diagnostic redaction', () => {
  it('redacts standard authentication fields and the exact configured credential', () => {
    const raw = [
      `Authorization: Bearer ${API_KEY}`,
      '"api_key":"another-secret"',
      'x-api-key = header-secret',
      'Credential echoed as opaque-provider-secret.123+/='
    ].join('\n')

    const safe = redactTechnicalDetails(raw, [API_KEY])

    expect(safe).not.toContain(API_KEY)
    expect(safe).not.toContain('another-secret')
    expect(safe).not.toContain('header-secret')
    expect(safe).toContain('Credential echoed as [REDACTED_API_KEY]')
  })

  it('keeps useful HTTP failure context without exposing a reflected custom key', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: `The credential ${API_KEY} was rejected; Authorization: Bearer ${API_KEY}`
      }
    }), { status: 400 }))
    const provider = new DirectApiProvider('custom', request as unknown as typeof fetch, {
      baseUrl: 'https://provider.example/v1'
    })

    const error = await provider.listModels(API_KEY).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(FoveaError)
    const details = (error as FoveaError).appError.technicalDetails ?? ''
    expect(details).toContain('Provider request failed (400)')
    expect(details).toContain('invalid_request_error')
    expect(details).not.toContain(API_KEY)
  })
})

describe('provider stream failures', () => {
  it.each([null, false, '', 0])('does not mistake a %j compatible-provider error sentinel for a failure', async (error) => {
    const body = `data: ${JSON.stringify({ error, choices: [{ delta: { content: 'Answer' } }] })}\n\ndata: [DONE]\n\n`
    const provider = new DirectApiProvider('custom', vi.fn(async () => streamResponse(body)) as unknown as typeof fetch, {
      baseUrl: 'https://provider.example/v1'
    })
    const events: ProviderEvent[] = []

    for await (const event of provider.send(API_KEY, { modelId: 'vision-model', reasoningEffort: null, text: 'Question' })) {
      events.push(event)
    }

    expect(events).toContainEqual({ type: 'delta', text: 'Answer' })
    expect(events.at(-1)).toMatchObject({ type: 'completed' })
  })

  it.each([
    {
      name: 'incomplete',
      event: 'response.incomplete',
      response: { status: 'incomplete', error: null, incomplete_details: { reason: 'max_output_tokens' } },
      title: 'Provider response incomplete',
      detail: 'max_output_tokens'
    },
    {
      name: 'cancelled',
      event: 'response.cancelled',
      response: { status: 'cancelled', error: null },
      title: 'Provider stopped the response',
      detail: 'response.cancelled'
    }
  ])('treats a response.$name terminal event as a retryable structured failure', async ({ event, response, title, detail }) => {
    const body = `event: ${event}\ndata: ${JSON.stringify({ type: event, response })}\n\n`
    const provider = new DirectApiProvider('openai', vi.fn(async () => streamResponse(body)) as unknown as typeof fetch)

    const { error, events } = await captureStreamFailure(provider)

    expect(error.appError.code).toBe('provider-unavailable')
    expect(error.appError.title).toBe(title)
    expect(error.appError.recovery).toBe('retry')
    expect(error.appError.technicalDetails).toContain(detail)
    expect(events.some((providerEvent) => providerEvent.type === 'completed')).toBe(false)
  })

  it('delivers the text Anthropic managed to produce, then reports the max_tokens cut-off as incomplete', async () => {
    const body = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', stop_reason: null } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The first half of a long answer' } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 8192 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
    ].join('')
    const provider = new DirectApiProvider('anthropic', vi.fn(async () => streamResponse(body)) as unknown as typeof fetch)

    const { error, events } = await captureStreamFailure(provider)

    expect(events).toContainEqual({ type: 'delta', text: 'The first half of a long answer' })
    expect(events.some((event) => event.type === 'completed')).toBe(false)
    expect(error.appError.code).toBe('provider-unavailable')
    expect(error.appError.title).toBe('Provider response incomplete')
    expect(error.appError.recovery).toBe('retry')
    expect(error.appError.technicalDetails).toContain('max_tokens')
  })

  it('lets an Anthropic answer that ended on its own complete normally', async () => {
    const body = [
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } })}\n\n`
    ].join('')
    const provider = new DirectApiProvider('anthropic', vi.fn(async () => streamResponse(body)) as unknown as typeof fetch)
    const events: ProviderEvent[] = []

    for await (const event of provider.send(API_KEY, { modelId: 'vision-model', reasoningEffort: null, text: 'Question' })) {
      events.push(event)
    }

    expect(events).toContainEqual({ type: 'delta', text: 'Done.' })
    expect(events.at(-1)).toMatchObject({ type: 'completed' })
  })

  it('reports a chat-completion choice that stopped for length as incomplete after its text', async () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: ' answer' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`
    const provider = new DirectApiProvider('custom', vi.fn(async () => streamResponse(body)) as unknown as typeof fetch, {
      baseUrl: 'https://provider.example/v1'
    })

    const { error, events } = await captureStreamFailure(provider)

    expect(events.filter((event) => event.type === 'delta')).toEqual([{ type: 'delta', text: 'Partial' }, { type: 'delta', text: ' answer' }])
    expect(error.appError.title).toBe('Provider response incomplete')
    expect(error.appError.technicalDetails).toContain('length')
  })

  it.each([
    { field: 'code', value: 'invalid_api_key', code: 'authentication-required', recovery: 'authenticate' },
    { field: 'type', value: 'rate_limit_error', code: 'rate-limited', recovery: 'retry' }
  ] as const)('preserves $code recovery for a structured $value stream error', async ({ field, value, code, recovery }) => {
    const body = `data: ${JSON.stringify({ error: { [field]: value, message: `Rejected ${API_KEY}` } })}\n\n`
    const provider = new DirectApiProvider('custom', vi.fn(async () => streamResponse(body)) as unknown as typeof fetch, {
      baseUrl: 'https://provider.example/v1'
    })

    const { error } = await captureStreamFailure(provider)

    expect(error.appError.code).toBe(code)
    expect(error.appError.recovery).toBe(recovery)
    expect(error.appError.technicalDetails).not.toContain(API_KEY)
  })

  it.each([
    {
      name: 'OpenAI Responses',
      kind: 'openai' as const,
      body: `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: `Request failed for ${API_KEY}` } } })}\n\n`
    },
    {
      name: 'OpenAI-compatible chat',
      kind: 'custom' as const,
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial answer' } }] })}\n\ndata: ${JSON.stringify({ error: { type: 'server_error', message: `Upstream rejected ${API_KEY}` } })}\n\n`
    },
    {
      name: 'Anthropic',
      kind: 'anthropic' as const,
      body: `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: `Provider unavailable for ${API_KEY}` } })}\n\n`
    }
  ])('throws a structured failure for $name error frames instead of completing', async ({ kind, body }) => {
    const request = vi.fn(async () => streamResponse(body))
    const provider = new DirectApiProvider(kind, request as unknown as typeof fetch, {
      ...(kind === 'custom' ? { baseUrl: 'https://provider.example/v1' } : {})
    })

    const { error, events } = await captureStreamFailure(provider)

    expect(error.appError.code).toBe('provider-unavailable')
    expect(error.appError.technicalDetails).toContain('Provider stream failed')
    expect(error.appError.technicalDetails).not.toContain(API_KEY)
    expect(events[0]).toMatchObject({ type: 'started' })
    expect(events.some((event) => event.type === 'completed')).toBe(false)
    if (kind === 'custom') expect(events).toContainEqual({ type: 'delta', text: 'Partial answer' })
  })
})
