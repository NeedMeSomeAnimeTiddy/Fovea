import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import sharp from 'sharp'
import { buildCaptureAnalysis } from '../src/main/capture/screen-feature-analysis'
import { OmniParserDetectorService } from '../src/main/capture/screenshot-element-detector-service'
import { TesseractOcrService } from '../src/main/ocr/ocr-service'
import { PaddleFirstOcrService, PaddleOcrService, resolvePaddleOcrProfile } from '../src/main/ocr/paddle-ocr-service'
import { NativeFirstOcrService, WindowsOcrService } from '../src/main/ocr/windows-ocr-service'

interface CorpusEntry {
  id: string
  image: string
}

interface CorpusManifest {
  entries: CorpusEntry[]
}

const root = resolve('.')
const arguments_ = process.argv.slice(2)
const directoryArgument = arguments_.find((argument) => !argument.startsWith('--'))
const corpusDirectory = resolve(directoryArgument ?? join('tests', 'fixtures', 'analyze-corpus'))
const manifest = JSON.parse(await readFile(join(corpusDirectory, 'manifest.json'), 'utf8')) as CorpusManifest
const limitArgument = arguments_.find((argument) => argument.startsWith('--limit='))
const parsedLimit = limitArgument ? Number(limitArgument.slice('--limit='.length)) : manifest.entries.length
if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
  throw new Error('--limit must be a positive integer')
}
const limit = Math.min(parsedLimit, manifest.entries.length)
const pythonPath = join(root, '.venv-omniparser', 'Scripts', 'python.exe')
const omniRoot = join(root, '.omniparser-runtime', 'source')
const detector = new OmniParserDetectorService({
  pythonPath,
  scriptPath: join(root, 'resources', 'analysis', 'omniparser-detector.py'),
  runtimePath: join(tmpdir(), 'fovea-analyze-corpus'),
  omniParserRoot: omniRoot,
  modelPath: join(omniRoot, 'weights', 'icon_detect_v3', 'model.pt'),
  faceModelPath: join(omniRoot, 'weights', 'face_detection_yunet', 'face_detection_yunet_2023mar.onnx'),
  device: process.env.FOVEA_OMNIPARSER_DEVICE?.trim() || 'auto',
  confidence: 0.08,
  faceConfidence: 0.82,
  tileSize: 1280,
  tileOverlap: 0.125,
  fullFrameLongSide: 1920,
  maxDetections: 500
})
const windowsOcr = new WindowsOcrService(join(root, 'resources', 'ocr', 'windows-ocr.ps1'))
const paddleOcr = new PaddleOcrService({
  pythonPath: join(root, '.venv-paddleocr', 'Scripts', 'python.exe'),
  scriptPath: join(root, 'resources', 'ocr', 'paddle-ocr.py'),
  runtimePath: join(root, '.paddle-ocr-cache'),
  profile: resolvePaddleOcrProfile(process.env.FOVEA_PADDLE_OCR_PROFILE)
})
const tesseractOcr = new TesseractOcrService(join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int'))
const ocr = new NativeFirstOcrService(windowsOcr, new PaddleFirstOcrService(paddleOcr, tesseractOcr))

await detector.prepare()
try {
  for (const [index, entry] of manifest.entries.slice(0, limit).entries()) {
    const startedAt = Date.now()
    const imagePath = join(corpusDirectory, entry.image)
    const image = await readFile(imagePath)
    const metadata = await sharp(image).metadata()
    if (!metadata.width || !metadata.height) throw new Error(`Could not read dimensions for ${entry.image}`)
    const size = { width: metadata.width, height: metadata.height }
    const analysisId = `analyze-corpus-${entry.id}`
    const [ocrResult, visualFeatures] = await Promise.all([
      ocr.recognise(analysisId, image, size, undefined, {
        sourcePath: imagePath,
        preserveGeometry: true,
        refinementRegions: []
      }),
      detector.detect(analysisId, image, size, undefined, { sourcePath: imagePath })
    ])
    const analysis = await buildCaptureAnalysis(image, {
      lines: ocrResult.regions,
      words: ocrResult.words ?? [],
      entities: ocrResult.entities ?? [],
      visualFeatures,
      screenshotAnchored: true
    })
    const actual = {
      timingMs: Date.now() - startedAt,
      image: entry.image,
      ocrEngine: ocrResult.engine,
      ocrLines: ocrResult.regions.length,
      visualTargets: visualFeatures.length,
      features: analysis.features
    }
    await writeFile(join(corpusDirectory, `${entry.id}.actual.json`), `${JSON.stringify(actual, null, 2)}\n`)
    console.log(
      `[analyze-corpus] ${index + 1}/${Math.min(limit, manifest.entries.length)} ${entry.id}: ` +
      `${analysis.features.length} features in ${actual.timingMs}ms`
    )
  }
} finally {
  await Promise.allSettled([detector.dispose(), ocr.dispose()])
}
