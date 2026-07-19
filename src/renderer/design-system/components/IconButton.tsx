import { forwardRef, type ReactNode } from 'react'

import { classNames } from '../internal/classNames'
import { Button, type ButtonProps } from './Button'

export interface IconButtonProps extends Omit<ButtonProps, 'aria-label' | 'children' | 'variant'> {
  icon: ReactNode
  label: string
  variant?: Exclude<ButtonProps['variant'], 'primary'>
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, icon, label, variant = 'ghost', ...buttonProps },
  ref
) {
  if (label.trim().length === 0) {
    throw new Error('IconButton requires a non-empty accessible label.')
  }

  return (
    <Button
      {...buttonProps}
      aria-label={label}
      className={classNames('fui-icon-button', className)}
      ref={ref}
      variant={variant}
    >
      <span aria-hidden="true" className="fui-icon-button__icon">
        {icon}
      </span>
    </Button>
  )
})
