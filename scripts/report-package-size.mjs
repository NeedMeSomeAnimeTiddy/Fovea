import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const budget = JSON.parse(await readFile(join(root, 'package-size-budget.json'), 'utf8'))
const check = process.argv.includes('--check')
const ifPresent = process.argv.includes('--if-present')

const installer = await newestInstaller(dist)
const unpacked = await findUnpackedDirectory(dist)
if (!installer || !unpacked) {
  const message = 'No complete Windows package was found under dist/. Run npm run package:win to create one.'
  if (ifPresent) {
    console.log(`[package-size] ${message}`)
    process.exit(0)
  }
  throw new Error(message)
}

const installerSize = (await stat(installer)).size
const files = await listFiles(unpacked)
const unpackedSize = files.reduce((total, file) => total + file.size, 0)
const largest = [...files].sort((left, right) => right.size - left.size).slice(0, budget.largestFilesReported)

console.log(`[package-size] Installer: ${formatBytes(installerSize)} (${basename(installer)})`)
console.log(`[package-size] Unpacked: ${formatBytes(unpackedSize)} (${basename(unpacked)})`)
console.log(`[package-size] Build architecture: ${process.arch}`)
console.log('[package-size] Largest packaged files:')
for (const file of largest) {
  console.log(`  ${formatBytes(file.size).padStart(10)}  ${relative(unpacked, file.path)}`)
}

const results = [
  budgetResult('installer', installerSize, budget.installerMaxBytes, budget.warningRatio),
  budgetResult('unpacked package', unpackedSize, budget.unpackedMaxBytes, budget.warningRatio)
]
for (const result of results) console.log(`[package-size] ${result.message}`)

const failures = results.filter((result) => result.failed)
if (check && failures.length) {
  throw new Error(`Package size budget exceeded: ${failures.map((result) => result.name).join(', ')}.`)
}

async function newestInstaller(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && /^Fovea-.*-Setup\.exe$/i.test(entry.name))
    .map(async (entry) => {
      const path = join(directory, entry.name)
      return { path, modified: (await stat(path)).mtimeMs }
    }))
  return candidates.sort((left, right) => right.modified - left.modified)[0]?.path ?? null
}

async function findUnpackedDirectory(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return null
  }
  return entries.find((entry) => entry.isDirectory() && entry.name.endsWith('-unpacked'))
    ? join(directory, entries.find((entry) => entry.isDirectory() && entry.name.endsWith('-unpacked')).name)
    : null
}

async function listFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if (entry.isFile()) files.push({ path, size: (await stat(path)).size })
  }
  return files
}

function budgetResult(name, value, maximum, warningRatio) {
  const ratio = value / maximum
  const failed = value > maximum
  const level = failed ? 'FAIL' : ratio >= warningRatio ? 'WARN' : 'PASS'
  return {
    name,
    failed,
    message: `${level} ${name}: ${formatBytes(value)} / ${formatBytes(maximum)} (${(ratio * 100).toFixed(1)}%)`
  }
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
