import type {
  ApplicationUpdateProgress,
  ApplicationUpdateState,
  AvailableApplicationUpdate,
  UpdateFailure,
  UpdateFailureCode,
  UpdateReleaseMarker,
  UpdateUnavailableReason
} from '@shared/types/update'
import { UPDATE_RELEASE_MARKER_SCHEMA_VERSION } from '@shared/types/update'

export type UpdateAdapterEvent =
  | 'error'
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'update-cancelled'

export type UpdateAdapterListener = (...arguments_: unknown[]) => void

/**
 * The subset of electron-updater 6.8.9 used by Fovea. Keeping this interface local lets the
 * orchestration and security policy be tested without loading Electron or the updater package.
 */
export interface UpdateAdapter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  disableWebInstaller: boolean
  forceDevUpdateConfig: boolean
  fullChangelog: boolean
  on(event: UpdateAdapterEvent, listener: UpdateAdapterListener): unknown
  off(event: UpdateAdapterEvent, listener: UpdateAdapterListener): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdatePreferences {
  getAutomaticChecks(): boolean
  setAutomaticChecks(enabled: boolean): Promise<void>
}

export interface UpdateRuntime {
  isPackaged: boolean
  platform: NodeJS.Platform
  architecture: string
  currentVersion: string
  releaseMarker?: unknown
}

export interface UpdateControllerOptions {
  runtime: UpdateRuntime
  preferences: UpdatePreferences
  updater?: UpdateAdapter
  expectedRepository?: string
  automaticCheckDelayMs?: number
  automaticCheckIntervalMs?: number
  now?: () => Date
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelScheduled?: (handle: ReturnType<typeof setTimeout>) => void
}

interface UpdateInfoLike {
  version?: unknown
  releaseName?: unknown
  releaseDate?: unknown
  releaseNotes?: unknown
}

interface ProgressInfoLike {
  percent?: unknown
  transferred?: unknown
  total?: unknown
  bytesPerSecond?: unknown
}

const DEFAULT_REPOSITORY = 'NeedMeSomeAnimeTiddy/Fovea'
const DEFAULT_AUTOMATIC_CHECK_DELAY_MS = 30_000
const DEFAULT_AUTOMATIC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000
const MAX_RELEASE_NOTE_LENGTH = 20_000

export class UpdateController {
  private readonly listeners = new Set<(state: ApplicationUpdateState) => void>()
  private readonly adapterListeners: Array<[UpdateAdapterEvent, UpdateAdapterListener]>
  private readonly now: () => Date
  private readonly schedule: NonNullable<UpdateControllerOptions['schedule']>
  private readonly cancelScheduled: NonNullable<UpdateControllerOptions['cancelScheduled']>
  private readonly automaticCheckDelayMs: number
  private readonly automaticCheckIntervalMs: number
  private state: ApplicationUpdateState
  private automaticTimer: ReturnType<typeof setTimeout> | null = null
  private checkPromise: Promise<ApplicationUpdateState> | null = null
  private downloadPromise: Promise<ApplicationUpdateState> | null = null
  private initialised = false
  private disposed = false

  constructor(private readonly options: UpdateControllerOptions) {
    this.now = options.now ?? (() => new Date())
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.cancelScheduled = options.cancelScheduled ?? ((handle) => clearTimeout(handle))
    this.automaticCheckDelayMs = positiveDelay(options.automaticCheckDelayMs, DEFAULT_AUTOMATIC_CHECK_DELAY_MS)
    this.automaticCheckIntervalMs = positiveDelay(options.automaticCheckIntervalMs, DEFAULT_AUTOMATIC_CHECK_INTERVAL_MS)

    const unavailableReason = determineUnavailableReason(options)
    const eligible = unavailableReason === null
    this.state = {
      phase: eligible ? 'idle' : 'unavailable',
      eligible,
      unavailableReason,
      automaticChecks: eligible && safeAutomaticPreference(options.preferences),
      currentVersion: safeVersion(options.runtime.currentVersion, '0.0.0'),
      lastCheckedAt: null,
      availableUpdate: null,
      downloadProgress: null,
      failure: null
    }
    this.adapterListeners = [
      ['error', (error) => this.handleError(error)],
      ['checking-for-update', () => this.handleChecking()],
      ['update-available', (info) => this.handleUpdateAvailable(info)],
      ['update-not-available', () => this.handleUpdateNotAvailable()],
      ['download-progress', (progress) => this.handleDownloadProgress(progress)],
      ['update-downloaded', (info) => this.handleUpdateDownloaded(info)],
      ['update-cancelled', () => this.handleDownloadCancelled()]
    ]
  }

