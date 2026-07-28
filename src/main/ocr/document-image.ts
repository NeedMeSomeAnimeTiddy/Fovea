import sharp from 'sharp'
import type { OcrImageSize } from './ocr-service'

const ANALYSIS_DIMENSION = 640
const MAX_OUTPUT_DIMENSION = 2_400
const MAX_OUTPUT_PIXELS = 8_000_000
const MIN_DESKEW_ANGLE = 0.65
const MAX_DESKEW_ANGLE = 7

interface Point {
  x: number
  y: number
}

interface Quad {
  topLeft: Point
  topRight: Point
  bottomRight: Point
  bottomLeft: Point
}

export interface CorrectedOcrImage {
  image: Buffer
  size: OcrImageSize
  correction: 'none' | 'deskewed' | 'perspective-corrected'
  angle: number
}

export async function correctOcrGeometry(image: Buffer, size: OcrImageSize): Promise<CorrectedOcrImage> {
  try {
    const analysis = await sharp(image)
      .resize({ width: ANALYSIS_DIMENSION, height: ANALYSIS_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const pixels = Uint8Array.from(analysis.data)
    const quad = detectDocumentQuad(pixels, analysis.info.width, analysis.info.height)
    if (quad && hasPerspectiveDistortion(quad)) {
      const corrected = await warpDocument(image, quad, {
        width: analysis.info.width,
        height: analysis.info.height
      })
      if (corrected) return corrected
    }

    const documentAngle = quad ? averageDocumentAngle(quad) : null
    const estimated = documentAngle !== null && Math.abs(documentAngle) <= MAX_DESKEW_ANGLE
      ? { angle: documentAngle, confidence: 1.2 }
      : estimateTextSkew(pixels, analysis.info.width, analysis.info.height)
    if (
      Math.abs(estimated.angle) < MIN_DESKEW_ANGLE ||
      Math.abs(estimated.angle) > MAX_DESKEW_ANGLE ||
      estimated.confidence < 1.045
    ) {
      return { image, size: normaliseSize(size), correction: 'none', angle: 0 }
    }

    const background = cornerMean(pixels, analysis.info.width, analysis.info.height) >= 128
      ? { r: 255, g: 255, b: 255, alpha: 1 }
      : { r: 0, g: 0, b: 0, alpha: 1 }
    const rotated = await sharp(image)
      .rotate(-estimated.angle, { background })
      .png()
      .toBuffer({ resolveWithObject: true })
    return {
      image: rotated.data,
      size: { width: rotated.info.width, height: rotated.info.height },
      correction: 'deskewed',
      angle: estimated.angle
    }
  } catch {
    return { image, size: normaliseSize(size), correction: 'none', angle: 0 }
  }
}

export function estimateTextSkew(
  pixels: Uint8Array,
  width: number,
  height: number
): { angle: number; confidence: number } {
  if (width < 80 || height < 40 || pixels.length < width * height) return { angle: 0, confidence: 0 }
  const threshold = otsuThreshold(pixels)
  const lightBackground = mean(pixels) >= 128
  const foreground = (value: number): boolean => lightBackground ? value <= threshold : value >= threshold
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 30_000)))
  const points: Point[] = []
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const index = y * width + x
      if (!foreground(pixels[index]!)) continue
      if (
        foreground(pixels[index - 1]!) &&
        foreground(pixels[index + 1]!) &&
        foreground(pixels[index - width]!) &&
        foreground(pixels[index + width]!)
      ) continue
      points.push({ x, y })
    }
  }
  if (points.length < 120 || points.length > (width * height) / Math.max(1, step * step) * 0.65) {
    return { angle: 0, confidence: 0 }
  }

  const score = (angle: number): number => {
    const tangent = Math.tan(angle * Math.PI / 180)
    const offset = Math.ceil(Math.abs(tangent) * width) + 2
    const bins = new Uint32Array(height + offset * 2 + 2)
    for (const point of points) {
      const row = Math.round(point.y - (point.x - width / 2) * tangent) + offset
      if (row >= 0 && row < bins.length) bins[row] = bins[row]! + 1
    }
    let total = 0
    for (const count of bins) total += count * count
    return total / points.length
  }

  const baseline = score(0)
  let bestAngle = 0
  let bestScore = baseline
  for (let angle = -MAX_DESKEW_ANGLE; angle <= MAX_DESKEW_ANGLE; angle += 0.25) {
    const candidate = score(angle)
    if (candidate > bestScore) {
      bestAngle = angle
      bestScore = candidate
    }
  }
  return { angle: bestAngle, confidence: baseline > 0 ? bestScore / baseline : 0 }
}

