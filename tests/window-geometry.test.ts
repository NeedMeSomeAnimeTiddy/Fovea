import { describe, expect, it } from 'vitest'
import { WINDOW_RESIZE_EDGES, type WindowResizeEdge } from '../src/shared/contracts/ipc'
import type { Point, Rectangle } from '../src/shared/types/geometry'
import { getWindowAppearanceSizes, WINDOW_SURFACE_INSET } from '../src/main/windows/window-appearance'
import {
  containsPoint,
  createResizeSession,
  fitWindowSizesToWorkArea,
  getResizeEdgeAtPoint,
  getResizeRegions,
  getVisibleSurfaceBounds,
  getWorkAreaMaximizedBounds,
  recoverRestoreBounds,
  resizeBoundsFromCursor
} from '../src/main/windows/window-geometry'

describe('window appearance geometry', () => {
  const settingsSizes = {
    surfaceSize: { width: 650, height: 760 },
    minimumSurfaceSize: { width: 560, height: 640 }
  }

  it('derives transparent outer sizes and preserves solid surface sizes', () => {
    expect(getWindowAppearanceSizes(settingsSizes, 'transparent')).toEqual({
      material: 'transparent',
      inset: 12,
      size: { width: 674, height: 784 },
      minimumSize: { width: 584, height: 664 }
    })
    expect(getWindowAppearanceSizes(settingsSizes, 'solid')).toEqual({
      material: 'solid',
      inset: 0,
      size: { width: 650, height: 760 },
      minimumSize: { width: 560, height: 640 }
    })
  })

  it('fits desired and minimum outer sizes to small work areas', () => {
    const workArea = { x: -500, y: 40, width: 500, height: 600 }
    expect(getWindowAppearanceSizes(settingsSizes, 'transparent', workArea)).toEqual({
      material: 'transparent',
      inset: 12,
      size: { width: 500, height: 600 },
      minimumSize: { width: 500, height: 600 }
    })
    expect(
      fitWindowSizesToWorkArea(
        { width: 400, height: 300 },
        { width: 450, height: 350 },
        { x: 0, y: 0, width: 800, height: 700 }
      )
    ).toEqual({ size: { width: 450, height: 350 }, minimumSize: { width: 450, height: 350 } })
  })
})

describe('12px resize-region partition', () => {
  const outerSize = { width: 61, height: 53 }
  const regions = getResizeRegions(outerSize, WINDOW_SURFACE_INSET)
  const surface = getVisibleSurfaceBounds(outerSize, WINDOW_SURFACE_INSET)

  it('assigns every logical inset point to exactly one of the eight regions', () => {
    const counts = new Map<WindowResizeEdge, number>()
    for (const edge of WINDOW_RESIZE_EDGES) counts.set(edge, 0)

    for (let y = 0; y < outerSize.height; y += 1) {
      for (let x = 0; x < outerSize.width; x += 1) {
        const point = { x, y }
        const matchingEdges = WINDOW_RESIZE_EDGES.filter((edge) => containsPoint(regions[edge], point))
        const isInsetPoint = !containsPoint(surface, point)
        expect(matchingEdges).toHaveLength(isInsetPoint ? 1 : 0)
        expect(getResizeEdgeAtPoint(point, outerSize, WINDOW_SURFACE_INSET)).toBe(matchingEdges[0] ?? null)
        if (matchingEdges[0]) counts.set(matchingEdges[0], counts.get(matchingEdges[0])! + 1)
      }
    }

    for (const edge of WINDOW_RESIZE_EDGES) expect(counts.get(edge)).toBeGreaterThan(0)
  })

  it('keeps every resize region outside the visible surface', () => {
    for (const edge of WINDOW_RESIZE_EDGES) {
      const region = regions[edge]
      for (let y = region.y; y < region.y + region.height; y += 1) {
        for (let x = region.x; x < region.x + region.width; x += 1) {
          expect(containsPoint(surface, { x, y })).toBe(false)
        }
      }
    }
  })
})

