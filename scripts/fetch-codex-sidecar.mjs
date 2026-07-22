import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

const VERSION = '0.144.4'
const TARGETS = {
  x64: {
    asset: 'codex-x86_64-pc-windows-msvc.exe',
    sha256: '51398051c2332b6afe08dc3b9dbb4056085c197f35ca57a307ee303d450cada5'
  },
  arm64: {
    asset: 'codex-aarch64-pc-windows-msvc.exe',
    sha256: '84406bf7cb8c689e46ebd31244f0458fce3eeed781ec1030399a96baab062932'
  }
}

if (process.platform !== 'win32') {
  console.log('Codex sidecar fetch skipped: this prototype packages the official Windows binary.')
  process.exit(0)
}

const target = TARGETS[process.arch]
if (!target) throw new Error(`Unsupported Windows architecture: ${process.arch}`)

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'resources', 'sidecar', 'codex.exe')
const temporary = `${output}.download`
const schemaDir = join(root, 'resources', 'codex-schema')
const url = `https://github.com/openai/codex/releases/download/rust-v${VERSION}/${target.asset}`

await mkdir(dirname(output), { recursive: true })
let validExisting = false
try {
  await stat(output)
  validExisting = (await sha256(output)) === target.sha256
} catch {
  validExisting = false
}

if (!validExisting) {
  console.log(`Downloading official Codex ${VERSION} Windows ${process.arch} sidecar…`)
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Fovea-build/0.1.0' } })
  if (!response.ok || !response.body) throw new Error(`Codex download failed: HTTP ${response.status}`)
  await rm(temporary, { force: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o755 }))
  const digest = await sha256(temporary)
  if (digest !== target.sha256) {
    await rm(temporary, { force: true })
    throw new Error(`Codex checksum mismatch: expected ${target.sha256}, received ${digest}`)
  }
  await rm(output, { force: true })
  await import('node:fs/promises').then(({ rename }) => rename(temporary, output))
  console.log(`Verified ${target.asset} (${target.sha256}).`)
} else {
  console.log(`Using verified Codex ${VERSION} sidecar already in resources/sidecar.`)
}

await rm(schemaDir, { recursive: true, force: true })
await mkdir(schemaDir, { recursive: true })
const generated = spawnSync(output, ['app-server', 'generate-ts', '--out', schemaDir], {
  stdio: 'inherit',
  windowsHide: true
})
if (generated.status !== 0) throw new Error(`Codex schema generation failed with exit code ${generated.status}.`)
console.log(`Generated the pinned app-server TypeScript schema in resources/codex-schema.`)

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}
