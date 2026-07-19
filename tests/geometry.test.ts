import { describe, expect, it } from 'vitest'
import { clampCropRectangle, logicalToPhysical, normalizeRectangle } from '../src/main/capture/geometry'

describe('capture geometry', () => {
  it('normalises rectangles dragged in any direction', () => {
    expect(normalizeRectangle(100, 80, 20, 10)).toEqual({ x: 20, y: 10, width: 80, height: 70 })
  })

  it('converts logical edges to physical pixels without cumulative rounding error', () => {
    expect(logicalToPhysical({ x: 10, y: 11, width: 21, height: 17 }, 1.5)).toEqual({
      x: 15,
      y: 17,
      width: 32,
      height: 25
    })
  })

  it('clamps crop boundaries to the source image', () => {
    expect(clampCropRectangle({ x: -5, y: 90, width: 120, height: 30 }, { width: 100, height: 100 })).toEqual({
      x: 0,
      y: 90,
      width: 100,
      height: 10
    })
  })
})