  initialise(): ApplicationUpdateState {
    if (this.initialised || this.disposed || !this.state.eligible) return this.getState()
    const updater = this.options.updater
    if (!updater) return this.getState()

    this.initialised = true
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.autoRunAppAfterInstall = true
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.disableWebInstaller = true
    updater.forceDevUpdateConfig = false
    updater.fullChangelog = true
    for (const [event, listener] of this.adapterListeners) updater.on(event, listener)
    if (this.state.automaticChecks) this.scheduleAutomaticCheck(this.automaticCheckDelayMs)
    return this.getState()
  }

  getState(): ApplicationUpdateState {
    return structuredClone(this.state)
  }

  onStateChanged(listener: (state: ApplicationUpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async setAutomaticChecks(enabled: boolean): Promise<ApplicationUpdateState> {
    if (!this.state.eligible || this.disposed) return this.getState()
    try {
      await this.options.preferences.setAutomaticChecks(enabled)
    } catch (error) {
      this.publish({ phase: 'error', failure: failureFrom(error, 'preference-save-failed') })
      return this.getState()
    }

    this.cancelAutomaticCheck()
    this.publish({ automaticChecks: enabled, failure: null })
    if (enabled && this.initialised) this.scheduleAutomaticCheck(this.automaticCheckDelayMs)
    return this.getState()
  }

  check(source: 'manual' | 'automatic' = 'manual'): Promise<ApplicationUpdateState> {
    if (!this.canUseUpdater() || this.state.phase === 'downloading' || this.state.phase === 'installing') {
      return Promise.resolve(this.getState())
    }
    if (this.checkPromise) return this.checkPromise

    this.cancelAutomaticCheck()
    this.publish({ phase: 'checking', failure: null, downloadProgress: null })
    const updater = this.options.updater!
    this.checkPromise = updater.checkForUpdates()
      .then(() => {
        if (this.state.phase === 'checking') {
          this.publish({ phase: 'idle', lastCheckedAt: this.now().toISOString() })
        }
        return this.getState()
      })
      .catch((error) => {
        this.handleError(error)
        return this.getState()
      })
      .finally(() => {
        this.checkPromise = null
        if (source === 'automatic' || this.state.automaticChecks) {
          this.scheduleAutomaticCheck(this.automaticCheckIntervalMs)
        }
      })
    return this.checkPromise
  }

  download(): Promise<ApplicationUpdateState> {
    const canDownload = this.state.phase === 'available' || (this.state.phase === 'error' && this.state.availableUpdate !== null)
    if (!this.canUseUpdater() || !canDownload) return Promise.resolve(this.getState())
    if (this.downloadPromise) return this.downloadPromise

    this.publish({
      phase: 'downloading',
      failure: null,
      downloadProgress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }
    })
    this.downloadPromise = this.options.updater!.downloadUpdate()
      .then(() => this.getState())
      .catch((error) => {
        this.handleError(error, 'download-failed')
        return this.getState()
      })
      .finally(() => { this.downloadPromise = null })
    return this.downloadPromise
  }

  install(): ApplicationUpdateState {
    if (!this.canUseUpdater() || this.state.phase !== 'downloaded') return this.getState()
    this.publish({ phase: 'installing', failure: null })
    try {
      // electron-updater 6.8.9 positional API: visible installer, then relaunch Fovea.
      this.options.updater!.quitAndInstall(false, true)
    } catch (error) {
      this.handleError(error, 'install-failed')
    }
    return this.getState()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelAutomaticCheck()
    const updater = this.options.updater
    if (this.initialised && updater) {
      for (const [event, listener] of this.adapterListeners) updater.off(event, listener)
    }
    this.listeners.clear()
  }

  private canUseUpdater(): boolean {
    return this.state.eligible && this.initialised && !this.disposed && this.options.updater !== undefined
  }

  private handleChecking(): void {
    if (!this.canUseUpdater()) return
    this.publish({ phase: 'checking', failure: null })
  }

  private handleUpdateAvailable(value: unknown): void {
    if (!this.canUseUpdater()) return
    this.publish({
      phase: 'available',
      lastCheckedAt: this.now().toISOString(),
      availableUpdate: normaliseUpdateInfo(value, this.state.currentVersion),
      downloadProgress: null,
      failure: null
    })
  }

  private handleUpdateNotAvailable(): void {
    if (!this.canUseUpdater()) return
    this.publish({
      phase: 'up-to-date',
      lastCheckedAt: this.now().toISOString(),
      availableUpdate: null,
      downloadProgress: null,
      failure: null
    })
  }

  private handleDownloadProgress(value: unknown): void {
    if (!this.canUseUpdater()) return
    this.publish({ phase: 'downloading', downloadProgress: normaliseProgress(value), failure: null })
  }

  private handleUpdateDownloaded(value: unknown): void {
    if (!this.canUseUpdater()) return
    const downloaded = normaliseUpdateInfo(value, this.state.availableUpdate?.version ?? this.state.currentVersion)
    const previous = this.state.availableUpdate
    this.publish({
      phase: 'downloaded',
      availableUpdate: {
        version: downloaded.version,
        releaseName: downloaded.releaseName ?? previous?.releaseName ?? null,
        releaseDate: downloaded.releaseDate ?? previous?.releaseDate ?? null,
        releaseNotes: downloaded.releaseNotes.length > 0 ? downloaded.releaseNotes : previous?.releaseNotes ?? []
      },
      downloadProgress: this.state.downloadProgress
        ? { ...this.state.downloadProgress, percent: 100, transferred: this.state.downloadProgress.total }
        : null,
      failure: null
    })
  }

  private handleDownloadCancelled(): void {
    if (!this.canUseUpdater()) return
    this.publish({
      phase: this.state.availableUpdate ? 'available' : 'idle',
      downloadProgress: null,
      failure: null
    })
  }

  private handleError(error: unknown, fallback: UpdateFailureCode = 'unexpected'): void {
    if (!this.canUseUpdater()) return
    this.publish({
      phase: 'error',
      lastCheckedAt: this.state.phase === 'checking' ? this.now().toISOString() : this.state.lastCheckedAt,
      downloadProgress: null,
      failure: failureFrom(error, fallback)
    })
  }

  private scheduleAutomaticCheck(delayMs: number): void {
    if (!this.state.automaticChecks || !this.canUseUpdater() || this.automaticTimer) return
    this.automaticTimer = this.schedule(() => {
      this.automaticTimer = null
      void this.check('automatic')
    }, delayMs)
  }

  private cancelAutomaticCheck(): void {
    if (!this.automaticTimer) return
    this.cancelScheduled(this.automaticTimer)
    this.automaticTimer = null
  }

  private publish(patch: Partial<ApplicationUpdateState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    const snapshot = this.getState()
    for (const listener of this.listeners) listener(structuredClone(snapshot))
  }
}

export function parseUpdateReleaseMarker(value: unknown): UpdateReleaseMarker | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<UpdateReleaseMarker>
  if (
    candidate.schemaVersion !== UPDATE_RELEASE_MARKER_SCHEMA_VERSION ||
    candidate.enabled !== true ||
    candidate.provider !== 'github' ||
    candidate.channel !== 'latest' ||
    candidate.integrity !== 'sha512-and-authenticode' ||
    candidate.installMode !== 'user-confirmed' ||
    typeof candidate.repository !== 'string' ||
    typeof candidate.publisherName !== 'string' ||
    candidate.publisherName.trim() !== candidate.publisherName ||
    candidate.publisherName.length < 1 ||
    candidate.publisherName.length > 200 ||
    !Array.isArray(candidate.architectures) ||
    candidate.architectures.length < 1 ||
    !candidate.architectures.every((architecture) => typeof architecture === 'string' && architecture.length > 0)
  ) return null
  return structuredClone(candidate as UpdateReleaseMarker)
}