export function detectDocumentQuad(pixels: Uint8Array, width: number, height: number): Quad | null {
  if (width < 120 || height < 120) return null
  const background = cornerStatistics(pixels, width, height)
  const differenceThreshold = Math.max(24, background.deviation * 3.5)
  const mask = new Uint8Array(width * height)
  let foregroundCount = 0
  for (let index = 0; index < pixels.length; index += 1) {
    if (Math.abs(pixels[index]! - background.mean) < differenceThreshold) continue
    mask[index] = 1
    foregroundCount += 1
  }
  const ratio = foregroundCount / mask.length
  if (ratio < 0.15 || ratio > 0.9) return null

  const left: Point[] = []
  const right: Point[] = []
  for (let y = 0; y < height; y += 1) {
    let first = -1
    let last = -1
    let count = 0
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue
      if (first < 0) first = x
      last = x
      count += 1
    }
    if (count < Math.max(12, width * 0.08)) continue
    left.push({ x: first, y })
    right.push({ x: last, y })
  }

  const top: Point[] = []
  const bottom: Point[] = []
  for (let x = 0; x < width; x += 1) {
    let first = -1
    let last = -1
    let count = 0
    for (let y = 0; y < height; y += 1) {
      if (!mask[y * width + x]) continue
      if (first < 0) first = y
      last = y
      count += 1
    }
    if (count < Math.max(12, height * 0.08)) continue
    top.push({ x, y: first })
    bottom.push({ x, y: last })
  }
  if (
    left.length < height * 0.35 ||
    right.length < height * 0.35 ||
    top.length < width * 0.35 ||
    bottom.length < width * 0.35
  ) return null

  const leftLine = fitXFromY(left)
  const rightLine = fitXFromY(right)
  const topLine = fitYFromX(top)
  const bottomLine = fitYFromX(bottom)
  if (!leftLine || !rightLine || !topLine || !bottomLine) return null
  const tolerance = Math.max(width, height) * 0.035
  if ([leftLine.error, rightLine.error, topLine.error, bottomLine.error].some((error) => error > tolerance)) return null

  const quad = {
    topLeft: intersect(leftLine, topLine),
    topRight: intersect(rightLine, topLine),
    bottomRight: intersect(rightLine, bottomLine),
    bottomLeft: intersect(leftLine, bottomLine)
  }
  if (Object.values(quad).some((point) => !point || point.x < -width * 0.1 || point.x > width * 1.1 || point.y < -height * 0.1 || point.y > height * 1.1)) {
    return null
  }
  const areaRatio = polygonArea(quad) / (width * height)
  return areaRatio >= 0.22 && areaRatio <= 0.94 ? quad : null
}

function hasPerspectiveDistortion(quad: Quad): boolean {
  const topWidth = distance(quad.topLeft, quad.topRight)
  const bottomWidth = distance(quad.bottomLeft, quad.bottomRight)
  const leftHeight = distance(quad.topLeft, quad.bottomLeft)
  const rightHeight = distance(quad.topRight, quad.bottomRight)
  const widthDifference = Math.abs(topWidth - bottomWidth) / Math.max(topWidth, bottomWidth)
  const heightDifference = Math.abs(leftHeight - rightHeight) / Math.max(leftHeight, rightHeight)
  const topAngle = lineAngle(quad.topLeft, quad.topRight)
  const bottomAngle = lineAngle(quad.bottomLeft, quad.bottomRight)
  return widthDifference > 0.055 || heightDifference > 0.055 || angleDifference(topAngle, bottomAngle) > 1.5
}

