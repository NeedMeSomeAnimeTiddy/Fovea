import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const DEFAULT_IOU_THRESHOLD = 0.5
const TINY_FEATURE_AREA = 0.0015
const GENERIC_LABELS = new Set([
  '',
  'button',
  'control',
  'interface element',
  'null',
  'undefined',
  'unknown',
  'unlabelled button',
  'unlabelled control',
  'unlabeled button',
  'unlabeled control'
])

export function evaluateAnalyzeFixture(expected, actual, options = {}) {
  const iouThreshold = finiteNumber(options.iouThreshold, DEFAULT_IOU_THRESHOLD)
  const expectedFeatures = validateFeatures(expected.features, 'expected.features')
    .filter((feature) => feature.visible !== false && feature.ignore !== true)
  const actualFeatures = validateFeatures(actual.features, 'actual.features')
  const forbiddenRegions = validateBoundsList(expected.forbiddenRegions ?? [], 'expected.forbiddenRegions')
  const candidates = []

  for (const [expectedIndex, wanted] of expectedFeatures.entries()) {
    for (const [actualIndex, found] of actualFeatures.entries()) {
      if (!compatibleKinds(wanted.kind, found.kind)) continue
      const iou = intersectionOverUnion(wanted.bounds, found.bounds)
      if (iou < iouThreshold) continue
      candidates.push({ expectedIndex, actualIndex, iou })
    }
  }
  candidates.sort((left, right) => right.iou - left.iou)

  const matchedExpected = new Set()
  const matchedActual = new Set()
  const matches = []
  for (const candidate of candidates) {
    if (matchedExpected.has(candidate.expectedIndex) || matchedActual.has(candidate.actualIndex)) continue
    matchedExpected.add(candidate.expectedIndex)
    matchedActual.add(candidate.actualIndex)
    matches.push(candidate)
  }

  const unmatchedActual = actualFeatures
    .map((feature, index) => ({ feature, index }))
    .filter(({ index }) => !matchedActual.has(index))
  const duplicates = unmatchedActual.filter(({ feature }) =>
    expectedFeatures.some((wanted, expectedIndex) =>
      matchedExpected.has(expectedIndex) &&
      compatibleKinds(wanted.kind, feature.kind) &&
      intersectionOverUnion(wanted.bounds, feature.bounds) >= iouThreshold
    )
  )
  const forbiddenFalsePositives = unmatchedActual.filter(({ feature }) =>
    forbiddenRegions.some((bounds) => overlapRatio(feature.bounds, bounds) >= 0.5)
  )
  const tinyExpected = expectedFeatures
    .map((feature, index) => ({ feature, index }))
    .filter(({ feature }) => boundsArea(feature.bounds) <= TINY_FEATURE_AREA)
  const labelledMatches = matches.filter(({ expectedIndex }) => Boolean(normalizedLabel(expectedFeatures[expectedIndex].label)))
  const correctLabels = labelledMatches.filter(({ expectedIndex, actualIndex }) =>
    labelsOverlap(expectedFeatures[expectedIndex].label, actualFeatures[actualIndex].label)
  )
  const invalidLabels = actualFeatures.filter(({ label }) => isInvalidLabel(label))
  const truePositives = matches.length
  const falsePositives = actualFeatures.length - truePositives
  const falseNegatives = expectedFeatures.length - truePositives
  const precision = ratio(truePositives, truePositives + falsePositives)
  const recall = ratio(truePositives, truePositives + falseNegatives)

  return {
    fixture: expected.id || actual.id || 'unnamed',
    counts: {
      expected: expectedFeatures.length,
      actual: actualFeatures.length,
      matched: truePositives,
      missed: falseNegatives,
      falsePositives,
      duplicates: duplicates.length,
      forbiddenFalsePositives: forbiddenFalsePositives.length,
      invalidLabels: invalidLabels.length,
      tinyExpected: tinyExpected.length,
      tinyMatched: tinyExpected.filter(({ index }) => matchedExpected.has(index)).length
    },
    metrics: {
      precision,
      recall,
      f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
      tinyRecall: ratio(
        tinyExpected.filter(({ index }) => matchedExpected.has(index)).length,
        tinyExpected.length
      ),
      duplicateRate: ratio(duplicates.length, actualFeatures.length),
      forbiddenFalsePositiveRate: ratio(forbiddenFalsePositives.length, actualFeatures.length),
      invalidLabelRate: ratio(invalidLabels.length, actualFeatures.length),
      labelAccuracy: ratio(correctLabels.length, labelledMatches.length)
    },
    timingMs: finiteNumber(actual.timingMs, null),
    misses: expectedFeatures
      .map((feature, index) => ({ feature, index }))
      .filter(({ index }) => !matchedExpected.has(index))
      .map(({ feature }) => feature.id),
    falsePositives: unmatchedActual.map(({ feature }) => feature.id)
  }
}

export function aggregateAnalyzeReports(reports) {
  const totals = reports.reduce((sum, report) => {
    for (const [key, value] of Object.entries(report.counts)) sum[key] = (sum[key] ?? 0) + value
    if (typeof report.timingMs === 'number') sum.timingMs = (sum.timingMs ?? 0) + report.timingMs
    return sum
  }, {})
  const precision = ratio(totals.matched, totals.actual)
  const recall = ratio(totals.matched, totals.expected)
  return {
    fixtures: reports.length,
    counts: totals,
    metrics: {
      precision,
      recall,
      f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
      tinyRecall: ratio(totals.tinyMatched, totals.tinyExpected),
      duplicateRate: ratio(totals.duplicates, totals.actual),
      forbiddenFalsePositiveRate: ratio(totals.forbiddenFalsePositives, totals.actual),
      invalidLabelRate: ratio(totals.invalidLabels, totals.actual)
    },
    averageTimingMs: ratio(totals.timingMs, reports.filter(({ timingMs }) => typeof timingMs === 'number').length)
  }
}

