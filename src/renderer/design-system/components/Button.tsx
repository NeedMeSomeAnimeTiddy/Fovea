import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react'

import { mergeDescribedBy } from '../internal/FieldFrame'
import { classNames } from '../internal/classNames'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'compact' | 'default'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean
  loadingLabel?: string
  size?: ButtonSize
  variant?: ButtonVariant
  children: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    disabled,
    loading = false,
    loadingLabel = 'Loading',
    size = 'default',
    type = 'button',
    variant = 'primary',
    'aria-describedby': ariaDescribedBy,
    ...buttonProps
  },
  ref
) {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const loadingDescriptionId = loading && loadingLabel.trim() ? `fui-button-${generatedId}-loading` : undefined

  return (
    <>
      <button
        {...buttonProps}
        aria-busy={loading || undefined}
        aria-describedby={mergeDescribedBy(ariaDescribedBy, loadingDescriptionId)}
        className={classNames('fui-button', className)}
        data-loading={loading || undefined}
        data-size={size}
        data-variant={variant}
        disabled={disabled || loading}
        ref={ref}
        type={type}
      >
        <span className="fui-button__content">{children}</span>
        {loading ? <Spinner className="fui-button__spinner" /> : null}
      </button>
      {loadingDescriptionId ? (
        <span className="fui-sr-only" id={loadingDescriptionId} role="status">
          {loadingLabel}
        </span>
      ) : null}
    </>
  )
})
