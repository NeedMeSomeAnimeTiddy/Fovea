import type { AppError, AppRecoveryKind } from '@shared/types/app-error'
import { isAppError } from '../../shared/types/app-error'
import type { ResponsePhase, SpectralEdgeState } from '@shared/types/app'
import { Badge, Button, Spinner, StatusBanner, type BadgeTone } from '../design-system'
import './status.css'

export interface AppStatusNoticeProps {
  error: AppError
  onRecovery?: (recovery: AppRecoveryKind) => void
}

export function AppStatusNotice({ error, onRecovery }: AppStatusNoticeProps): React.JSX.Element {
  const label = recoveryLabel(error.recovery)
  return (
    <StatusBanner role="alert" tone="error" title={error.title}>
      <p className="app-status__message">{error.message}</p>
      {label && onRecovery ? (
        <Button size="compact" variant="secondary" onClick={() => onRecovery(error.recovery)}>{label}</Button>
      ) : null}
      {error.technicalDetails ? (
        <details className="app-status__details">
          <summary>Technical details</summary>
          <code>{error.technicalDetails}</code>
        </details>
      ) : null}
    </StatusBanner>
  )
}

export function ResponseStatus({ phase }: { phase: ResponsePhase }): React.JSX.Element {
  const presentation = responsePresentation(phase)
  const icon = presentation.busy ? <Spinner size="small" /> : <span aria-hidden="true">{presentation.symbol}</span>
  return <Badge className="response-status" icon={icon} role="status" tone={presentation.tone}>{presentation.label}</Badge>
}

export function spectralStateForPhase(phase: ResponsePhase): SpectralEdgeState {
  if (phase === 'connecting') return 'connecting'
  if (phase === 'thinking') return 'thinking'
  if (phase === 'streaming') return 'streaming'
  if (phase === 'completed') return 'completed'
  if (phase === 'stopped') return 'stopped'
  if (phase === 'failed') return 'error'
  return 'idle'
}

export function appErrorFromUnknown(reason: unknown): AppError {
  if (isAppError(reason)) return reason
  return {
    code: 'unexpected',
    title: 'Something went wrong',
    message: 'Fovea could not complete the operation.',
    recovery: 'retry'
  }
}

export function recoveryLabel(recovery: AppRecoveryKind): string | null {
  return ({
    authenticate: 'Sign in',
    'open-settings': 'Open Settings',
    retry: 'Try again',
    'choose-provider': 'Choose provider',
    recapture: 'New capture',
    none: null
  })[recovery]
}

function responsePresentation(phase: ResponsePhase): { label: string; tone: BadgeTone; busy: boolean; symbol: string } {
  const presentations: Record<ResponsePhase, { label: string; tone: BadgeTone; busy: boolean; symbol: string }> = {
    idle: { label: 'Ready', tone: 'neutral', busy: false, symbol: '•' },
    connecting: { label: 'Connecting…', tone: 'info', busy: true, symbol: '' },
    thinking: { label: 'Thinking…', tone: 'info', busy: true, symbol: '' },
    streaming: { label: 'Answering…', tone: 'info', busy: true, symbol: '' },
    'awaiting-approval': { label: 'Needs approval', tone: 'warning', busy: false, symbol: '!' },
    stopped: { label: 'Stopped', tone: 'warning', busy: false, symbol: '■' },
    completed: { label: 'Complete', tone: 'success', busy: false, symbol: '✓' },
    failed: { label: 'Failed', tone: 'error', busy: false, symbol: '×' }
  }
  return presentations[phase]
}
