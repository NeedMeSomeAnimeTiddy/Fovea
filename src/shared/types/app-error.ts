export type AppErrorCode =
  | 'authentication-required'
  | 'offline'
  | 'timeout'
  | 'rate-limited'
  | 'provider-unavailable'
  | 'no-compatible-models'
  | 'sidecar-terminated'
  | 'capture-failed'
  | 'validation'
  | 'unexpected'

export type AppRecoveryKind =
  | 'authenticate'
  | 'open-settings'
  | 'retry'
  | 'choose-provider'
  | 'recapture'
  | 'none'

export interface AppError {
  code: AppErrorCode
  title: string
  message: string
  recovery: AppRecoveryKind
  technicalDetails?: string
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError }

export function isAppError(value: unknown): value is AppError {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AppError>
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.recovery === 'string'
  )
}
