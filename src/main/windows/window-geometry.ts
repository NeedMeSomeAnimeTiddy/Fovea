import type { WindowMaterial, WindowResizeEdge } from '@shared/contracts/ipc'
import type { Point, Rectangle, Size } from '@shared/types/geometry'

export interface ResizeSession {
  edge: WindowResizeEdge
  startBounds: Rectangle
  startCursor: Point
}

export interface FittedWindowSizes {
  size: Size
  minimumSize: Size
}

export type ResizeRegions = Record<WindowResizeEdge, Rectangle>

const DEFAULT_REACHABLE_TITLE_BAR_WIDTH = 64
const DEFAULT_TITLE_BAR_HEIGHT = 32

export function deriveOuterSize(surfaceSize: Size, material: WindowMaterial, inset: number): Size {
  const safeSurface = normalizeSize(surfaceSize)
  const safeInset = requireInset(inset)
  const insetTotal = material === 'transparent' ? safeInset * 2 : 0
  return {
    width: safeSurface.width + insetTotal,
    height: safeSurface.height + insetTotal
  }
}

export function fitWindowSizesToWorkArea(
  desiredSize: Size,
  minimumSize: Size,
  workArea: Rectangle
): FittedWindowSizes {
  const available = normalizeSize(workArea)
  const desired = normalizeSize(desiredSize)
  const minimum = normalizeSize(minimumSize)
  const effectiveMinimum = {
    width: Math.min(minimum.width, available.width),
    height: Math.min(minimum.height, available.height)
  }

  return {
    size: {
      width: Math.min(Math.max(desired.width, effectiveMinimum.width), available.width),
      height: Math.min(Math.max(desired.height, effectiveMinimum.height), available.height)
    },
    minimumSize: effectiveMinimum
  }
}

export function getVisibleSurfaceBounds(outerSize: Size, inset: number): Rectangle {
  const size = requireResizeRegionSize(outerSize, inset)
  const safeInset = requireInset(inset)
  return {
    x: safeInset,
    y: safeInset,
    width: size.width - safeInset * 2,
    height: size.height - safeInset * 2
  }
}

export function getResizeRegions(outerSize: Size, inset: number): ResizeRegions {
  const size = requireResizeRegionSize(outerSize, inset)
  const safeInset = requireInset(inset)
  const middleWidth = size.width - safeInset * 2
  const middleHeight = size.height - safeInset * 2

  return {
    top: { x: safeInset, y: 0, width: middleWidth, height: safeInset },
    right: { x: size.width - safeInset, y: safeInset, width: safeInset, height: middleHeight },
    bottom: { x: safeInset, y: size.height - safeInset, width: middleWidth, height: safeInset },
    left: { x: 0, y: safeInset, width: safeInset, height: middleHeight },
    'top-left': { x: 0, y: 0, width: safeInset, height: safeInset },
    'top-right': { x: size.width - safeInset, y: 0, width: safeInset, height: safeInset },
    'bottom-right': {
      x: size.width - safeInset,
      y: size.height - safeInset,
      width: safeInset,
      height: safeInset
    },
    'bottom-left': { x: 0, y: size.height - safeInset, width: safeInset, height: safeInset }
  }
}

export function getResizeEdgeAtPoint(point: Point, outerSize: Size, inset: number): WindowResizeEdge | null {
  const regions = getResizeRegions(outerSize, inset)
  const orderedEdges = Object.keys(regions) as WindowResizeEdge[]
  return orderedEdges.find((edge) => containsPoint(regions[edge], point)) ?? null
}

export function containsPoint(rectangle: Rectangle, point: Point): boolean {
  return (
    point.x >= rectangle.x &&
    point.x < rectangle.x + rectangle.width &&
    point.y >= rectangle.y &&
    point.y < rectangle.y + rectangle.height
  )
}

export function createResizeSession(edge: WindowResizeEdge, startBounds: Rectangle, startCursor: Point): ResizeSession {
  return {
    edge,
    startBounds: copyRectangle(startBounds),
    startCursor: { ...startCursor }
  }
}

export function resizeBoundsFromCursor(
  session: ResizeSession | null,
  cursor: Point,
  minimumSize: Size
): Rectangle | null {
  if (!session) return null

  const minimum = {
    width: Math.ceil(normalizeDimension(minimumSize.width)),
    height: Math.ceil(normalizeDimension(minimumSize.height))
  }
  const start = session.startBounds
  const fixedLeft = start.x
  const fixedTop = start.y
  const fixedRight = start.x + start.width
  const fixedBottom = start.y + start.height
  const deltaX = cursor.x - session.startCursor.x
  const deltaY = cursor.y - session.startCursor.y

  let left = fixedLeft
  let top = fixedTop
  let right = fixedRight
  let bottom = fixedBottom

  if (movesLeft(session.edge)) {
    left = Math.min(Math.round(fixedLeft + deltaX), fixedRight - minimum.width)
  } else if (movesRight(session.edge)) {
    right = Math.max(Math.round(fixedRight + deltaX), fixedLeft + minimum.width)
  }

  if (movesTop(session.edge)) {
    top = Math.min(Math.round(fixedTop + deltaY), fixedBottom - minimum.height)
  } else if (movesBottom(session.edge)) {
    bottom = Math.max(Math.round(fixedBottom + deltaY), fixedTop + minimum.height)
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  }
}

