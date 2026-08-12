// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveCaptureSettings } from '../src/renderer/settings/main'

afterEach(cleanup)

describe('live capture settings', () => {
  it('turns live selection off without claiming capture stopped working', () => {
    const onChange = vi.fn()
    render(<LiveCaptureSettings state={{ enabled: true, supported: true }} onChange={onChange} />)

    expect(screen.getByRole('heading', { name: 'Region selection' })).toBeTruthy()
    expect(screen.queryByText(/Compatibility capture in use/)).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select over the live screen' }))
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('explains the frozen fallback once the user has turned live selection off', () => {
    render(<LiveCaptureSettings state={{ enabled: false, supported: true }} onChange={vi.fn()} />)

    const toggle = screen.getByRole('checkbox', { name: 'Select over the live screen' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(toggle.disabled).toBe(false)
    expect(screen.getByText(/Turn this on again/)).toBeTruthy()
  })

  it('locks the switch where the platform cannot hide the overlay from its own capture', () => {
    render(<LiveCaptureSettings state={{ enabled: false, supported: false }} onChange={vi.fn()} />)

    expect((screen.getByRole('checkbox', { name: 'Select over the live screen' }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/This Windows version cannot hide the selection overlay/)).toBeTruthy()
  })
})
