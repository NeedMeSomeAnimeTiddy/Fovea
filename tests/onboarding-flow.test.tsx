// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsViewState } from '../src/shared/contracts/ipc'
import { AboutSettings } from '../src/renderer/settings/main'
import { OnboardingFlow } from '../src/renderer/settings/OnboardingFlow'

afterEach(cleanup)

describe('first-run onboarding flow', () => {
  it('moves through the three labelled steps and focuses each heading', async () => {
    const user = userEvent.setup()
    renderFlow()

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Ask anything you can see' }))
    expect(screen.getByText('How it works').closest('li')?.getAttribute('aria-current')).toBe('step')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Choose how to connect' }))
    expect(screen.getByText('Connect').closest('li')?.getAttribute('aria-current')).toBe('step')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Set your capture shortcut' }))
    expect(screen.getByText('Shortcut & test').closest('li')?.getAttribute('aria-current')).toBe('step')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Choose how to connect' }))
  })

  it('skips first run, while a manually reopened tour closes without changing status', async () => {
    const user = userEvent.setup()
    const firstRun = renderFlow()
    await user.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(firstRun.onSetStatus).toHaveBeenCalledWith('skipped')
    expect(firstRun.onExit).toHaveBeenCalledTimes(1)

    cleanup()
    const reopened = renderFlow({ onboardingStatus: 'completed' })
    await user.click(screen.getByRole('button', { name: 'Close tour' }))
    expect(reopened.onSetStatus).not.toHaveBeenCalled()
    expect(reopened.onExit).toHaveBeenCalledTimes(1)
  })

  it('offers optional ChatGPT sign-in without blocking navigation', async () => {
    const user = userEvent.setup()
    const onSignIn = vi.fn(async () => undefined)
    renderFlow({}, { onSignIn })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    await waitFor(() => expect(onSignIn).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('status').textContent).toMatch(/ChatGPT is connected/i)
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { name: 'Set your capture shortcut' })).toBeTruthy()
  })

  it('connects supported API-key providers without asking for an endpoint', async () => {
    const user = userEvent.setup()
    const onCreateApiProfile = vi.fn(async () => undefined)
    renderFlow({}, { onCreateApiProfile })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: /Anthropic/ }))
    await user.type(screen.getByLabelText('Anthropic API key'), 'anthropic-secret')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(onCreateApiProfile).toHaveBeenCalledWith('anthropic', 'Anthropic', 'anthropic-secret'))
    expect(screen.queryByLabelText(/endpoint/i)).toBeNull()
  })

  it('shows and clears a private preview across capture and cancellation', async () => {
    const user = userEvent.setup()
    const onTestCapture = vi.fn()
      .mockResolvedValueOnce({ status: 'captured', thumbnailDataUrl: 'data:image/png;base64,preview' })
      .mockResolvedValueOnce({ status: 'cancelled' })
    renderFlow({}, { onTestCapture })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('CommandOrControl+Alt+Shift+Space')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Test region capture' }))
    expect((await screen.findByRole('img', { name: 'Your private test capture' })).getAttribute('src')).toBe('data:image/png;base64,preview')
    expect(screen.getByRole('status').textContent).toMatch(/nothing was sent to AI/i)

    await user.click(screen.getByRole('button', { name: 'Retake test capture' }))
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Your private test capture' })).toBeNull())
    expect(screen.getByRole('status').textContent).toMatch(/cancelled.*nothing was saved or sent/i)
  })

  it('shows shortcut registration failures and upgrades skipped onboarding on Finish', async () => {
    const user = userEvent.setup()
    const state = makeState({
      onboardingStatus: 'skipped',
      shortcuts: [{ action: 'region', accelerator: 'Ctrl+Shift+Space', registered: false, error: 'This shortcut is unavailable.' }]
    })
    const onSetStatus = vi.fn(async () => undefined)
    render(<OnboardingFlow state={state} onCreateApiProfile={vi.fn()} onExit={vi.fn()} onSetShortcut={vi.fn()} onSetStatus={onSetStatus} onSignIn={vi.fn()} onTestCapture={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('alert').textContent).toContain('This shortcut is unavailable.')
    await user.click(screen.getByRole('button', { name: 'Finish' }))
    expect(onSetStatus).toHaveBeenCalledWith('completed')
  })

  it('records and saves a custom region shortcut in the third step', async () => {
    const user = userEvent.setup()
    const onSetShortcut = vi.fn(async () => undefined)
    renderFlow({}, { onSetShortcut })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))

    const shortcut = screen.getByRole('button', { name: 'Region capture shortcut' })
    await user.click(shortcut)
    expect(shortcut.textContent).toContain('Press shortcut')
    fireEvent.keyDown(shortcut, { key: 'k', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false })

    await waitFor(() => expect(onSetShortcut).toHaveBeenCalledWith('Ctrl+Shift+K'))
    expect(screen.getByRole('status').textContent).toMatch(/shortcut set to Ctrl\+Shift\+K/i)
  })

  it('reopens the welcome tour from About', async () => {
    const user = userEvent.setup()
    const onOpenTour = vi.fn()
    render(<AboutSettings appVersion="0.1.0" onOpenTour={onOpenTour} />)
    await user.click(screen.getByRole('button', { name: 'Run welcome tour again' }))
    expect(onOpenTour).toHaveBeenCalledTimes(1)
  })
})

function renderFlow(
  statePatch: Partial<SettingsViewState> = {},
  callbacks: {
    onExit?: () => void
    onCreateApiProfile?: (provider: 'openai' | 'anthropic' | 'openrouter', name: string, apiKey: string) => Promise<void>
    onSetShortcut?: (accelerator: string | null) => Promise<void>
    onSetStatus?: (status: 'skipped' | 'completed') => Promise<void>
    onSignIn?: () => Promise<void>
    onTestCapture?: () => Promise<{ status: 'captured'; thumbnailDataUrl: string } | { status: 'cancelled' }>
  } = {}
): {
  onExit: ReturnType<typeof vi.fn>
  onSetStatus: ReturnType<typeof vi.fn>
} {
  const onExit = vi.fn(callbacks.onExit)
  const onSetStatus = vi.fn(callbacks.onSetStatus ?? (async () => undefined))
  render(
    <OnboardingFlow
      state={makeState(statePatch)}
      onCreateApiProfile={callbacks.onCreateApiProfile ?? vi.fn(async () => undefined)}
      onExit={onExit}
      onSetShortcut={callbacks.onSetShortcut ?? vi.fn(async () => undefined)}
      onSetStatus={onSetStatus}
      onSignIn={callbacks.onSignIn ?? vi.fn(async () => undefined)}
      onTestCapture={callbacks.onTestCapture ?? vi.fn(async () => ({ status: 'cancelled' as const }))}
    />
  )
  return { onExit, onSetStatus }
}

function makeState(patch: Partial<SettingsViewState> = {}): SettingsViewState {
  return {
    appearance: { preference: 'light', resolved: 'light' },
    profiles: [],
    shortcuts: [{ action: 'region', accelerator: 'CommandOrControl+Alt+Shift+Space', registered: true }],
    customPrompts: [],
    launchAtLogin: false,
    onboardingStatus: 'pending',
    history: { privateMode: false, retentionDays: 30, retainScreenshots: false },
    tempLocation: 'C:\\temp',
    appVersion: '0.1.0',
    ...patch
  }
}
