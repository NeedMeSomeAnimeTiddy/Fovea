// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomPromptsSettings } from '../src/renderer/settings/main'

afterEach(cleanup)

describe('custom prompt settings', () => {
  it('adds a named prompt', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    render(<CustomPromptsSettings prompts={[]} working={false} onSave={onSave} onDelete={vi.fn(async () => undefined)} />)

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Summarise for Slack')
    await user.type(screen.getByRole('textbox', { name: 'Prompt' }), 'Summarise this in three Slack-ready bullets.')
    await user.click(screen.getByRole('button', { name: 'Add prompt' }))

    expect(onSave).toHaveBeenCalledWith(null, 'Summarise for Slack', 'Summarise this in three Slack-ready bullets.')
  })

  it('edits and deletes an existing prompt', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    const onDelete = vi.fn(async () => undefined)
    render(
      <CustomPromptsSettings
        prompts={[{ id: 'review', label: 'Review UI', prompt: 'Review the visible interface.' }]}
        working={false}
        onSave={onSave}
        onDelete={onDelete}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    await user.clear(prompt)
    await user.type(prompt, 'Review the visible interface for accessibility.')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(onSave).toHaveBeenCalledWith('review', 'Review UI', 'Review the visible interface for accessibility.')

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith('review')
  })
})
