import { forwardRef, type HTMLAttributes } from 'react'

import { classNames } from '../internal/classNames'

export type SpinnerSize = 'small' | 'default' | 'large'

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  label?: string
  size?: SpinnerSize
}

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { className, label, size = 'default', ...spinnerProps },
  ref
) {
  return (
    <span
      {...spinnerProps}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={classNames('fui-spinner', className)}
      data-size={size}
      ref={ref}
      role={label ? 'status' : undefined}
    />
  )
})
