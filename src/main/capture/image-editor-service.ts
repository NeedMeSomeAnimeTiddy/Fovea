import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { ImageEditOperation, ImageEditPoint } from '@shared/types/app'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'

const ANNOTATION_COLOR = '#ff453a'

export class ImageEditorService {
  constructor(private readonly screenshots: TempScreenshotStore) {}

  async createDerivative(sourcePath: string, rawOperations: ImageEditOperation[]): Promise<string> {
    const operations = validateOperations(rawOperations)
    if (!operations.length) throw new Error('Add at least one edit before saving.')
    let image = await readFile(sourcePath)
    const metadata = await sharp(image).metadata()
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    if (width < 1 || height < 1) throw new Error('The screenshot could not be edited.')

    for (const operation of operations.filter((item) => item.tool === 'blur')) {
      const region = operationRegion(operation.points, width, height)
      if (!region) continue
      const blurred = await sharp(image)
        .extract(region)
        .blur(Math.max(8, Math.min(36, Math.round(Math.min(region.width, region.height) / 8))))
        .png()
        .toBuffer()
      image = await sharp(image)
        .composite([{ input: blurred, left: region.left, top: region.top }])
        .png()
        .toBuffer()
    }

    const drawable = operations.filter((operation) => operation.tool !== 'blur')
    if (drawable.length) {
      image = await sharp(image)
        .composite([{ input: Buffer.from(renderOverlay(drawable, width, height)) }])
        .png()
        .toBuffer()
    }
    return this.screenshots.save(image)
  }
}

function validateOperations(value: unknown): ImageEditOperation[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Invalid screenshot edits.')
  let pointCount = 0
  return value.map((operation): ImageEditOperation => {
    if (!operation || typeof operation !== 'object') throw new Error('Invalid screenshot edit.')
    const candidate = operation as Partial<ImageEditOperation>
    if (!candidate.id || typeof candidate.id !== 'string' || candidate.id.length > 100) throw new Error('Invalid screenshot edit identifier.')
    if (!candidate.tool || !['arrow', 'rectangle', 'freehand', 'text', 'blur', 'redact'].includes(candidate.tool)) throw new Error('Invalid screenshot edit tool.')
    if (!Array.isArray(candidate.points) || candidate.points.length < 1 || candidate.points.length > 5_000) throw new Error('Invalid screenshot edit points.')
    pointCount += candidate.points.length
    if (pointCount > 20_000) throw new Error('The screenshot has too many edit points.')
    const points = candidate.points.map(validatePoint)
    const minimumPoints = candidate.tool === 'text' ? 1 : 2
    if (points.length < minimumPoints) throw new Error('That screenshot edit is incomplete.')
    const text = candidate.tool === 'text'
      ? String(candidate.text ?? '').trim().slice(0, 200)
      : undefined
    if (candidate.tool === 'text' && !text) throw new Error('Text labels cannot be empty.')
    const strokeWidth = typeof candidate.strokeWidth === 'number' && Number.isFinite(candidate.strokeWidth)
      ? Math.max(1, Math.min(48, candidate.strokeWidth))
      : 4
    return { id: candidate.id, tool: candidate.tool, points, ...(text ? { text } : {}), strokeWidth }
  })
}

function validatePoint(value: unknown): ImageEditPoint {
  if (!value || typeof value !== 'object') throw new Error('Invalid screenshot edit point.')
  const point = value as Partial<ImageEditPoint>
  if (typeof point.x !== 'number' || !Number.isFinite(point.x) || typeof point.y !== 'number' || !Number.isFinite(point.y)) {
    throw new Error('Invalid screenshot edit point.')
  }
  return {
    x: Math.max(0, Math.min(1, point.x)),
    y: Math.max(0, Math.min(1, point.y))
  }
}

function operationRegion(points: ImageEditPoint[], width: number, height: number): { left: number; top: number; width: number; height: number } | null {
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last) return null
  const left = Math.max(0, Math.min(width - 1, Math.floor(Math.min(first.x, last.x) * width)))
  const top = Math.max(0, Math.min(height - 1, Math.floor(Math.min(first.y, last.y) * height)))
  const right = Math.max(left + 1, Math.min(width, Math.ceil(Math.max(first.x, last.x) * width)))
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil(Math.max(first.y, last.y) * height)))
  return { left, top, width: right - left, height: bottom - top }
}

function renderOverlay(operations: ImageEditOperation[], width: number, height: number): string {
  const content = operations.map((operation) => renderOperation(operation, width, height)).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="${ANNOTATION_COLOR}" />
      </marker>
    </defs>
    ${content}
  </svg>`
}

function renderOperation(operation: ImageEditOperation, width: number, height: number): string {
  const points = operation.points.map((point) => ({
    x: Math.round(point.x * width),
    y: Math.round(point.y * height)
  }))
  const first = points[0]!
  const last = points.at(-1)!
  const strokeWidth = operation.strokeWidth ?? 4
  if (operation.tool === 'rectangle' || operation.tool === 'redact') {
    const x = Math.min(first.x, last.x)
    const y = Math.min(first.y, last.y)
    const boxWidth = Math.max(1, Math.abs(last.x - first.x))
    const boxHeight = Math.max(1, Math.abs(last.y - first.y))
    return operation.tool === 'redact'
      ? `<rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" fill="#000000" />`
      : `<rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" fill="none" stroke="${ANNOTATION_COLOR}" stroke-width="${strokeWidth}" />`
  }
  if (operation.tool === 'arrow') {
    return `<line x1="${first.x}" y1="${first.y}" x2="${last.x}" y2="${last.y}" stroke="${ANNOTATION_COLOR}" stroke-width="${strokeWidth}" stroke-linecap="round" marker-end="url(#arrowhead)" />`
  }
  if (operation.tool === 'freehand') {
    const coordinates = points.map((point) => `${point.x},${point.y}`).join(' ')
    return `<polyline points="${coordinates}" fill="none" stroke="${ANNOTATION_COLOR}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />`
  }
  if (operation.tool === 'text') {
    const fontSize = Math.max(18, Math.round(strokeWidth * 5))
    return `<text x="${first.x}" y="${first.y}" fill="${ANNOTATION_COLOR}" stroke="#ffffff" stroke-width="${Math.max(1, strokeWidth / 2)}" paint-order="stroke" font-family="Segoe UI, sans-serif" font-size="${fontSize}" font-weight="700">${escapeXml(operation.text ?? '')}</text>`
  }
  return ''
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
