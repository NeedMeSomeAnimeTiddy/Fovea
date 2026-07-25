// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuestionTitlebarActions } from '../src/renderer/question-window/QuestionTitlebarActions'

afterEach(cleanup)

describe('question title-bar actions', () => {
  it('keeps the answer-first title bar minimal and exposes pin state accessibly', async () => {
    const user = userEvent.setup()
    const onTogglePinned = vi.fn()
    const { rerender } = render(
      <QuestionTitlebarActions pinned={false} onTogglePinned={onTogglePinned} />
    )

    const pin = screen.getByRole('button', { name: 'Keep this window on top' })
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    await user.click(pin)
    expect(onTogglePinned).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /layout/i })).toBeNull()

    rerender(<QuestionTitlebarActions pinned onTogglePinned={onTogglePinned} />)
    expect(screen.getByRole('button', { name: 'Stop keeping this window on top' }).getAttribute('aria-pressed')).toBe('true')
  })
})
