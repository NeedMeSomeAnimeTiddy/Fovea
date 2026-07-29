import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createWorker, OEM } from 'tesseract.js'

const LOW_CONFIDENCE_THRESHOLD = 60
const MAX_PREPROCESS_PIXELS = 8_000_000
const MAX_PREPROCESS_DIMENSION = 2_400
const arguments_ = process.argv.slice(2)
const json = arguments_.includes('--json')
const imagePaths = arguments_.filter((argument) => !argument.startsWith('--'))

if (arguments_.includes('--help') || imagePaths.length === 0) {
  console.log('Usage: npm run ocr:benchmark -- [--json] <image.png> [more images...]')
  console.log('Runs the bundled English model locally and reports confidence, text length, preprocessing, and duration.')
  process.exitCode = imagePaths.length === 0 && !arguments_.includes('--help') ? 1 : 0
} else {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const languagePath = path.join(
    repositoryRoot,
    'node_modules',
    '@tesseract.js-data',
    'eng',
    '4.0.0_best_int'
  )
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    langPath: languagePath,
    cacheMethod: 'none',
    gzip: true
  })

  try {
    const results = []
    for (const inputPath of imagePaths) {
      const absolutePath = path.resolve(inputPath)
      const image = await readFile(absolutePath)
      const metadata = await sharp(image).metadata()
      if (!metadata.width || !metadata.height) throw new Error(`Could not determine image size: ${inputPath}`)
      const startedAt = performance.now()
      const prepared = await prepareImage(image, metadata.width, metadata.height)
      const enhanced = await worker.recognize(prepared.image, { rotateAuto: true }, { text: true })
      let selected = {
        text: enhanced.data.text.trim(),
        confidence: enhanced.data.confidence,
        preprocessing: prepared.preprocessing
      }
      if (prepared.preprocessing !== 'none' && selected.confidence < LOW_CONFIDENCE_THRESHOLD) {
        const original = await worker.recognize(image, { rotateAuto: true }, { text: true })
        const originalResult = {
          text: original.data.text.trim(),
          confidence: original.data.confidence,
          preprocessing: 'none'
        }
        if (resultScore(originalResult) > resultScore(selected)) selected = originalResult
      }
      if (selected.confidence < LOW_CONFIDENCE_THRESHOLD) {
        const highContrast = await prepareHighContrastImage(image, metadata.width, metadata.height)
        const thresholded = await worker.recognize(highContrast.image, { rotateAuto: true }, { text: true })
        const thresholdedResult = {
          text: thresholded.data.text.trim(),
          confidence: thresholded.data.confidence,
          preprocessing: 'high-contrast'
        }
        if (resultScore(thresholdedResult) > resultScore(selected)) selected = thresholdedResult
      }
      results.push({
        file: path.relative(repositoryRoot, absolutePath),
        confidence: Math.round(selected.confidence),
        characters: selected.text.length,
        preprocessing: selected.preprocessing,
        durationMs: Math.round(performance.now() - startedAt),
        ...await groundTruthMetrics(absolutePath, selected.text)
      })
    }

    if (json) console.log(JSON.stringify(results, null, 2))
    else console.table(results)
  } finally {
    await worker.terminate()
  }
}

async function prepareImage(image, width, height) {
  if (width >= 1_400 && height >= 700) {
    return { image, preprocessing: 'none' }
  }
  const scale = Math.min(
    2,
    MAX_PREPROCESS_DIMENSION / width,
    MAX_PREPROCESS_DIMENSION / height,
    Math.sqrt(MAX_PREPROCESS_PIXELS / (width * height))
  )
  if (scale < 1.2) return { image, preprocessing: 'none' }
  try {
    return {
      image: await sharp(image)
        .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), {
          fit: 'fill',
          kernel: sharp.kernel.lanczos3
        })
        .grayscale()
        .normalize({ lower: 1, upper: 99 })
        .sharpen({ sigma: 0.8 })
        .png()
        .toBuffer(),
      preprocessing: 'upscaled-contrast'
    }
  } catch {
    return { image, preprocessing: 'none' }
  }
}

async function prepareHighContrastImage(image, width, height) {
  const scale = Math.max(1, Math.min(
    2,
    MAX_PREPROCESS_DIMENSION / width,
    MAX_PREPROCESS_DIMENSION / height,
    Math.sqrt(MAX_PREPROCESS_PIXELS / (width * height))
  ))
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  const grayscale = sharp(image)
    .resize(targetWidth, targetHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .grayscale()
  const stats = await grayscale.clone().stats()
  let pipeline = grayscale.normalize({ lower: 1, upper: 99 }).sharpen({ sigma: 0.8 })
  if ((stats.channels[0]?.mean ?? 255) < 110) pipeline = pipeline.negate()
  return {
    image: await pipeline.threshold(165).png().toBuffer(),
    preprocessing: 'high-contrast'
  }
}

function resultScore(result) {
  const usefulLength = Math.min(2_000, result.text.replace(/\s/g, '').length)
  return result.confidence * 10 + usefulLength
}

async function groundTruthMetrics(imagePath, actual) {
  const truthPath = imagePath.replace(/\.[^.]+$/, '.txt')
  const expected = await readFile(truthPath, 'utf8').catch(() => null)
  if (expected === null) return {}
  return {
    cer: errorRate([...normalise(expected)], [...normalise(actual)]),
    wer: errorRate(words(expected), words(actual))
  }
}

function normalise(value) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function words(value) {
  return normalise(value).split(' ').filter(Boolean)
}

function errorRate(expected, actual) {
  if (!expected.length) return actual.length ? 1 : 0
  const previous = Array.from({ length: actual.length + 1 }, (_, index) => index)
  for (let expectedIndex = 1; expectedIndex <= expected.length; expectedIndex += 1) {
    const current = [expectedIndex]
    for (let actualIndex = 1; actualIndex <= actual.length; actualIndex += 1) {
      current[actualIndex] = Math.min(
        current[actualIndex - 1] + 1,
        previous[actualIndex] + 1,
        previous[actualIndex - 1] + (expected[expectedIndex - 1] === actual[actualIndex - 1] ? 0 : 1)
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return Math.round((previous[actual.length] / expected.length) * 10_000) / 10_000
}
