// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsViewState } from '@shared/contracts/ipc'
import { CustomPromptsSettings, HistorySettings, RecipeSettings } from '../src/renderer/settings/main'

afterEach(cleanup)

describe('recipe auto-send consent', () => {
  const state = { recipes: [], recipeShortcuts: [], profiles: [], customPrompts: [] } as unknown as SettingsViewState

  it('asks for consent in a Fovea dialog before enabling auto-send, and keeps it off on cancel', async () => {
    const user = userEvent.setup()
    render(<RecipeSettings state={state} working={false} onRun={vi.fn(async () => true)} />)
    await user.click(screen.getByRole('button', { name: 'New recipe' }))

    const autoSend = screen.getByRole('checkbox', { name: 'Auto-send after capture' })
    await user.click(autoSend)
    const dialog = screen.getByRole('dialog', { name: 'Enable auto-send for this recipe?' })
    expect(dialog.textContent).toContain('immediately after capture')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByRole('checkbox', { name: 'Auto-send after capture' }) as HTMLInputElement).checked).toBe(false)
    expect(document.activeElement).toBe(autoSend)
  })

  it('enables auto-send with its consent version once the dialog is confirmed', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn(async (operation: () => Promise<unknown>) => { await operation(); return true })
    const saveRecipe = vi.fn(async () => undefined)
    Object.assign(window, { fovea: { settings: { saveRecipe } } })
    render(<RecipeSettings state={state} working={false} onRun={onRun} />)
    await user.click(screen.getByRole('button', { name: 'New recipe' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Invoice')

    await user.click(screen.getByRole('checkbox', { name: 'Auto-send after capture' }))
    await user.click(screen.getByRole('button', { name: 'Enable auto-send' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByRole('checkbox', { name: 'Auto-send after capture' }) as HTMLInputElement).checked).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(saveRecipe).toHaveBeenCalledWith(expect.objectContaining({ name: 'Invoice', autoSend: true, autoSendConsentVersion: 1 }))

    await user.click(screen.getByRole('button', { name: 'New recipe' }))
    const autoSend = screen.getByRole('checkbox', { name: 'Auto-send after capture' })
    expect((autoSend as HTMLInputElement).checked).toBe(false)
  })
})

describe('clearing conversation history', () => {
  const items = [{ id: 'one', title: 'Receipt', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 2, hasScreenshots: false }]

  it('confirms in a destructive Fovea dialog before clearing, and does nothing on cancel', async () => {
    const user = userEvent.setup()
    const clear = vi.fn(async () => 1)
    Object.assign(window, { fovea: { history: { clear } } })
    const onRun = vi.fn(async (operation: () => Promise<unknown>) => { await operation(); return true })
    const onRefresh = vi.fn()
    render(<HistorySettings items={items} query="" working={false} onQuery={vi.fn()} onRefresh={onRefresh} onRun={onRun} onExport={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: 'Clear all history' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Delete all saved conversations?' })
    expect(dialog.getAttribute('data-tone')).toBe('danger')
    expect(dialog.textContent).toContain('cannot be undone')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(clear).not.toHaveBeenCalled()
    expect(onRun).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Delete all history' }))
    expect(clear).toHaveBeenCalledOnce()
    expect(onRun).toHaveBeenCalledWith(expect.any(Function), 'All conversation history deleted.', 'Clearing history…')
    expect(onRefresh).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

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
