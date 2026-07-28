import type { ImageEditOperation } from '@shared/types/app'
import type { Rectangle } from '@shared/types/geometry'

export function drawEditorCanvas(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  operations: ImageEditOperation[],
  draft: ImageEditOperation | null,
  source?: Rectangle
): void {
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, canvas.width, canvas.height)
  drawSource(context, image, canvas.width, canvas.height, source)
  for (const operation of [...operations, ...(draft ? [draft] : [])]) {
    drawOperation(context, image, operation, canvas.width, canvas.height, source)
  }
}

export function isMeaningfulEdit(operation: ImageEditOperation): boolean {
  const first = operation.points[0]
  const last = operation.points.at(-1)
  if (!first || !last) return false
  return operation.tool === 'freehand'
    ? operation.points.length > 2
    : Math.abs(first.x - last.x) + Math.abs(first.y - last.y) > 0.005
}

function drawSource(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  source?: Rectangle
): void {
  if (source) {
    context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, width, height)
    return
  }
  context.drawImage(image, 0, 0, width, height)
}

function drawOperation(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  operation: ImageEditOperation,
  width: number,
  height: number,
  source?: Rectangle
): void {
  const points = operation.points.map((point) => ({ x: point.x * width, y: point.y * height }))
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last) return
  const lineWidth = operation.strokeWidth ?? 4
  const x = Math.min(first.x, last.x)
  const y = Math.min(first.y, last.y)
  const boxWidth = Math.abs(last.x - first.x)
  const boxHeight = Math.abs(last.y - first.y)
  context.save()
  if (operation.tool === 'blur') {
    context.beginPath()
    context.rect(x, y, boxWidth, boxHeight)
    context.clip()
    context.filter = 'blur(16px)'
    drawSource(context, image, width, height, source)
    context.restore()
    return
  }
  if (operation.tool === 'redact') {
    context.fillStyle = 'black'
    context.fillRect(x, y, boxWidth, boxHeight)
    context.restore()
    return
  }
  context.strokeStyle = designColor('--fovea-color-danger')
  context.fillStyle = designColor('--fovea-color-danger')
  context.lineWidth = lineWidth
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (operation.tool === 'rectangle') context.strokeRect(x, y, boxWidth, boxHeight)
  if (operation.tool === 'freehand') {
    context.beginPath()
    points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y))
    context.stroke()
  }
  if (operation.tool === 'arrow') {
    const angle = Math.atan2(last.y - first.y, last.x - first.x)
    const head = Math.max(14, lineWidth * 4)
    context.beginPath()
    context.moveTo(first.x, first.y)
    context.lineTo(last.x, last.y)
    context.stroke()
    context.beginPath()
    context.moveTo(last.x, last.y)
    context.lineTo(last.x - head * Math.cos(angle - Math.PI / 6), last.y - head * Math.sin(angle - Math.PI / 6))
    context.lineTo(last.x - head * Math.cos(angle + Math.PI / 6), last.y - head * Math.sin(angle + Math.PI / 6))
    context.closePath()
    context.fill()
  }
  if (operation.tool === 'text') {
    const fontSize = Math.max(18, lineWidth * 5)
    context.font = `700 ${fontSize}px "Segoe UI", sans-serif`
    context.lineWidth = Math.max(2, lineWidth / 2)
    context.strokeStyle = designColor('--fovea-color-on-danger')
    context.strokeText(operation.text ?? '', first.x, first.y)
    context.fillText(operation.text ?? '', first.x, first.y)
  }
  context.restore()
}

function designColor(token: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim()
}