async function warpDocument(
  image: Buffer,
  analysisQuad: Quad,
  analysisSize: OcrImageSize
): Promise<CorrectedOcrImage | null> {
  const source = await sharp(image)
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const scaleX = source.info.width / analysisSize.width
  const scaleY = source.info.height / analysisSize.height
  const quad = mapQuad(analysisQuad, ({ x, y }) => ({ x: x * scaleX, y: y * scaleY }))
  const naturalWidth = Math.max(1, Math.round((distance(quad.topLeft, quad.topRight) + distance(quad.bottomLeft, quad.bottomRight)) / 2))
  const naturalHeight = Math.max(1, Math.round((distance(quad.topLeft, quad.bottomLeft) + distance(quad.topRight, quad.bottomRight)) / 2))
  const outputScale = Math.min(
    1,
    MAX_OUTPUT_DIMENSION / naturalWidth,
    MAX_OUTPUT_DIMENSION / naturalHeight,
    Math.sqrt(MAX_OUTPUT_PIXELS / (naturalWidth * naturalHeight))
  )
  const width = Math.max(1, Math.round(naturalWidth * outputScale))
  const height = Math.max(1, Math.round(naturalHeight * outputScale))
  if (width < 80 || height < 80) return null

  const output = Buffer.allocUnsafe(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const v = height === 1 ? 0 : y / (height - 1)
    for (let x = 0; x < width; x += 1) {
      const u = width === 1 ? 0 : x / (width - 1)
      const sourcePoint = bilinearQuadPoint(quad, u, v)
      sampleRgb(source.data, source.info.width, source.info.height, sourcePoint.x, sourcePoint.y, output, (y * width + x) * 3)
    }
  }
  return {
    image: await sharp(output, { raw: { width, height, channels: 3 } }).png().toBuffer(),
    size: { width, height },
    correction: 'perspective-corrected',
    angle: averageDocumentAngle(analysisQuad)
  }
}

function bilinearQuadPoint(quad: Quad, u: number, v: number): Point {
  const top = interpolate(quad.topLeft, quad.topRight, u)
  const bottom = interpolate(quad.bottomLeft, quad.bottomRight, u)
  return interpolate(top, bottom, v)
}

function sampleRgb(
  source: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  output: Buffer,
  outputOffset: number
): void {
  const boundedX = Math.min(width - 1, Math.max(0, x))
  const boundedY = Math.min(height - 1, Math.max(0, y))
  const x0 = Math.floor(boundedX)
  const y0 = Math.floor(boundedY)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const dx = boundedX - x0
  const dy = boundedY - y0
  for (let channel = 0; channel < 3; channel += 1) {
    const top = source[(y0 * width + x0) * 3 + channel]! * (1 - dx) + source[(y0 * width + x1) * 3 + channel]! * dx
    const bottom = source[(y1 * width + x0) * 3 + channel]! * (1 - dx) + source[(y1 * width + x1) * 3 + channel]! * dx
    output[outputOffset + channel] = Math.round(top * (1 - dy) + bottom * dy)
  }
}

function fitXFromY(points: Point[]): { slope: number; intercept: number; error: number } | null {
  return robustLinearFit(points.map(({ x, y }) => ({ independent: y, dependent: x })))
}

function fitYFromX(points: Point[]): { slope: number; intercept: number; error: number } | null {
  return robustLinearFit(points.map(({ x, y }) => ({ independent: x, dependent: y })))
}

function robustLinearFit(
  points: Array<{ independent: number; dependent: number }>
): { slope: number; intercept: number; error: number } | null {
  if (points.length < 2) return null
  const stride = Math.max(1, Math.floor(points.length / 28))
  let bestInliers: Array<{ independent: number; dependent: number }> = []
  for (let first = 0; first < points.length; first += stride) {
    for (let second = first + stride; second < points.length; second += stride) {
      const left = points[first]!
      const right = points[second]!
      const difference = right.independent - left.independent
      if (Math.abs(difference) < 8) continue
      const slope = (right.dependent - left.dependent) / difference
      const intercept = left.dependent - slope * left.independent
      const inliers = points.filter((point) => Math.abs(point.dependent - (slope * point.independent + intercept)) <= 2.5)
      if (inliers.length > bestInliers.length) bestInliers = inliers
    }
  }
  if (bestInliers.length < points.length * 0.42) return null
  return linearFit(bestInliers)
}

