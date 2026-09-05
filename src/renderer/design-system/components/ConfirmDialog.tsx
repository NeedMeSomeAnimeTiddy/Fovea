import { useId, type ReactNode } from 'react'

import { classNames } from '../internal/classNames'
import { useModalDialog } from '../internal/useModalDialog'
import { Button } from './Button'
import { Card } from './Card'

export type ConfirmDialogTone = 'default' | 'danger'

export interface ConfirmDialogProps {
  /** Heading; also names the dialog for assistive technology unless `label` is given. */
  title: string
  /** Accessible name when the visible title should not be used verbatim, e.g. it ends with a question mark. */
  label?: string
  /** Supporting copy explaining what confirming will do. */
  children: ReactNode
  /** Optional emphasised line above the code line, such as a host name. */
  destinationLabel?: ReactNode
  /** Optional verbatim value the user is about to act on, such as a URL or address. */
  destination?: ReactNode
  /** Omit together with `onConfirm` for an acknowledgement that only offers the cancel action. */
  confirmLabel?: string
  cancelLabel?: string
  /** `danger` is for irreversible or destructive confirmations. */
  tone?: ConfirmDialogTone
  /** While busy the confirming action shows progress and the dialog cannot be dismissed. */
  busy?: boolean
  busyLabel?: string
  /** Inline failure explanation shown after a rejected confirmation. */
  error?: ReactNode
  /** Element to refocus when the dialog closes; defaults to whatever was focused when it opened. */
  returnFocus?: HTMLElement | null
  className?: string
  onConfirm?(): void
  onCancel(): void
}

/**
 * A renderer-owned confirmation modal. It replaces `window.confirm`, which in Electron is a
 * blocking native dialog outside the visual language, while keeping the same contract: the
 * user must answer before continuing, Escape and the cancel action decline, and focus returns
 * to the control that opened it.
 */
export function ConfirmDialog({
  busy = false,
  busyLabel = 'Working',
  cancelLabel = 'Cancel',
  children,
  className,
  confirmLabel,
  destination,
  destinationLabel,
  error,
  label,
  onCancel,
  onConfirm,
  returnFocus,
  title,
  tone = 'default'
}: ConfirmDialogProps): React.JSX.Element {
  const dialogRef = useModalDialog<HTMLElement>({ canCancel: !busy, onCancel, returnFocus })
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const titleId = `fui-confirm-dialog-${generatedId}-title`
  const bodyId = `fui-confirm-dialog-${generatedId}-body`
  const hasDestination = destination !== undefined && destination !== null && destination !== ''

  return (
    <div className="fui-confirm-dialog__backdrop" role="presentation">
      <Card
        ref={dialogRef}
        as="section"
        aria-describedby={bodyId}
        aria-label={label}
        aria-labelledby={label ? undefined : titleId}
        aria-modal="true"
        className={classNames('fui-confirm-dialog', className)}
        data-tone={tone}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="fui-confirm-dialog__title" id={titleId}>{title}</h2>
        <div className="fui-confirm-dialog__body" id={bodyId}>{children}</div>
        {(hasDestination || destinationLabel) && (
          <div className="fui-confirm-dialog__destination">
            {destinationLabel ? <strong>{destinationLabel}</strong> : null}
            {hasDestination ? <code>{destination}</code> : null}
          </div>
        )}
        {error ? <p className="fui-confirm-dialog__error" role="alert">{error}</p> : null}
        <div className="fui-confirm-dialog__actions">
          <Button data-modal-initial-focus disabled={busy} variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          {confirmLabel !== undefined && (
            <Button
              loading={busy}
              loadingLabel={busyLabel}
              variant={tone === 'danger' ? 'danger' : 'primary'}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          )}
        </div>
      </Card>
    </div>
  )
}
