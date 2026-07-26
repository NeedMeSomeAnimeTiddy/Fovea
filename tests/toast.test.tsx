// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Toast, ToastViewport } from '../src/renderer/design-system'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('toast notifications', () => {
  it('dismisses itself after its duration', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()

    render(
      <ToastViewport>
        <Toast duration={2000} onDismiss={onDismiss}>Temporary files cleared.</Toast>
      </ToastViewport>
    )

    expect(screen.getByRole('status')).toBeTruthy()
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.queryByRole('status')).toBeNull()
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('can be closed immediately', () => {
    const onDismiss = vi.fn()

    render(
      <Toast duration={0} onDismiss={onDismiss} tone="error">
        The request failed.
      </Toast>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('pauses auto-dismiss while the user is interacting with it', () => {
    vi.useFakeTimers()
    render(<Toast duration={1000}>Searching the web…</Toast>)

    const toast = screen.getByRole('status')
    fireEvent.mouseEnter(toast)
    act(() => vi.advanceTimersByTime(1500))
    expect(screen.getByRole('status')).toBeTruthy()

    fireEvent.mouseLeave(toast)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
