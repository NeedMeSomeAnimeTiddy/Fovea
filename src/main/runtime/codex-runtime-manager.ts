import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { EventEmitter } from 'node:events'
import type { ChatGptRuntimeStatus } from '@shared/types/app'
import manifest from '../../../resources/runtime/codex-runtime-manifest.json'

export const CODEX_RUNTIME_VERSION = manifest.version

export interface CodexRuntimeTarget {
  architecture: string
  asset: string
  sha256: string
  sizeBytes: number
}

export const CODEX_RUNTIME_TARGETS = manifest.targets as Record<string, CodexRuntimeTarget>

interface CodexRuntimeManagerOptions {
  runtimeDirectory: string
  bundledBinaryPath?: string
  architecture?: string
  target?: CodexRuntimeTarget
  fetcher?: typeof fetch
}

export class CodexRuntimeManager extends EventEmitter {
  readonly binaryPath: string
  private readonly target: CodexRuntimeTarget | undefined
  private readonly temporaryPath: string
  private readonly fetcher: typeof fetch
  private installPromise: Promise<ChatGptRuntimeStatus> | null = null
  private installController: AbortController | null = null
  private status: ChatGptRuntimeStatus

  constructor(private readonly options: CodexRuntimeManagerOptions) {
    super()
    const architecture = options.architecture ?? process.arch
    this.target = options.target ?? CODEX_RUNTIME_TARGETS[architecture]
    this.binaryPath = options.bundledBinaryPath ?? join(options.runtimeDirectory, CODEX_RUNTIME_VERSION, architecture, 'codex.exe')
    this.temporaryPath = `${this.binaryPath}.download`
    this.fetcher = options.fetcher ?? fetch
    this.status = this.baseStatus(this.target ? 'checking' : 'unsupported')
  }

  async initialise(): Promise<void> {
    if (!this.target) {
      this.setStatus({ ...this.baseStatus('unsupported'), error: `ChatGPT is not available for ${process.arch}.` })
      return
    }
    await mkdir(dirname(this.binaryPath), { recursive: true, mode: 0o700 })
    if (!this.options.bundledBinaryPath) await rm(this.temporaryPath, { force: true })
    let installedBytes = 0
    try {
      installedBytes = (await stat(this.binaryPath)).size
    } catch {
      this.setStatus(this.baseStatus('not-installed'))
      return
    }
    const digest = await sha256(this.binaryPath)
    if (digest !== this.target.sha256) {
      this.setStatus({
        ...this.baseStatus('error'),
        installedBytes,
        error: 'The ChatGPT runtime failed verification. Remove it or retry the download.'
      })
      return
    }
    this.setStatus({
      ...this.baseStatus('installed'),
      downloadedBytes: this.target.sizeBytes,
      installedBytes,
      removable: !this.options.bundledBinaryPath
    })
  }

  getStatus(): ChatGptRuntimeStatus {
    return structuredClone(this.status)
  }

  isInstalled(): boolean {
    return this.status.state === 'installed'
  }

  install(): Promise<ChatGptRuntimeStatus> {
    if (this.installPromise) return this.installPromise
    if (this.options.bundledBinaryPath && this.isInstalled()) return Promise.resolve(this.getStatus())
    if (this.options.bundledBinaryPath) {
      return Promise.reject(new Error('The development runtime is managed by npm run sidecar:fetch.'))
    }
    if (!this.target) return Promise.reject(new Error(`ChatGPT is not available for ${process.arch}.`))
    const controller = new AbortController()
    this.installController = controller
    this.installPromise = this.downloadAndVerify(controller.signal).finally(() => {
      this.installController = null
      this.installPromise = null
    })
    return this.installPromise
  }

  async remove(): Promise<ChatGptRuntimeStatus> {
    if (this.options.bundledBinaryPath) throw new Error('The development runtime is managed by npm run sidecar:fetch.')
    this.installController?.abort(new Error('Runtime download cancelled.'))
    await this.installPromise?.catch(() => undefined)
    await rm(this.options.runtimeDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    this.setStatus(this.baseStatus('not-installed'))
    return this.getStatus()
  }

  private async downloadAndVerify(signal: AbortSignal): Promise<ChatGptRuntimeStatus> {
    const target = this.target!
    await mkdir(dirname(this.binaryPath), { recursive: true, mode: 0o700 })
    await rm(this.temporaryPath, { force: true })
    this.setStatus(this.baseStatus('downloading'))
    try {
      const url = `https://github.com/openai/codex/releases/download/rust-v${CODEX_RUNTIME_VERSION}/${target.asset}`
      const response = await this.fetcher(url, {
        redirect: 'follow',
        signal,
        headers: { 'user-agent': 'Fovea-runtime/0.1.0' }
      })
      if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`)

      let downloadedBytes = 0
      let lastReportedMiB = -1
      const progress = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          downloadedBytes += chunk.length
          const downloadedMiB = Math.floor(downloadedBytes / (1024 * 1024))
          if (downloadedMiB !== lastReportedMiB) {
            lastReportedMiB = downloadedMiB
            this.setStatus({ ...this.status, downloadedBytes })
          }
          callback(null, chunk)
        }
      })
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
        progress,
        createWriteStream(this.temporaryPath, { mode: 0o700 }),
        { signal }
      )
      const digest = await sha256(this.temporaryPath)
      if (digest !== target.sha256) {
        throw new Error('The downloaded ChatGPT runtime did not match its pinned SHA-256 digest.')
      }
      await chmod(this.temporaryPath, 0o700).catch(() => undefined)
      await rm(this.binaryPath, { force: true })
      await rename(this.temporaryPath, this.binaryPath)
      const installedBytes = (await stat(this.binaryPath)).size
      this.setStatus({
        ...this.baseStatus('installed'),
        downloadedBytes: installedBytes,
        installedBytes,
        removable: true
      })
      return this.getStatus()
    } catch (error) {
      await rm(this.temporaryPath, { force: true })
      const message = signal.aborted ? 'The ChatGPT runtime download was interrupted. You can retry.' : safeMessage(error)
      this.setStatus({ ...this.baseStatus('error'), error: message })
      throw new Error(message, { cause: error })
    }
  }

  private baseStatus(state: ChatGptRuntimeStatus['state']): ChatGptRuntimeStatus {
    return {
      state,
      version: CODEX_RUNTIME_VERSION,
      architecture: this.target?.architecture ?? (this.options.architecture ?? process.arch),
      downloadBytes: this.target?.sizeBytes ?? 0,
      downloadedBytes: 0,
      installedBytes: 0,
      removable: false
    }
  }

  private setStatus(status: ChatGptRuntimeStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.status)) return
    this.status = status
    this.emit('changed', this.getStatus())
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}
