import { forwardRef, type HTMLAttributes, type ReactNode, type SVGProps } from 'react'

import { classNames } from '../internal/classNames'

export type StatusBannerTone = 'info' | 'success' | 'warning' | 'error'
export type StatusBannerRole = 'status' | 'alert'

export interface StatusBannerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'title'> {
  children: ReactNode
  icon?: ReactNode
  role?: StatusBannerRole
  title?: ReactNode
  tone?: StatusBannerTone
}

interface StatusIconProps extends SVGProps<SVGSVGElement> {
  tone: StatusBannerTone
}

function StatusIcon({ tone, ...svgProps }: StatusIconProps): React.JSX.Element {
  const sharedProps = {
    ...svgProps,
    'aria-hidden': true,
    fill: 'none',
    focusable: 'false' as const,
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.75,
    viewBox: '0 0 24 24'
  }

  if (tone === 'success') {
    return (
      <svg {...sharedProps}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 2.6 2.6L16.5 9" />
      </svg>
    )
  }

  if (tone === 'warning') {
    return (
      <svg {...sharedProps}>
        <path d="M10.2 4.3 2.8 17.1A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.9L13.8 4.3a2 2 0 0 0-3.6 0Z" />
        <path d="M12 9v4" />
        <path d="M12 16.5h.01" />
      </svg>
    )
  }

  if (tone === 'error') {
    return (
      <svg {...sharedProps}>
        <circle cx="12" cy="12" r="9" />
        <path d="m9 9 6 6" />
        <path d="m15 9-6 6" />
      </svg>
    )
  }

  return (
    <svg {...sharedProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  )
}

export const StatusBanner = forwardRef<HTMLDivElement, StatusBannerProps>(function StatusBanner(
  { children, className, icon, role = 'status', title, tone = 'info', ...bannerProps },
  ref
) {
  return (
    <div
      {...bannerProps}
      className={classNames('fui-status-banner', className)}
      data-tone={tone}
      ref={ref}
      role={role}
    >
      <span aria-hidden="true" className="fui-status-banner__icon">
        {icon ?? <StatusIcon tone={tone} />}
      </span>
      <div className="fui-status-banner__content">
        {title ? <div className="fui-status-banner__title">{title}</div> : null}
        <div className="fui-status-banner__message">{children}</div>
      </div>
    </div>
  )
})
