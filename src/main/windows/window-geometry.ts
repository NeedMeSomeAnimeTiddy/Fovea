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
  const available = normalizeWorkArea(workArea)
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

export function placeWindowAdjacentToSelection(
  selectionBounds: Rectangle,
  windowSize: Size,
  workArea: Rectangle,
  gap = 12
): Rectangle {
  const available = normalizeWorkArea(workArea)
  const requested = normalizeSize(windowSize)
  const safeGap = normalizeGap(gap)
  const width = Math.min(requested.width, available.width)
  const height = Math.min(requested.height, available.height)
  let x = Math.round(selectionBounds.x + selectionBounds.width + safeGap)

  if (x + width > available.x + available.width) {
    x = Math.round(selectionBounds.x - width - safeGap)
  }

  return fitBoundsToWorkArea(
    { x, y: Math.round(selectionBounds.y), width, height },
    available
  )
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
    startBounds: normalizeBounds(startBounds),
    startCursor: normalizePoint(startCursor)
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
  const start = normalizeBounds(session.startBounds)
  const startCursor = normalizePoint(session.startCursor)
  const currentCursor = normalizePoint(cursor)
  const fixedLeft = start.x
  const fixedTop = start.y
  const fixedRight = start.x + start.width
  const fixedBottom = start.y + start.height
  const deltaX = currentCursor.x - startCursor.x
  const deltaY = currentCursor.y - startCursor.y

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
  return workArea ?? normalizeBounds(currentBounds)
}

export function recoverRestoreBounds(restoreBounds: Rectangle, workAreas: readonly Rectangle[]): Rectangle {
  const normalizedBounds = normalizeBounds(restoreBounds)
  if (workAreas.length === 0 || isBoundsReachable(normalizedBounds, workAreas)) {
    return normalizedBounds
  }

  const workArea = selectWorkArea(normalizedBounds, workAreas)
  return workArea ? fitBoundsToWorkArea(normalizedBounds, workArea) : normalizedBounds
}

/**
 * Re-fits saved floating bounds after Windows changes display membership, work
 * area, or scale. Unlike normal restore recovery this deliberately contains the
 * complete window in its best current work area, because the previous DIP
 * rectangle was measured against display metrics that are no longer valid.
 */
export function refitBoundsToWorkAreas(bounds: Rectangle, workAreas: readonly Rectangle[]): Rectangle {
  const normalizedBounds = normalizeBounds(bounds)
  const workArea = selectWorkArea(normalizedBounds, workAreas)
  return workArea ? fitBoundsToWorkArea(normalizedBounds, workArea) : normalizedBounds
}

export function fitBoundsToWorkArea(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const available = normalizeWorkArea(workArea)
  const requested = normalizeBounds(bounds)
  const width = Math.min(requested.width, available.width)
  const height = Math.min(requested.height, available.height)
  const maximumX = available.x + available.width - width
  const maximumY = available.y + available.height - height

  return {
    x: Math.round(clamp(requested.x, available.x, maximumX)),
    y: Math.round(clamp(requested.y, available.y, maximumY)),
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
  const normalizedBounds = normalizeBounds(bounds)
  const titleBar = {
    x: normalizedBounds.x,
    y: normalizedBounds.y,
    width: normalizedBounds.width,
    height: Math.min(normalizedBounds.height, normalizeDimension(titleBarHeight))
  }
  const requiredWidth = Math.min(titleBar.width, normalizeDimension(reachableTitleBarWidth))

  return workAreas.some((workArea) => {
    const overlap = intersection(titleBar, normalizeWorkArea(workArea))
    return overlap.width >= requiredWidth && overlap.height > 0
  })
}

export function selectWorkArea(bounds: Rectangle, workAreas: readonly Rectangle[]): Rectangle | null {
  if (workAreas.length === 0) return null

  const normalizedBounds = normalizeBounds(bounds)
  let bestArea = normalizeWorkArea(workAreas[0]!)
  let bestOverlap = intersectionArea(normalizedBounds, bestArea)
  let bestDistance = rectangleDistanceSquared(normalizedBounds, bestArea)

  for (const workArea of workAreas.slice(1)) {
    const normalizedWorkArea = normalizeWorkArea(workArea)
    const overlap = intersectionArea(normalizedBounds, normalizedWorkArea)
    const distance = rectangleDistanceSquared(normalizedBounds, normalizedWorkArea)
    if (overlap > bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
      bestArea = normalizedWorkArea
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

function normalizeGap(gap: number): number {
  if (!Number.isFinite(gap) || gap < 0) throw new RangeError('Window placement gap must be non-negative.')
  return Math.round(gap)
}

function normalizeSize(size: Size): Size {
  return {
    width: normalizeDimension(size.width),
    height: normalizeDimension(size.height)
  }
}

function normalizeBounds(bounds: Rectangle): Rectangle {
  return {
    x: normalizeCoordinate(bounds.x),
    y: normalizeCoordinate(bounds.y),
    width: normalizeDimension(bounds.width),
    height: normalizeDimension(bounds.height)
  }
}

function normalizeWorkArea(workArea: Rectangle): Rectangle {
  const x = requireCoordinate(workArea.x)
  const y = requireCoordinate(workArea.y)
  const width = requireDimension(workArea.width)
  const height = requireDimension(workArea.height)
  const left = Math.ceil(x)
  const top = Math.ceil(y)
  const right = Math.max(left + 1, Math.floor(x + width))
  const bottom = Math.max(top + 1, Math.floor(y + height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function normalizePoint(point: Point): Point {
  return { x: requireCoordinate(point.x), y: requireCoordinate(point.y) }
}

function normalizeCoordinate(value: number): number {
  return Math.round(requireCoordinate(value))
}

function requireCoordinate(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Window coordinates must be finite numbers.')
  return value
}

function requireDimension(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('Window dimensions must be positive numbers.')
  return value
}

function normalizeDimension(value: number): number {
  return Math.max(1, Math.round(requireDimension(value)))
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
