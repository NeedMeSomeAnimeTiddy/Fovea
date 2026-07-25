// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuestionTitlebarActions } from '../src/renderer/question-window/QuestionTitlebarActions'

afterEach(cleanup)

describe('question title-bar actions', () => {
  it('switches fixed-window presentation modes with accessible pressed state', async () => {
    const user = userEvent.setup()
    const onToggleCompact = vi.fn()
    const onTogglePinned = vi.fn()
    const { rerender } = render(<QuestionTitlebarActions compact={false} pinned={false} onToggleCompact={onToggleCompact} onTogglePinned={onTogglePinned} />)

    const compact = screen.getByRole('button', { name: 'Use compact layout' })
    expect(compact.getAttribute('aria-pressed')).toBe('false')
    await user.click(compact)
    expect(onToggleCompact).toHaveBeenCalledTimes(1)

    rerender(<QuestionTitlebarActions compact pinned={false} onToggleCompact={onToggleCompact} onTogglePinned={onTogglePinned} />)
    expect(screen.getByRole('button', { name: 'Use expanded layout' }).getAttribute('aria-pressed')).toBe('true')

    const pin = screen.getByRole('button', { name: 'Keep this window on top' })
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    await user.click(pin)
    expect(onTogglePinned).toHaveBeenCalledTimes(1)
  })

  it('keeps layout switching unavailable until a response exists', () => {
    render(<QuestionTitlebarActions compact={false} layoutDisabled pinned={false} onToggleCompact={vi.fn()} onTogglePinned={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Use compact layout' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Keep this window on top' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
