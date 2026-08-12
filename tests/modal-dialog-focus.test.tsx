// @vitest-environment jsdom

import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationExportDialog } from '../src/renderer/export/ConversationExportDialog'
import { ScreenshotEditor } from '../src/renderer/question-window/ScreenshotEditor'

afterEach(cleanup)

describe('renderer modal focus management', () => {
  it('traps export-dialog focus, closes with Escape, and restores the trigger', async () => {
    render(<ExportHarness />)
    const trigger = screen.getByRole('button', { name: 'Show export' })

    fireEvent.click(trigger)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const choose = screen.getByRole('button', { name: 'Choose destination' })
    const format = screen.getByRole('combobox', { name: 'Format' })
    await waitFor(() => expect(document.activeElement).toBe(cancel))
    expect(trigger.getAttribute('aria-hidden')).toBe('true')
    expect(trigger.hasAttribute('inert')).toBe(true)

    format.focus()
    fireEvent.keyDown(format, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(choose)
    fireEvent.keyDown(choose, { key: 'Tab' })
    expect(document.activeElement).toBe(format)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Export conversation' })).toBeNull()
    expect(trigger.hasAttribute('aria-hidden')).toBe(false)
    expect(trigger.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('closes the screenshot editor with Escape and restores its trigger', async () => {
    render(<ScreenshotEditorHarness />)
    const trigger = screen.getByRole('button', { name: 'Edit screenshot' })

    fireEvent.click(trigger)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(document.activeElement).toBe(cancel))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Edit screenshot' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('does not dismiss an export dialog while an export is busy', async () => {
    const onCancel = vi.fn()
    render(
      <ConversationExportDialog
        busy
        preview={preview}
        onCancel={onCancel}
        onExport={vi.fn(async () => undefined)}
      />
    )

    expect(screen.getByRole('dialog', { name: 'Export conversation' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Format' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('leaves Escape to an active IME composition before cancelling normally', () => {
    const onCancel = vi.fn()
    render(
      <ConversationExportDialog
        busy={false}
        preview={preview}
        onCancel={onCancel}
        onExport={vi.fn(async () => undefined)}
      />
    )

    fireEvent.keyDown(document, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 })
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

const preview = {
  title: 'Example conversation',
  messageCount: 2,
  screenshotCount: 1,
  ocrCharacterCount: 0,
  providerTransitionCount: 0,
  excerpt: 'A short preview.'
}

function ExportHarness(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return <>
    <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Show export</button>
    {open && (
      <ConversationExportDialog
        busy={false}
        preview={preview}
        returnFocus={triggerRef.current}
        onCancel={() => setOpen(false)}
        onExport={async () => undefined}
      />
    )}
  </>
}

function ScreenshotEditorHarness(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return <>
    <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Edit screenshot</button>
    {open && (
      <ScreenshotEditor
        imageDataUrl="data:image/png;base64,"
        returnFocus={triggerRef.current}
        saving={false}
        onCancel={() => setOpen(false)}
        onSave={() => undefined}
      />
    )}
  </>
}
