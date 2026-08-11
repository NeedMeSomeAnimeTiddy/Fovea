export const UPDATE_RELEASE_MARKER_FIELD = 'foveaUpdateRelease' as const
export const UPDATE_RELEASE_MARKER_SCHEMA_VERSION = 1 as const

export interface UpdateReleaseMarker {
  schemaVersion: typeof UPDATE_RELEASE_MARKER_SCHEMA_VERSION
  enabled: true
  provider: 'github'
  repository: string
  channel: 'latest'
  architectures: string[]
  publisherName: string
  integrity: 'sha512-and-authenticode'
  installMode: 'user-confirmed'
}

export type UpdateUnavailableReason =
  | 'development-build'
  | 'platform-unsupported'
  | 'architecture-unsupported'
  | 'release-unmarked'
  | 'release-marker-invalid'
  | 'updater-unavailable'

export type UpdatePhase =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export type UpdateFailureCode =
  | 'network'
  | 'feed-unavailable'
  | 'invalid-signature'
  | 'integrity-check-failed'
  | 'download-failed'
  | 'install-failed'
  | 'preference-save-failed'
  | 'unexpected'

export interface UpdateFailure {
  code: UpdateFailureCode
  title: string
  message: string
  retryable: boolean
  technicalDetails?: string
}

export interface AvailableApplicationUpdate {
  version: string
  releaseName: string | null
  releaseDate: string | null
  releaseNotes: string[]
}

export interface ApplicationUpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface ApplicationUpdateState {
  phase: UpdatePhase
  eligible: boolean
  unavailableReason: UpdateUnavailableReason | null
  automaticChecks: boolean
  currentVersion: string
  lastCheckedAt: string | null
  availableUpdate: AvailableApplicationUpdate | null
  downloadProgress: ApplicationUpdateProgress | null
  failure: UpdateFailure | null
}