function determineUnavailableReason(options: UpdateControllerOptions): UpdateUnavailableReason | null {
  if (!options.runtime.isPackaged) return 'development-build'
  if (options.runtime.platform !== 'win32') return 'platform-unsupported'
  if (options.runtime.releaseMarker === undefined || options.runtime.releaseMarker === null) return 'release-unmarked'
  const marker = parseUpdateReleaseMarker(options.runtime.releaseMarker)
  if (!marker || marker.repository !== (options.expectedRepository ?? DEFAULT_REPOSITORY)) return 'release-marker-invalid'
  if (!marker.architectures.includes(options.runtime.architecture)) return 'architecture-unsupported'
  if (!options.updater) return 'updater-unavailable'
  return null
}

function normaliseUpdateInfo(value: unknown, fallbackVersion: string): AvailableApplicationUpdate {
  const info = value && typeof value === 'object' ? value as UpdateInfoLike : {}
  return {
    version: safeVersion(info.version, fallbackVersion),
    releaseName: safeOptionalText(info.releaseName, 500),
    releaseDate: safeDate(info.releaseDate),
    releaseNotes: normaliseReleaseNotes(info.releaseNotes)
  }
}

function normaliseReleaseNotes(value: unknown): string[] {
  const notes: string[] = []
  if (typeof value === 'string') notes.push(value)
  else if (Array.isArray(value)) {
    for (const entry of value.slice(0, 50)) {
      if (typeof entry === 'string') notes.push(entry)
      else if (entry && typeof entry === 'object') {
        const note = (entry as { note?: unknown }).note
        if (typeof note === 'string') notes.push(note)
      }
    }
  }
  return notes
    .map(toPlainText)
    .filter((note) => note.length > 0)
    .slice(0, 50)
}

