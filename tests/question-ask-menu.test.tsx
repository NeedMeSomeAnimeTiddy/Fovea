// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AskMenu, ModelMenu } from '../src/renderer/question-window/main'

afterEach(cleanup)

describe('response Ask menu', () => {
  it('shows saved prompts and sends their stored prompt text', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => undefined)
    render(
      <AskMenu
        busy={false}
        customOpen={false}
        customPrompts={[{ id: 'slack-summary', label: 'Summarise for Slack', prompt: 'Summarise this in three Slack-ready bullets.' }]}
        preferWebSearch={false}
        suggestions={['Show every step']}
        text=""
        onCustom={vi.fn()}
        onSend={onSend}
        onTextChange={vi.fn()}
        onToggleWebSearch={vi.fn()}
      />
    )

    await user.click(screen.getByRole('menuitem', { name: /Summarise for Slack/ }))
    expect(onSend).toHaveBeenCalledWith('Summarise this in three Slack-ready bullets.')
    expect(screen.getByText('You could ask…')).toBeTruthy()
  })

  it('offers contextual prompts and sends the selected prompt', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => undefined)
    render(
      <AskMenu
        busy={false}
        customOpen={false}
        preferWebSearch={false}
        suggestions={['Show every step', 'Check my working']}
        text=""
        onCustom={vi.fn()}
        onSend={onSend}
        onTextChange={vi.fn()}
        onToggleWebSearch={vi.fn()}
      />
    )

    await user.click(screen.getByRole('menuitem', { name: 'Show every step' }))
    expect(onSend).toHaveBeenCalledWith('Show every step')
    expect(screen.getByRole('menuitem', { name: 'Custom question' })).toBeTruthy()
  })

  it('opens an inline custom composer and sends with Enter', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => undefined)
    const onTextChange = vi.fn()
    const { rerender } = render(
      <AskMenu
        busy={false}
        customOpen={false}
        preferWebSearch={false}
        suggestions={['Explain this']}
        text=""
        onCustom={vi.fn()}
        onSend={onSend}
        onTextChange={onTextChange}
        onToggleWebSearch={vi.fn()}
      />
    )

    rerender(
      <AskMenu
        busy={false}
        customOpen
        preferWebSearch={false}
        suggestions={['Explain this']}
        text="Why does this happen?"
        onCustom={vi.fn()}
        onSend={onSend}
        onTextChange={onTextChange}
        onToggleWebSearch={vi.fn()}
      />
    )
    const input = screen.getByRole('textbox', { name: 'Custom question' })
    await user.type(input, '{enter}')
    expect(onSend).toHaveBeenCalledWith()
  })

  it('lets the user prioritise web search for the next question', async () => {
    const user = userEvent.setup()
    const onToggleWebSearch = vi.fn()
    const { rerender } = render(
      <AskMenu
        busy={false}
        customOpen={false}
        preferWebSearch={false}
        suggestions={['Identify this']}
        text=""
        onCustom={vi.fn()}
        onSend={vi.fn(async () => undefined)}
        onTextChange={vi.fn()}
        onToggleWebSearch={onToggleWebSearch}
      />
    )

    const search = screen.getByRole('menuitemcheckbox', { name: /Search web/ })
    expect(search.getAttribute('aria-checked')).toBe('false')
    expect(search.querySelector('.search-priority__track')).toBeTruthy()
    expect(screen.getByText('Off')).toBeTruthy()
    await user.click(search)
    expect(onToggleWebSearch).toHaveBeenCalledTimes(1)

    rerender(
      <AskMenu
        busy={false}
        customOpen={false}
        preferWebSearch
        suggestions={['Identify this']}
        text=""
        onCustom={vi.fn()}
        onSend={vi.fn(async () => undefined)}
        onTextChange={vi.fn()}
        onToggleWebSearch={onToggleWebSearch}
      />
    )
    expect(screen.getByRole('menuitemcheckbox', { name: /Search web/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('On')).toBeTruthy()
  })
})

describe('response model menu', () => {
  const models = [
    {
      id: 'vision-fast',
      displayName: 'Vision Fast',
      provider: 'chatgpt' as const,
      inputModalities: ['text', 'image'] as Array<'text' | 'image'>,
      supportedReasoningEfforts: ['low', 'medium'],
      defaultReasoningEffort: 'low',
      isDefault: true
    },
    {
      id: 'vision-deep',
      displayName: 'Vision Deep',
      provider: 'chatgpt' as const,
      inputModalities: ['text', 'image'] as Array<'text' | 'image'>,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium',
      isDefault: false
    }
  ]
  const selection = {
    profileId: 'profile-1',
    provider: 'chatgpt' as const,
    modelId: 'vision-fast',
    reasoningEffort: 'low'
  }

  it('opens each model submenu and selects its thinking effort', async () => {
    const user = userEvent.setup()
    const onExpand = vi.fn()
    const onSelect = vi.fn()
    const { rerender } = render(
      <ModelMenu
        expandedModelId={null}
        models={models}
        selection={selection}
        onExpand={onExpand}
        onSelect={onSelect}
      />
    )

    await user.click(screen.getByRole('menuitem', { name: /Vision Deep/ }))
    expect(onExpand).toHaveBeenCalledWith('vision-deep')

    rerender(
      <ModelMenu
        expandedModelId="vision-deep"
        models={models}
        selection={selection}
        onExpand={onExpand}
        onSelect={onSelect}
      />
    )
    expect(screen.getByRole('menu', { name: 'Vision Deep thinking effort' })).toBeTruthy()
    await user.click(screen.getByRole('menuitemradio', { name: 'High' }))
    expect(onSelect).toHaveBeenCalledWith('vision-deep', 'high')
  })

  it('always offers the provider default and marks the active choice', () => {
    render(
      <ModelMenu
        expandedModelId="vision-fast"
        models={models}
        selection={selection}
        onExpand={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    expect(screen.getByRole('menuitemradio', { name: 'Default' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('menuitemradio', { name: 'Low' }).getAttribute('aria-checked')).toBe('true')
  })
})
