import type { Rectangle, Size } from '@shared/types/geometry'

export function normalizeRectangle(startX: number, startY: number, endX: number, endY: number): Rectangle {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY)
  }
}

export function logicalToPhysical(rectangle: Rectangle, scaleX: number, scaleY = scaleX): Rectangle {
  const left = Math.round(rectangle.x * scaleX)
  const top = Math.round(rectangle.y * scaleY)
  const right = Math.round((rectangle.x + rectangle.width) * scaleX)
  const bottom = Math.round((rectangle.y + rectangle.height) * scaleY)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function clampCropRectangle(rectangle: Rectangle, image: Size): Rectangle {
  const left = Math.max(0, Math.min(image.width, Math.floor(rectangle.x)))
  const top = Math.max(0, Math.min(image.height, Math.floor(rectangle.y)))
  const right = Math.max(left, Math.min(image.width, Math.ceil(rectangle.x + rectangle.width)))
  const bottom = Math.max(top, Math.min(image.height, Math.ceil(rectangle.y + rectangle.height)))
  return { x: left, y: top, width: right - left, height: bottom - top }
}
