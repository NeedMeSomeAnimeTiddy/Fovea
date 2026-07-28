import type { Point, Rectangle } from '@shared/types/geometry'

export type ResizeCorner = 'nw' | 'ne' | 'se' | 'sw'

export function resizeCaptureRectangle(
  original: Rectangle,
  corner: ResizeCorner,
  point: Point,
  bounds: { width: number; height: number },
  minimumSize: number
): Rectangle {
  const left = original.x
  const top = original.y
  const right = original.x + original.width
  const bottom = original.y + original.height
  if (corner === 'nw') {
    const x = clamp(point.x, 0, right - minimumSize)
    const y = clamp(point.y, 0, bottom - minimumSize)
    return { x, y, width: right - x, height: bottom - y }
  }
  if (corner === 'ne') {
    const nextRight = clamp(point.x, left + minimumSize, bounds.width)
    const y = clamp(point.y, 0, bottom - minimumSize)
    return { x: left, y, width: nextRight - left, height: bottom - y }
  }
  if (corner === 'sw') {
    const x = clamp(point.x, 0, right - minimumSize)
    const nextBottom = clamp(point.y, top + minimumSize, bounds.height)
    return { x, y: top, width: right - x, height: nextBottom - top }
  }
  const nextRight = clamp(point.x, left + minimumSize, bounds.width)
  const nextBottom = clamp(point.y, top + minimumSize, bounds.height)
  return { x: left, y: top, width: nextRight - left, height: nextBottom - top }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
