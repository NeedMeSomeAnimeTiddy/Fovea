import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DirectApiProvider, openAiVisionFamily } from '../src/main/providers/direct-api-provider'
import type { VisionTurnInput } from '../src/shared/types/provider'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function emptyStream(): Response {
  return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function requestBody(provider: DirectApiProvider, request: ReturnType<typeof vi.fn>, input: Omit<VisionTurnInput, 'modelId' | 'reasoningEffort'>): Promise<Record<string, any>> {
  for await (const _event of provider.send('sk-test', { modelId: 'vision-model', reasoningEffort: null, ...input })) {
    void _event
  }
  return JSON.parse(String((request.mock.calls[0]![1] as RequestInit).body)) as Record<string, any>
}

const HISTORY: VisionTurnInput['history'] = [
  { role: 'user', text: 'Analyse this capture' },
  { role: 'assistant', text: 'A settings dialog.\nIt shows the display options.' },
  { role: 'user', text: 'Which option is selected?' },
  { role: 'assistant', text: 'Dark mode.' }
]

describe('OpenAI vision model allow-list', () => {
  it.each([
    ['gpt-4o', false],
    ['gpt-4o-mini', false],
    ['gpt-4.1', false],
    ['gpt-4.1-nano', false],
    ['gpt-4-turbo', false],
    ['gpt-5', true],
    ['gpt-5-mini', true],
    ['gpt-5.2', true],
    ['gpt-6-mini', true],
    ['gpt-10', true],
    ['o3', true],
    ['o3-pro', true],
    ['o4-mini', true],
    ['o5', true]
  ])('accepts %s (reasoning efforts: %s)', (id, reasoning) => {
    expect(openAiVisionFamily(id)).toEqual({ reasoning })
  })

  it.each([
    'gpt-4o-audio-preview',
    'gpt-4o-realtime-preview',
    'gpt-4o-mini-tts',
    'gpt-4o-transcribe',
    'gpt-4o-search-preview',
    'gpt-5-codex',
    'gpt-image-1',
    'gpt-3.5-turbo',
    'gpt-3.5-turbo-instruct',
    'whisper-1',
    'text-embedding-3-large',
    'omni-moderation-latest',
    'codex-mini-latest',
    'davinci-002',
    'babbage-002',
    'dall-e-3',
    'chatgpt-4o-latest',
    'o1-mini',
    'GPT-4O-AUDIO-PREVIEW'
  ])('rejects %s', (id) => {
    expect(openAiVisionFamily(id)).toBeNull()
  })

  it('offers future GPT generations from the model list with reasoning efforts where they apply', async () => {
    const request = vi.fn(async () => jsonResponse({ data: [
      { id: 'gpt-6-mini' },
      { id: 'gpt-4o' },
      { id: 'gpt-4o-audio-preview' },
      { id: 'o4-mini' },
      { id: 'text-embedding-3-small' }
    ] }))
    const provider = new DirectApiProvider('openai', request as unknown as typeof fetch)

    const models = await provider.listModels('sk-test')

    expect(models.map((model) => model.id)).toEqual(['gpt-4o', 'gpt-6-mini', 'o4-mini'])
    expect(models.find((model) => model.id === 'gpt-6-mini')).toMatchObject({ supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'low' })
    expect(models.find((model) => model.id === 'gpt-4o')).toMatchObject({ supportedReasoningEfforts: [] })
    expect(models.find((model) => model.id === 'o4-mini')).toMatchObject({ supportedReasoningEfforts: ['low', 'medium', 'high'] })
  })
})

describe('conversation history on stateless endpoints', () => {
  it('replays prior turns as Responses API input items before the current user turn', async () => {
    const request = vi.fn(async () => emptyStream())
    const provider = new DirectApiProvider('openai', request as unknown as typeof fetch)

    const body = await requestBody(provider, request, { text: 'And the font size?', history: HISTORY })

    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Analyse this capture' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'A settings dialog.\nIt shows the display options.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Which option is selected?' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Dark mode.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'And the font size?' }] }
    ])
  })

  it('replays prior turns as alternating Anthropic messages with images only on the final turn', async () => {
    const request = vi.fn(async () => emptyStream())
    const provider = new DirectApiProvider('anthropic', request as unknown as typeof fetch)
    const directory = await mkdtemp(join(tmpdir(), 'fovea-history-'))
    const imagePath = join(directory, 'history-turn.png')
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    try {
      const body = await requestBody(provider, request, { text: 'And the font size?', history: HISTORY, imagePaths: [imagePath] })

      expect(body.max_tokens).toBe(8192)
      expect(body.messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
      expect(body.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Analyse this capture' }] })
      expect(body.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'A settings dialog.\nIt shows the display options.' }] })
      const finalTurn = body.messages.at(-1) as { content: Array<{ type: string; text?: string }> }
      expect(finalTurn.content.map((part) => part.type)).toEqual(['image', 'text'])
      expect(finalTurn.content.at(-1)).toEqual({ type: 'text', text: 'And the font size?' })
      expect(body.messages.slice(0, -1).some((message: { content: Array<{ type: string }> }) => message.content.some((part) => part.type === 'image'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('folds same-role neighbours and drops a leading assistant turn for Anthropic', async () => {
    const request = vi.fn(async () => emptyStream())
    const provider = new DirectApiProvider('anthropic', request as unknown as typeof fetch)

    const body = await requestBody(provider, request, {
      text: 'Current question',
      history: [
        { role: 'assistant', text: 'Orphaned answer' },
        { role: 'user', text: 'First' },
        { role: 'user', text: 'Second' },
        { role: 'assistant', text: 'Reply' },
        { role: 'user', text: 'Third without an answer' }
      ]
    })

    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'Third without an answer' }, { type: 'text', text: 'Current question' }] }
    ])
  })

  it('replays prior turns as plain chat-completion messages after the system prompt', async () => {
    const request = vi.fn(async () => emptyStream())
    const provider = new DirectApiProvider('custom', request as unknown as typeof fetch, { baseUrl: 'https://provider.example/v1' })

    const body = await requestBody(provider, request, { text: 'And the font size?', history: HISTORY })

    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user'])
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Analyse this capture' })
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'A settings dialog.\nIt shows the display options.' })
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'And the font size?' }] })
  })

  it('sends a single user turn when there is no history', async () => {
    const request = vi.fn(async () => emptyStream())
    const provider = new DirectApiProvider('openai', request as unknown as typeof fetch)

    const body = await requestBody(provider, request, { text: 'First question' })

    expect(body.input).toHaveLength(1)
    expect(body.input[0]).toMatchObject({ role: 'user' })
  })
})
