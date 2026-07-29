import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const arguments_ = process.argv.slice(2)
const json = arguments_.includes('--json')
const requestedProfiles = optionValue('--profiles')?.split(',').filter(Boolean) ?? ['small', 'medium', 'large']
const validProfiles = new Set(['small', 'medium', 'large'])
const profiles = requestedProfiles.filter((profile) => validProfiles.has(profile))
const imagePaths = arguments_.filter((argument, index) => {
  if (argument.startsWith('--')) return false
  return arguments_[index - 1] !== '--profiles'
})

if (arguments_.includes('--help') || !imagePaths.length || !profiles.length) {
  console.log('Usage: npm run ocr:benchmark:paddle -- [--json] [--profiles small,medium,large] <image.png> [more images...]')
  console.log('Place an optional image.txt beside each image to include character and word error rates.')
  process.exitCode = arguments_.includes('--help') ? 0 : 1
} else {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pythonPath = process.env.FOVEA_PADDLE_PYTHON?.trim() || path.join(repositoryRoot, '.venv-paddleocr', 'Scripts', 'python.exe')
  const bridgePath = path.join(repositoryRoot, 'resources', 'ocr', 'paddle-ocr.py')
  const cachePath = path.join(repositoryRoot, '.paddle-ocr-cache')
  await access(pythonPath).catch(() => {
    throw new Error('PaddleOCR environment not found. Run npm run paddle:setup first.')
  })
  const absoluteImages = imagePaths.map((imagePath) => path.resolve(imagePath))
  const truth = new Map()
  for (const imagePath of absoluteImages) {
    const truthPath = imagePath.replace(/\.[^.]+$/, '.txt')
    const value = await readFile(truthPath, 'utf8').catch(() => null)
    if (value !== null) truth.set(imagePath, value.trim())
  }
  const rows = []
  for (const profile of profiles) {
    const messages = await runBridge(pythonPath, bridgePath, cachePath, profile, absoluteImages)
    const ready = messages.find((message) => message.type === 'ready')
    for (const message of messages.filter((candidate) => candidate.type === 'result')) {
      const expected = truth.get(path.resolve(message.file))
      const text = message.lines.map((line) => line.text).join('\n')
      const weights = message.lines.map((line) => Math.max(1, line.text.length))
      const totalWeight = weights.reduce((total, weight) => total + weight, 0)
      const confidence = totalWeight
        ? Math.round(message.lines.reduce((total, line, index) => total + line.confidence * 100 * weights[index], 0) / totalWeight)
        : 0
      rows.push({
        profile,
        detector: message.detector,
        recognizer: message.recognizer,
        file: path.relative(repositoryRoot, path.resolve(message.file)),
        loadMs: ready?.loadMs ?? 0,
        inferenceMs: message.inferenceMs,
        analysisScale: message.analysisScale ?? 1,
        retried: message.retriedHighResolution === true,
        confidence,
        lines: message.lines.length,
        characters: text.length,
        ...(expected === undefined ? {} : {
          cer: errorRate([...normalise(expected)], [...normalise(text)]),
          wer: errorRate(words(expected), words(text))
        })
      })
    }
    const failures = messages.filter((message) => message.type === 'error')
    if (failures.length) throw new Error(failures.map((failure) => `${failure.file}: ${failure.message}`).join('\n'))
  }
  if (json) console.log(JSON.stringify(rows, null, 2))
  else console.table(rows)
}

function optionValue(name) {
  const inline = arguments_.find((argument) => argument.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = arguments_.indexOf(name)
  return index >= 0 ? arguments_[index + 1] : undefined
}

function runBridge(pythonPath, bridgePath, cachePath, profile, images) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [
      '-u',
      bridgePath,
      '--profile',
      profile,
      '--cache-dir',
      cachePath,
      ...images.flatMap((image) => ['--image', image])
    ], {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: '1'
      }
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PaddleOCR exited with code ${code ?? 'unknown'}.`))
        return
      }
      const messages = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try { return [JSON.parse(line)] }
          catch { return [] }
        })
      resolve(messages)
    })
  })
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
