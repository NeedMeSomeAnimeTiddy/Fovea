// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationExchange } from '../src/shared/types/app'
import { ConversationTimeline } from '../src/renderer/question-window/main'

afterEach(cleanup)

function answer(markdown: string): ConversationExchange[] {
  return [{
    id: 'highlighted',
    question: 'Show me the code',
    answer: markdown,
    phase: 'completed',
    segmentId: 'segment-1',
    createdAt: '2026-01-02T09:30:00.000Z',
    completedAt: '2026-01-02T09:30:01.000Z',
    source: 'ai',
    automatic: true
  }]
}

function renderAnswer(markdown: string): HTMLElement {
  const { container } = render(
    <ConversationTimeline
      exchanges={answer(markdown)}
      onCopy={vi.fn(async () => undefined)}
      onResolveWebSearch={vi.fn()}
    />
  )
  return container
}

describe('answer syntax highlighting', () => {
  it('highlights a fenced language once the plugin has loaded', async () => {
    // The plugin is fetched on a dynamic import after first paint, so the tokens appear on a
    // later render than the code itself.
    const container = renderAnswer(['```ts', "const answer = 'ready'", '```'].join('\n'))

    await waitFor(() => {
      expect(container.querySelector('pre code.hljs')).toBeTruthy()
    })
    expect(container.querySelector('pre code.hljs .hljs-keyword')?.textContent).toBe('const')
    expect(container.querySelector('pre code.hljs .hljs-string')?.textContent).toBe("'ready'")
  })

  it('still renders the code when a fence names no language', async () => {
    const container = renderAnswer(['```', 'Fixture status: ready', '```'].join('\n'))

    await waitFor(() => {
      expect(container.querySelector('pre code')).toBeTruthy()
    })
    // Nothing to tokenise, which is exactly why the visual fixture names a language.
    expect(container.querySelector('.hljs-keyword')).toBeNull()
    expect(container.querySelector('pre code')?.textContent).toContain('Fixture status: ready')
  })
})
