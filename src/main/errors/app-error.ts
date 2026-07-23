import type { AppError, AppErrorCode, AppRecoveryKind, IpcResult } from '@shared/types/app-error'

export class FoveaError extends Error {
  readonly appError: AppError

  constructor(appError: AppError) {
    super(appError.message)
    this.name = 'FoveaError'
    this.appError = appError
  }
}

export function createAppError(
  code: AppErrorCode,
  title: string,
  message: string,
  recovery: AppRecoveryKind,
  technicalDetails?: string
): AppError {
  const safeDetails = technicalDetails ? redactTechnicalDetails(technicalDetails) : undefined
  return { code, title, message, recovery, ...(safeDetails ? { technicalDetails: safeDetails } : {}) }
}

export function toAppError(error: unknown, fallbackCode: AppErrorCode = 'unexpected'): AppError {
  if (error instanceof FoveaError) return structuredClone(error.appError)
  if (isAbort(error)) {
    return createAppError('validation', 'Request stopped', 'The request was stopped.', 'none')
  }

  const detail = rawMessage(error)
  const lower = detail.toLowerCase()
  if (/\b(?:401|403)\b|unauthori[sz]ed|invalid api key|sign(?:ed)?[- ]out|authentication required/.test(lower)) {
    return createAppError('authentication-required', 'Authentication required', 'Sign in again or update this provider profile before continuing.', 'authenticate', detail)
  }
  if (/\b429\b|rate limit|too many requests/.test(lower)) {
    return createAppError('rate-limited', 'Provider is busy', 'The provider rate limit was reached. Wait a moment, then try again.', 'retry', detail)
  }
  if (/\b(?:408|504)\b|timed? out|timeout/.test(lower)) {
    return createAppError('timeout', 'Request timed out', 'The operation took too long to complete. Try again when the connection is stable.', 'retry', detail)
  }
  if (/fetch failed|network|enotfound|econnrefused|econnreset|internet|offline|dns/.test(lower)) {
    return createAppError('offline', 'You appear to be offline', 'Check the network connection, then try again.', 'retry', detail)
  }
  if (/no (?:image-capable|compatible).*model|models? (?:are|is) .*unavailable/.test(lower)) {
    return createAppError('no-compatible-models', 'No compatible models', 'This profile does not currently offer an image-capable model.', 'choose-provider', detail)
  }
  if (/codex app-server|local codex service|sidecar/.test(lower)) {
    return createAppError('sidecar-terminated', 'Local service unavailable', 'The local ChatGPT service stopped unexpectedly. Fovea will try to reconnect.', 'retry', detail)
  }
  if (/provider|model request|service unavailable|\b5\d\d\b/.test(lower)) {
    return createAppError('provider-unavailable', 'Provider unavailable', 'The selected provider could not complete the operation.', 'open-settings', detail)
  }

  const defaults: Record<AppErrorCode, Omit<AppError, 'code' | 'technicalDetails'>> = {
    'authentication-required': { title: 'Authentication required', message: 'Sign in again before continuing.', recovery: 'authenticate' },
    offline: { title: 'You appear to be offline', message: 'Check the network connection, then try again.', recovery: 'retry' },
    timeout: { title: 'Request timed out', message: 'The operation took too long to complete.', recovery: 'retry' },
    'rate-limited': { title: 'Provider is busy', message: 'Wait a moment, then try again.', recovery: 'retry' },
    'provider-unavailable': { title: 'Provider unavailable', message: 'The selected provider could not complete the operation.', recovery: 'open-settings' },
    'no-compatible-models': { title: 'No compatible models', message: 'Choose another provider profile or test the connection.', recovery: 'choose-provider' },
    'sidecar-terminated': { title: 'Local service unavailable', message: 'The local ChatGPT service stopped unexpectedly.', recovery: 'retry' },
    'capture-failed': { title: 'Capture failed', message: 'Fovea could not capture that content.', recovery: 'recapture' },
    validation: { title: 'Check this value', message: safeValidationMessage(detail), recovery: 'none' },
    unexpected: { title: 'Something went wrong', message: 'Fovea could not complete the operation.', recovery: 'retry' }
  }
  const fallback = defaults[fallbackCode]
  return createAppError(fallbackCode, fallback.title, fallback.message, fallback.recovery, detail)
}

export async function toIpcResult<T>(operation: () => T | Promise<T>, fallbackCode?: AppErrorCode): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error: toAppError(error, fallbackCode) }
  }
}

export function redactTechnicalDetails(value: string): string {
  return value
    .replace(/(?:sk|key)-[A-Za-z0-9_-]+/gi, '[REDACTED_API_KEY]')
    .replace(/https?:\/\/\S*(?:oauth|authorize|callback)\S*/gi, '[REDACTED_AUTH_URL]')
    .replace(/(?:access|refresh)[_-]?token["'=:\s]+\S+/gi, 'token=[REDACTED]')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[REDACTED_IMAGE]')
    .slice(0, 500)
}

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeValidationMessage(detail: string): string {
  const safe = redactTechnicalDetails(detail)
  return safe && safe.length <= 200 ? safe : 'Check the supplied value and try again.'
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /request stopped|aborted|cancelled/i.test(error.message))
}
