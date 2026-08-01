import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const root = resolve('.')
const strictDev = process.argv.includes('--strict-dev')
const strictPackage = process.argv.includes('--strict-package')
const expectedHashes = {
  icon: '11c6cbb77f22569fab22d86c76407a83ec81ab89dbfe28279854822d6e3fb00c',
  face: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
}
const paths = {
  paddlePython: join(root, '.venv-paddleocr', 'Scripts', 'python.exe'),
  paddleScript: join(root, 'resources', 'ocr', 'paddle-ocr.py'),
  omniPython: join(root, '.venv-omniparser', 'Scripts', 'python.exe'),
  omniScript: join(root, 'resources', 'analysis', 'omniparser-detector.py'),
  omniRoot: join(root, '.omniparser-runtime', 'source'),
  iconModel: join(root, '.omniparser-runtime', 'source', 'weights', 'icon_detect_v3', 'model.pt'),
  faceModel: join(root, '.omniparser-runtime', 'source', 'weights', 'face_detection_yunet', 'face_detection_yunet_2023mar.onnx'),
  packagedPaddlePython: join(root, 'resources', 'ocr', 'paddle', 'python.exe'),
  packagedOmniPython: join(root, 'resources', 'analysis', 'omniparser-python', 'python.exe'),
  packagedOmniRoot: join(root, 'resources', 'analysis', 'omniparser')
}

const failures = []
const warnings = []

function report(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'MISS'} ${label}${detail ? ` — ${detail}` : ''}`)
}

function requireFile(label, path, required) {
  const ok = existsSync(path)
  report(label, ok, path)
  if (!ok && required) failures.push(`${label}: ${path}`)
  return ok
}

function verifyHash(label, path, expected, required) {
  if (!existsSync(path)) return false
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  const ok = actual === expected
  report(`${label} SHA-256`, ok, ok ? actual : `expected ${expected}, found ${actual}`)
  if (!ok && required) failures.push(`${label} checksum mismatch`)
  return ok
}

const paddleReady = requireFile('Paddle Python', paths.paddlePython, strictDev) &&
  requireFile('Paddle bridge', paths.paddleScript, true)
const omniReady = requireFile('OmniParser Python', paths.omniPython, strictDev) &&
  requireFile('OmniParser bridge', paths.omniScript, true) &&
  requireFile('OmniParser icon model', paths.iconModel, strictDev) &&
  requireFile('YuNet face model', paths.faceModel, strictDev)

if (existsSync(paths.iconModel)) verifyHash('OmniParser icon model', paths.iconModel, expectedHashes.icon, strictDev)
if (existsSync(paths.faceModel)) verifyHash('YuNet face model', paths.faceModel, expectedHashes.face, strictDev)

if (paddleReady) {
  try {
    execFileSync(paths.paddlePython, [paths.paddleScript, '--check'], { cwd: root, stdio: 'pipe', timeout: 30_000 })
    report('Paddle bridge self-check', true)
  } catch (error) {
    report('Paddle bridge self-check', false, error instanceof Error ? error.message : String(error))
    if (strictDev) failures.push('Paddle bridge self-check failed')
  }
}

if (omniReady) {
  try {
    execFileSync(paths.omniPython, [
      paths.omniScript,
      '--check',
      '--root', paths.omniRoot,
      '--model', paths.iconModel,
      '--face-model', paths.faceModel
    ], { cwd: root, stdio: 'pipe', timeout: 30_000 })
    report('OmniParser/YuNet bridge self-check', true)
  } catch (error) {
    report('OmniParser/YuNet bridge self-check', false, error instanceof Error ? error.message : String(error))
    if (strictDev) failures.push('OmniParser/YuNet bridge self-check failed')
  }
}

const packagedAnalyzeReady = [
  paths.packagedPaddlePython,
  paths.packagedOmniPython,
  paths.packagedOmniRoot
].every(existsSync)
report(
  'Full packaged Analyze runtime',
  packagedAnalyzeReady,
  packagedAnalyzeReady ? 'staging inputs are present' : 'installer will use documented Windows OCR/Tesseract/heuristic fallbacks'
)
if (!packagedAnalyzeReady) {
  warnings.push('The full Python Analyze runtimes are not staged for the NSIS installer.')
  if (strictPackage) failures.push('Full packaged Analyze runtime is not staged')
}

for (const warning of warnings) console.warn(`WARN ${warning}`)
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exitCode = 1
} else {
  console.log('Analyze runtime checks completed successfully.')
}