async function loadReports(directory) {
  const entries = await readdir(directory)
  const expectedFiles = entries.filter((entry) => entry.endsWith('.expected.json')).sort()
  if (!expectedFiles.length) throw new Error(`No *.expected.json fixtures found in ${directory}`)
  const reports = []
  for (const expectedFile of expectedFiles) {
    const prefix = expectedFile.slice(0, -'.expected.json'.length)
    const actualFile = `${prefix}.actual.json`
    if (!entries.includes(actualFile)) throw new Error(`Missing ${actualFile} for ${expectedFile}`)
    const [expected, actual] = await Promise.all([
      readJson(join(directory, expectedFile)),
      readJson(join(directory, actualFile))
    ])
    reports.push(evaluateAnalyzeFixture(
      { id: prefix, ...expected },
      { id: prefix, ...actual }
    ))
  }
  return reports
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function main() {
  const arguments_ = process.argv.slice(2)
  const json = arguments_.includes('--json')
  const directoryArgument = arguments_.find((argument) => !argument.startsWith('--'))
  const directory = resolve(directoryArgument ?? join('tests', 'fixtures', 'analyze'))
  const reports = await loadReports(directory)
  const aggregate = aggregateAnalyzeReports(reports)
  if (json) {
    console.log(JSON.stringify({ aggregate, fixtures: reports }, null, 2))
    return
  }
  console.log(`Analyze evaluation: ${reports.length} fixture(s)`)
  console.log(
    `Recall ${percentage(aggregate.metrics.recall)} | precision ${percentage(aggregate.metrics.precision)} | ` +
    `tiny recall ${percentage(aggregate.metrics.tinyRecall)}`
  )
  console.log(
    `Duplicates ${percentage(aggregate.metrics.duplicateRate)} | hidden/forbidden ${percentage(aggregate.metrics.forbiddenFalsePositiveRate)} | ` +
    `invalid labels ${percentage(aggregate.metrics.invalidLabelRate)}`
  )
  if (aggregate.averageTimingMs !== null) console.log(`Average detector time ${Math.round(aggregate.averageTimingMs)}ms`)
  for (const report of reports) {
    console.log(
      `- ${report.fixture}: ${report.counts.matched}/${report.counts.expected} found, ` +
      `${report.counts.falsePositives} false positive(s), ${report.counts.duplicates} duplicate(s)`
    )
  }
}

function validateFeatures(value, path) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') throw new Error(`${path}[${index}] must be an object`)
    const bounds = validateBounds(candidate.bounds, `${path}[${index}].bounds`)
    return {
      ...candidate,
      id: String(candidate.id ?? `${path}-${index + 1}`),
      kind: String(candidate.kind ?? 'control'),
      label: String(candidate.label ?? ''),
      bounds
    }
  })
}

function validateBoundsList(value, path) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value.map((candidate, index) => validateBounds(candidate.bounds ?? candidate, `${path}[${index}]`))
}

function validateBounds(value, path) {
  if (!value || typeof value !== 'object') throw new Error(`${path} must be an object`)
  const bounds = {
    x: finiteNumber(value.x, Number.NaN),
    y: finiteNumber(value.y, Number.NaN),
    width: finiteNumber(value.width, Number.NaN),
    height: finiteNumber(value.height, Number.NaN)
  }
  if (
    Object.values(bounds).some((number) => !Number.isFinite(number)) ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x + bounds.width > 1.000001 ||
    bounds.y + bounds.height > 1.000001
  ) throw new Error(`${path} must contain positive normalized x, y, width, and height`)
  return bounds
}

function compatibleKinds(expected, actual) {
  const category = (kind) => kind === 'control' || kind === 'link' ? 'control' : kind === 'visual' ? 'visual' : 'text'
  return category(expected) === category(actual)
}

function labelsOverlap(left, right) {
  const leftLabel = normalizedLabel(left)
  const rightLabel = normalizedLabel(right)
  return Boolean(leftLabel && rightLabel && (
    leftLabel.includes(rightLabel) ||
    rightLabel.includes(leftLabel) ||
    tokenContainment(leftLabel, rightLabel) >= 0.6
  ))
}

function tokenContainment(left, right) {
  const leftTokens = new Set(left.split(' ').filter(Boolean))
  const rightTokens = new Set(right.split(' ').filter(Boolean))
  if (!leftTokens.size || !rightTokens.size) return 0
  let intersection = 0
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1
  return intersection / Math.min(leftTokens.size, rightTokens.size)
}

function isInvalidLabel(label) {
  const normalized = normalizedLabel(label)
  if (GENERIC_LABELS.has(normalized)) return true
  if (/^[a-z]{5,}$/i.test(normalized.replaceAll(' ', '')) && !/[aeiouy]/i.test(normalized)) return true
  return false
}

function normalizedLabel(value) {
  return String(value ?? '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function intersectionOverUnion(left, right) {
  const intersection = intersectionArea(left, right)
  const union = boundsArea(left) + boundsArea(right) - intersection
  return ratio(intersection, union)
}

function overlapRatio(left, right) {
  return ratio(intersectionArea(left, right), boundsArea(left))
}

function intersectionArea(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  return width * height
}

function boundsArea(bounds) {
  return Math.max(0, bounds.width) * Math.max(0, bounds.height)
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function ratio(numerator = 0, denominator = 0) {
  return denominator > 0 ? numerator / denominator : null
}

function percentage(value) {
  return value === null ? 'n/a' : `${Math.round(value * 1000) / 10}%`
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[analyze-evaluation] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