describe('custom resize geometry', () => {
  const startBounds = { x: -200, y: -100, width: 300, height: 200 }
  const startCursor = { x: -50, y: 20 }
  const movedCursor = { x: -20, y: 60 }
  const minimumSize = { width: 100, height: 80 }
  const expectedByEdge: Record<WindowResizeEdge, Rectangle> = {
    top: { x: -200, y: -60, width: 300, height: 160 },
    right: { x: -200, y: -100, width: 330, height: 200 },
    bottom: { x: -200, y: -100, width: 300, height: 240 },
    left: { x: -170, y: -100, width: 270, height: 200 },
    'top-left': { x: -170, y: -60, width: 270, height: 160 },
    'top-right': { x: -200, y: -60, width: 330, height: 160 },
    'bottom-right': { x: -200, y: -100, width: 330, height: 240 },
    'bottom-left': { x: -170, y: -100, width: 270, height: 240 }
  }

  it.each(WINDOW_RESIZE_EDGES)('resizes %s with negative desktop coordinates', (edge) => {
    const session = createResizeSession(edge, startBounds, startCursor)
    expect(resizeBoundsFromCursor(session, movedCursor, minimumSize)).toEqual(expectedByEdge[edge])
  })

  it.each([
    ['top', { x: 0, y: 1000 }],
    ['right', { x: -1000, y: 0 }],
    ['bottom', { x: 0, y: -1000 }],
    ['left', { x: 1000, y: 0 }],
    ['top-left', { x: 1000, y: 1000 }],
    ['top-right', { x: -1000, y: 1000 }],
    ['bottom-right', { x: -1000, y: -1000 }],
    ['bottom-left', { x: 1000, y: -1000 }]
  ] satisfies Array<[WindowResizeEdge, Point]>)('clamps minimum size from %s and preserves opposite edges', (edge, cursor) => {
    const bounds = { x: 10, y: 20, width: 300, height: 200 }
    const resized = resizeBoundsFromCursor(
      createResizeSession(edge, bounds, { x: 0, y: 0 }),
      cursor,
      { width: 250, height: 160 }
    )!

    if (edge.includes('left') || edge.includes('right')) {
      expect(resized.width).toBeGreaterThanOrEqual(250)
    }
    if (edge.includes('right') || edge === 'right') expect(resized.x).toBe(bounds.x)
    if (edge.includes('left') || edge === 'left') expect(resized.x + resized.width).toBe(bounds.x + bounds.width)
    if (edge.includes('top') || edge === 'top') expect(resized.y + resized.height).toBe(bounds.y + bounds.height)
    if (edge.includes('bottom') || edge === 'bottom') expect(resized.y).toBe(bounds.y)
    if (edge.includes('top') || edge.includes('bottom') || edge === 'top' || edge === 'bottom') {
      expect(resized.height).toBeGreaterThanOrEqual(160)
    }
  })

  it('rounds fractional DIP cursor deltas into consistent integer bounds', () => {
    const fractionalStart = { x: -201, y: -101, width: 301, height: 201 }
    const cursor = { x: -12.25, y: 44.75 }
    const bottomRight = resizeBoundsFromCursor(
      createResizeSession('bottom-right', fractionalStart, cursor),
      { x: cursor.x + 10.6, y: cursor.y + 20.4 },
      minimumSize
    )!
    const topLeft = resizeBoundsFromCursor(
      createResizeSession('top-left', fractionalStart, cursor),
      { x: cursor.x - 10.6, y: cursor.y - 20.4 },
      minimumSize
    )!

    expect(bottomRight).toEqual({ x: -201, y: -101, width: 312, height: 221 })
    expect(topLeft).toEqual({ x: -212, y: -121, width: 312, height: 221 })
    for (const value of [...Object.values(bottomRight), ...Object.values(topLeft)]) {
      expect(Number.isInteger(value)).toBe(true)
    }
  })

  it('does not produce an update without an active resize session', () => {
    expect(resizeBoundsFromCursor(null, { x: 50, y: 60 }, minimumSize)).toBeNull()
  })
})

describe('maximize and restore geometry', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 }
  const secondary = { x: -1600, y: -120, width: 1600, height: 900 }

  it('uses the matching display work area for application maximize', () => {
    expect(
      getWorkAreaMaximizedBounds({ x: -1200, y: 40, width: 500, height: 600 }, [primary, secondary])
    ).toEqual(secondary)
  })

  it('preserves exact reachable restore bounds, including negative coordinates', () => {
    const saved = { x: -1550, y: -80, width: 700, height: 650 }
    expect(recoverRestoreBounds(saved, [primary, secondary])).toEqual(saved)
    expect(recoverRestoreBounds(saved, [primary, secondary])).not.toBe(saved)
  })

  it('recovers restore bounds onto a remaining display after display removal', () => {
    const saved = { x: -1500, y: 100, width: 600, height: 500 }
    expect(recoverRestoreBounds(saved, [primary])).toEqual({ x: 0, y: 100, width: 600, height: 500 })
  })

  it('shrinks oversized restore bounds to a small remaining work area', () => {
    const saved = { x: 2200, y: -200, width: 900, height: 800 }
    const smallWorkArea = { x: 0, y: 40, width: 640, height: 600 }
    expect(recoverRestoreBounds(saved, [smallWorkArea])).toEqual({ x: 0, y: 40, width: 640, height: 600 })
  })
})
