import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'

import { classNames } from '../internal/classNames'

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode
  icon?: ReactNode
  tone?: BadgeTone
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { children, className, icon, tone = 'neutral', ...badgeProps },
  ref
) {
  return (
    <span {...badgeProps} className={classNames('fui-badge', className)} data-tone={tone} ref={ref}>
      {icon ? (
        <span aria-hidden="true" className="fui-badge__icon">
          {icon}
        </span>
      ) : null}
      <span className="fui-badge__text">{children}</span>
    </span>
  )
})
