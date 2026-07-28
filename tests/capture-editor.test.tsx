// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CaptureEditor } from '../src/renderer/capture-overlay/CaptureEditor'

describe('in-place capture editor', () => {
  it('places text at a clicked point before sending the capture', async () => {
    const send = vi.fn()
    render(
      <CaptureEditor
        context={{
          width: 1920,
          height: 1080,
          minSelectionSize: 24,
          imageDataUrl: 'data:image/jpeg;base64,',
          canEditBeforeSending: true
        }}
        rectangle={{ x: 100, y: 100, width: 640, height: 480 }}
        submitting={false}
        onCancel={vi.fn()}
        onSend={send}
      />
    )

    expect(screen.getByRole('toolbar', { name: 'Screenshot editing tools' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Arrow' }).getAttribute('aria-pressed')).toBe('true')
    for (const name of ['Rectangle', 'Draw', 'Text', 'Blur', 'Redact', 'Undo', 'Redo', 'Clear edits', 'Cancel capture', 'Send screenshot']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('button', { name: 'Text' }))
    expect(screen.getByRole('status').textContent).toContain('Click the capture to place text')
    const canvas = screen.getByLabelText('Selected screenshot editing canvas') as HTMLCanvasElement
    canvas.setPointerCapture = vi.fn()
    canvas.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 640,
      bottom: 480,
      width: 640,
      height: 480,
      toJSON: () => ({})
    })
    fireEvent.pointerDown(canvas, { button: 0, clientX: 320, clientY: 120, pointerId: 1 })
    const input = screen.getByRole('textbox', { name: 'Annotation text' })
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.change(input, { target: { value: 'Important' } })
    const move = screen.getByRole('button', { name: 'Move text annotation' }) as HTMLButtonElement
    move.setPointerCapture = vi.fn()
    move.hasPointerCapture = () => true
    move.releasePointerCapture = vi.fn()
    fireEvent.pointerDown(move, { clientX: 320, clientY: 120, pointerId: 2 })
    fireEvent.pointerMove(move, { clientX: 400, clientY: 240, pointerId: 2 })
    fireEvent.pointerUp(move, { clientX: 400, clientY: 240, pointerId: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'Add text annotation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send screenshot' }))
    expect(send).toHaveBeenCalledWith([
      expect.objectContaining({
        tool: 'text',
        text: 'Important',
        points: [{ x: 0.625, y: 0.5 }]
      })
    ])
  })
})