function linearFit(points: Array<{ independent: number; dependent: number }>): { slope: number; intercept: number; error: number } | null {
  if (points.length < 2) return null
  const independentMean = points.reduce((sum, point) => sum + point.independent, 0) / points.length
  const dependentMean = points.reduce((sum, point) => sum + point.dependent, 0) / points.length
  let numerator = 0
  let denominator = 0
  for (const point of points) {
    numerator += (point.independent - independentMean) * (point.dependent - dependentMean)
    denominator += (point.independent - independentMean) ** 2
  }
  if (denominator === 0) return null
  const slope = numerator / denominator
  const intercept = dependentMean - slope * independentMean
  const error = Math.sqrt(points.reduce((sum, point) => {
    const residual = point.dependent - (slope * point.independent + intercept)
    return sum + residual * residual
  }, 0) / points.length)
  return { slope, intercept, error }
}

function intersect(
  vertical: { slope: number; intercept: number },
  horizontal: { slope: number; intercept: number }
): Point {
  const denominator = 1 - vertical.slope * horizontal.slope
  const x = Math.abs(denominator) < 0.0001
    ? vertical.intercept
    : (vertical.slope * horizontal.intercept + vertical.intercept) / denominator
  return { x, y: horizontal.slope * x + horizontal.intercept }
}

function cornerStatistics(pixels: Uint8Array, width: number, height: number): { mean: number; deviation: number } {
  const patchWidth = Math.max(3, Math.floor(width * 0.08))
  const patchHeight = Math.max(3, Math.floor(height * 0.08))
  const samples: number[] = []
  for (const originX of [0, width - patchWidth]) {
    for (const originY of [0, height - patchHeight]) {
      for (let y = originY; y < originY + patchHeight; y += 2) {
        for (let x = originX; x < originX + patchWidth; x += 2) samples.push(pixels[y * width + x]!)
      }
    }
  }
  const average = mean(samples)
  const deviation = Math.sqrt(samples.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(1, samples.length))
  return { mean: average, deviation }
}

function cornerMean(pixels: Uint8Array, width: number, height: number): number {
  return cornerStatistics(pixels, width, height).mean
}

function otsuThreshold(pixels: Uint8Array): number {
  const histogram = new Uint32Array(256)
  for (const value of pixels) histogram[value] = histogram[value]! + 1
  let totalSum = 0
  for (let value = 0; value < histogram.length; value += 1) totalSum += value * histogram[value]!
  let backgroundWeight = 0
  let backgroundSum = 0
  let bestVariance = -1
  let threshold = 127
  for (let value = 0; value < histogram.length; value += 1) {
    backgroundWeight += histogram[value]!
    if (!backgroundWeight) continue
    const foregroundWeight = pixels.length - backgroundWeight
    if (!foregroundWeight) break
    backgroundSum += value * histogram[value]!
    const backgroundMean = backgroundSum / backgroundWeight
    const foregroundMean = (totalSum - backgroundSum) / foregroundWeight
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2
    if (variance > bestVariance) {
      bestVariance = variance
      threshold = value
    }
  }
  return threshold
}

function averageDocumentAngle(quad: Quad): number {
  return (lineAngle(quad.topLeft, quad.topRight) + lineAngle(quad.bottomLeft, quad.bottomRight)) / 2
}

function lineAngle(start: Point, end: Point): number {
  return Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI
}

function angleDifference(left: number, right: number): number {
  let difference = Math.abs(left - right) % 180
  if (difference > 90) difference = 180 - difference
  return difference
}

function polygonArea(quad: Quad): number {
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft]
  let total = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    total += current.x * next.y - next.x * current.y
  }
  return Math.abs(total) / 2
}

function mapQuad(quad: Quad, mapper: (point: Point) => Point): Quad {
  return {
    topLeft: mapper(quad.topLeft),
    topRight: mapper(quad.topRight),
    bottomRight: mapper(quad.bottomRight),
    bottomLeft: mapper(quad.bottomLeft)
  }
}

function interpolate(start: Point, end: Point, amount: number): Point {
  return { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount }
}

function distance(start: Point, end: Point): number {
  return Math.hypot(end.x - start.x, end.y - start.y)
}

function mean(values: ArrayLike<number>): number {
  let total = 0
  for (let index = 0; index < values.length; index += 1) total += values[index]!
  return total / Math.max(1, values.length)
}

function normaliseSize(size: OcrImageSize): OcrImageSize {
  return { width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) }
}