function toPlainText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim()
    .slice(0, MAX_RELEASE_NOTE_LENGTH)
}

function normaliseProgress(value: unknown): ApplicationUpdateProgress {
  const progress = value && typeof value === 'object' ? value as ProgressInfoLike : {}
  const total = nonNegativeNumber(progress.total)
  const transferred = Math.min(nonNegativeNumber(progress.transferred), total || Number.MAX_SAFE_INTEGER)
  return {
    percent: Math.min(100, Math.max(0, finiteNumber(progress.percent))),
    transferred,
    total,
    bytesPerSecond: nonNegativeNumber(progress.bytesPerSecond)
  }
}

function failureFrom(error: unknown, fallback: UpdateFailureCode): UpdateFailure {
  const detail = error instanceof Error ? error.message : String(error)
  const lower = detail.toLowerCase()
  let code = fallback
  if (/invalid.signature|not signed|publisher|authenticode/.test(lower)) code = 'invalid-signature'
  else if (/sha-?512|checksum|integrity|hash.*mismatch/.test(lower)) code = 'integrity-check-failed'
  else if (/offline|network|enotfound|econn|dns|fetch failed/.test(lower)) code = 'network'
  else if (/app-update\.yml|no published versions|release feed|latest\.yml|404/.test(lower)) code = 'feed-unavailable'

  const presentations: Record<UpdateFailureCode, Omit<UpdateFailure, 'code' | 'technicalDetails'>> = {
    network: { title: 'Update check unavailable', message: 'Check the network connection, then try again.', retryable: true },
    'feed-unavailable': { title: 'Update information unavailable', message: 'Fovea could not read the signed release feed. Normal use is unaffected.', retryable: true },
    'invalid-signature': { title: 'Update signature rejected', message: 'The update was not signed by the expected Fovea publisher and was not installed.', retryable: false },
    'integrity-check-failed': { title: 'Update integrity check failed', message: 'The downloaded update did not match its release metadata and was discarded.', retryable: true },
    'download-failed': { title: 'Update download failed', message: 'Fovea could not download the update. Normal use is unaffected.', retryable: true },
    'install-failed': { title: 'Update could not start', message: 'Fovea could not start the installer. You can keep using this version.', retryable: true },
    'preference-save-failed': { title: 'Update preference not saved', message: 'Fovea could not save the automatic-check setting.', retryable: true },
    unexpected: { title: 'Update failed', message: 'Fovea could not complete the update operation. Normal use is unaffected.', retryable: true }
  }
  return { code, ...presentations[code], technicalDetails: safeTechnicalDetails(detail) }
}

function safeTechnicalDetails(value: string): string {
  return value
    .replace(/(?:access|refresh)[_-]?token["'=:\s]+\S+/gi, 'token=[REDACTED]')
    .replace(/(?:ghp|github_pat|key|sk)-[A-Za-z0-9_-]+/gi, '[REDACTED_SECRET]')
    .replace(/[A-Z]:\\Users\\[^\\\s]+\\[^\s"']*/gi, '[LOCAL_PATH]')
    .slice(0, 500)
}

function safeAutomaticPreference(preferences: UpdatePreferences): boolean {
  try { return preferences.getAutomaticChecks() === true } catch { return false }
}

function safeVersion(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value) ? value : fallback
}

function safeOptionalText(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.trim() ? toPlainText(value).slice(0, limit) : null
}

function safeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function nonNegativeNumber(value: unknown): number {
  return Math.max(0, finiteNumber(value))
}

function positiveDelay(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
