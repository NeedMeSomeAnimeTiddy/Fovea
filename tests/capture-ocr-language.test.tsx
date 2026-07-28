// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptureHud } from '../src/renderer/capture-overlay/main'

afterEach(cleanup)

function renderHud(extractText: boolean, onOcrLanguageChange = vi.fn()): void {
  render(
    <CaptureHud
      canEditBeforeSending
      detail="Select a region"
      editBeforeSending={false}
      error={false}
      extractText={extractText}
      ocrLanguageCode=""
      ocrLanguages={[
        { code: 'en-GB', label: 'English (United Kingdom)', source: 'configured' },
        { code: 'ja', label: 'Japanese', source: 'configured' }
      ]}
      preferWebSearch={false}
      onCancel={vi.fn()}
      onOcrLanguageChange={onOcrLanguageChange}
      onToggleEdit={vi.fn()}
      onToggleExtractText={vi.fn()}
      onToggleWebSearch={vi.fn()}
    />
  )
}

describe('capture OCR language picker', () => {
  it('keeps the picker hidden until local OCR is enabled', () => {
    renderHud(false)
    expect(screen.queryByRole('combobox', { name: 'OCR language' })).toBeNull()
  })

  it('offers automatic and installed Windows OCR languages', () => {
    const onChange = vi.fn()
    renderHud(true, onChange)
    const select = screen.getByRole('combobox', { name: 'OCR language' })

    expect(screen.getByRole('option', { name: 'Automatic' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Japanese' })).toBeTruthy()
    fireEvent.change(select, { target: { value: 'ja' } })
    expect(onChange).toHaveBeenCalledWith('ja')
  })
})