export function getWorkAreaMaximizedBounds(currentBounds: Rectangle, workAreas: readonly Rectangle[]): Rectangle {
  const workArea = selectWorkArea(currentBounds, workAreas)
  return workArea ? copyRectangle(workArea) : copyRectangle(currentBounds)
}

export function recoverRestoreBounds(restoreBounds: Rectangle, workAreas: readonly Rectangle[]): Rectangle {
  if (workAreas.length === 0 || isBoundsReachable(restoreBounds, workAreas)) {
    return copyRectangle(restoreBounds)
  }

  const workArea = selectWorkArea(restoreBounds, workAreas)
  return workArea ? fitBoundsToWorkArea(restoreBounds, workArea) : copyRectangle(restoreBounds)
}

export function fitBoundsToWorkArea(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const available = normalizeSize(workArea)
  const width = Math.min(normalizeDimension(bounds.width), available.width)
  const height = Math.min(normalizeDimension(bounds.height), available.height)
  const maximumX = workArea.x + available.width - width
  const maximumY = workArea.y + available.height - height

  return {
    x: Math.round(clamp(bounds.x, workArea.x, maximumX)),
    y: Math.round(clamp(bounds.y, workArea.y, maximumY)),
    width,
    height
  }
}

export function isBoundsReachable(
  bounds: Rectangle,
  workAreas: readonly Rectangle[],
  reachableTitleBarWidth = DEFAULT_REACHABLE_TITLE_BAR_WIDTH,
  titleBarHeight = DEFAULT_TITLE_BAR_HEIGHT
): boolean {
  const titleBar = {
    x: bounds.x,
    y: bounds.y,
    width: normalizeDimension(bounds.width),
    height: Math.min(normalizeDimension(bounds.height), normalizeDimension(titleBarHeight))
  }
  const requiredWidth = Math.min(titleBar.width, normalizeDimension(reachableTitleBarWidth))

  return workAreas.some((workArea) => {
    const overlap = intersection(titleBar, workArea)
    return overlap.width >= requiredWidth && overlap.height > 0
  })
}

export function selectWorkArea(bounds: Rectangle, workAreas: readonly Rectangle[]): Rectangle | null {
  if (workAreas.length === 0) return null

  let bestArea = workAreas[0]!
  let bestOverlap = intersectionArea(bounds, bestArea)
  let bestDistance = rectangleDistanceSquared(bounds, bestArea)

  for (const workArea of workAreas.slice(1)) {
    const overlap = intersectionArea(bounds, workArea)
    const distance = rectangleDistanceSquared(bounds, workArea)
    if (overlap > bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
      bestArea = workArea
      bestOverlap = overlap
      bestDistance = distance
    }
  }

  return copyRectangle(bestArea)
}

function movesLeft(edge: WindowResizeEdge): boolean {
  return edge === 'left' || edge === 'top-left' || edge === 'bottom-left'
}

function movesRight(edge: WindowResizeEdge): boolean {
  return edge === 'right' || edge === 'top-right' || edge === 'bottom-right'
}

function movesTop(edge: WindowResizeEdge): boolean {
  return edge === 'top' || edge === 'top-left' || edge === 'top-right'
}

function movesBottom(edge: WindowResizeEdge): boolean {
  return edge === 'bottom' || edge === 'bottom-left' || edge === 'bottom-right'
}

function requireResizeRegionSize(size: Size, inset: number): Size {
  const normalized = normalizeSize(size)
  const safeInset = requireInset(inset)
  if (normalized.width < safeInset * 2 || normalized.height < safeInset * 2) {
    throw new RangeError('Window size must be at least twice the resize inset.')
  }
  return normalized
}

function requireInset(inset: number): number {
  if (!Number.isFinite(inset) || inset < 0 || !Number.isInteger(inset)) {
    throw new RangeError('Window inset must be a non-negative integer.')
  }
  return inset
}

function normalizeSize(size: Size): Size {
  return {
    width: normalizeDimension(size.width),
    height: normalizeDimension(size.height)
  }
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('Window dimensions must be positive numbers.')
  return Math.round(value)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum))
}

function intersection(first: Rectangle, second: Rectangle): Rectangle {
  const left = Math.max(first.x, second.x)
  const top = Math.max(first.y, second.y)
  const right = Math.min(first.x + first.width, second.x + second.width)
  const bottom = Math.min(first.y + first.height, second.y + second.height)
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  }
}

function intersectionArea(first: Rectangle, second: Rectangle): number {
  const overlap = intersection(first, second)
  return overlap.width * overlap.height
}

function rectangleDistanceSquared(first: Rectangle, second: Rectangle): number {
  const firstCenterX = first.x + first.width / 2
  const firstCenterY = first.y + first.height / 2
  const closestX = clamp(firstCenterX, second.x, second.x + second.width)
  const closestY = clamp(firstCenterY, second.y, second.y + second.height)
  const deltaX = firstCenterX - closestX
  const deltaY = firstCenterY - closestY
  return deltaX * deltaX + deltaY * deltaY
}

function copyRectangle(rectangle: Rectangle): Rectangle {
  return { ...rectangle }
}
