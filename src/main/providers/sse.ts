import { createParser } from 'eventsource-parser'

export async function* parseSse(response: Response, signal?: AbortSignal): AsyncIterable<{ event?: string; data: string }> {
  if (!response.body) throw new Error('The provider returned an empty streaming response.')
  const messages: Array<{ event?: string; data: string }> = []
  let parseError: Error | null = null
  const parser = createParser({
    maxBufferSize: 2 * 1024 * 1024,
    onEvent: (event) => messages.push({ event: event.event, data: event.data }),
    onError: (error) => { parseError = error }
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('Request cancelled.')
      const chunk = await reader.read()
      if (chunk.done) break
      parser.feed(decoder.decode(chunk.value, { stream: true }))
      if (parseError) throw parseError
      while (messages.length) yield messages.shift()!
    }
    parser.feed(decoder.decode())
    while (messages.length) yield messages.shift()!
  } finally {
    reader.releaseLock()
  }
}
