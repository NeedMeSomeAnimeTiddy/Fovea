import { describe, expect, it } from 'vitest'
import { resizeCaptureRectangle } from '../src/renderer/capture-overlay/editor-geometry'

describe('capture editor resizing', () => {
  const original = { x: 100, y: 80, width: 300, height: 200 }
  const bounds = { width: 800, height: 600 }

  it('moves the dragged corner while keeping its opposite corner fixed', () => {
    expect(resizeCaptureRectangle(original, 'nw', { x: 40, y: 20 }, bounds, 24)).toEqual({
      x: 40,
      y: 20,
      width: 360,
      height: 260
    })
    expect(resizeCaptureRectangle(original, 'se', { x: 520, y: 420 }, bounds, 24)).toEqual({
      x: 100,
      y: 80,
      width: 420,
      height: 340
    })
  })

  it('clamps resizing to the screen and minimum capture size', () => {
    expect(resizeCaptureRectangle(original, 'nw', { x: 900, y: 900 }, bounds, 24)).toEqual({
      x: 376,
      y: 256,
      width: 24,
      height: 24
    })
    expect(resizeCaptureRectangle(original, 'se', { x: 1000, y: 1000 }, bounds, 24)).toEqual({
      x: 100,
      y: 80,
      width: 700,
      height: 520
    })
  })
})
