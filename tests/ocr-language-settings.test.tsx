// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OcrLanguageSettings } from '../src/renderer/settings/main'

afterEach(cleanup)

describe('OCR language settings', () => {
  it('explains that Windows language packs control local OCR and opens their settings', () => {
    const onOpen = vi.fn()
    render(<OcrLanguageSettings working={false} onOpen={onOpen} />)

    expect(screen.getByRole('heading', { name: 'Text recognition languages' })).toBeTruthy()
    expect(screen.getByText(/OCR languages installed in Windows/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Manage OCR languages' }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('disables the action while another settings operation is running', () => {
    render(<OcrLanguageSettings working onOpen={vi.fn()} />)

    expect((screen.getByRole('button', { name: 'Manage OCR languages' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
