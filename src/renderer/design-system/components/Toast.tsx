import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode
} from 'react'

import { classNames } from '../internal/classNames'
import { StatusIcon, type StatusBannerRole, type StatusBannerTone } from './StatusBanner'

export type ToastPlacement = 'top' | 'top-end' | 'bottom-end'

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'title'> {
  children: ReactNode
  duration?: number
  icon?: ReactNode
  onDismiss?: () => void
  resetKey?: string | number
  role?: StatusBannerRole
  title?: ReactNode
  tone?: StatusBannerTone
}

export interface ToastViewportProps extends HTMLAttributes<HTMLDivElement> {
  placement?: ToastPlacement
}

export function Toast({
  children,
  className,
  duration = 6000,
  icon,
  onBlurCapture,
  onDismiss,
  onFocusCapture,
  onMouseEnter,
  onMouseLeave,
  resetKey,
  role = 'status',
  title,
  tone = 'info',
  ...toastProps
}: ToastProps): React.JSX.Element | null {
  const [visible, setVisible] = useState(true)
  const [paused, setPaused] = useState(false)
  const dismissRef = useRef(onDismiss)

  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    setVisible(true)
    setPaused(false)
  }, [resetKey])

  useEffect(() => {
    if (!visible || paused || duration <= 0) return
    const timeout = window.setTimeout(() => {
      setVisible(false)
      dismissRef.current?.()
    }, duration)
    return () => window.clearTimeout(timeout)
  }, [duration, paused, resetKey, visible])

  const dismiss = (): void => {
    setVisible(false)
    dismissRef.current?.()
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const nextTarget = event.relatedTarget as Node | null
    if (!nextTarget || !event.currentTarget.contains(nextTarget)) setPaused(false)
    onBlurCapture?.(event)
  }

  const handleFocus = (event: FocusEvent<HTMLDivElement>): void => {
    setPaused(true)
    onFocusCapture?.(event)
  }

  const handleMouseEnter = (event: MouseEvent<HTMLDivElement>): void => {
    setPaused(true)
    onMouseEnter?.(event)
  }

  const handleMouseLeave = (event: MouseEvent<HTMLDivElement>): void => {
    setPaused(false)
    onMouseLeave?.(event)
  }

  if (!visible) return null

  return (
    <div
      {...toastProps}
      className={classNames('fui-toast', className)}
      data-tone={tone}
      onBlurCapture={handleBlur}
      onFocusCapture={handleFocus}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role={role}
    >
      <span aria-hidden="true" className="fui-toast__icon">
        {icon ?? <StatusIcon tone={tone} />}
      </span>
      <div className="fui-toast__content">
        {title ? <div className="fui-toast__title">{title}</div> : null}
        <div className="fui-toast__message">{children}</div>
      </div>
      <button aria-label="Dismiss notification" className="fui-toast__close" onClick={dismiss} type="button">
        <svg aria-hidden="true" fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 16 16">
          <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
        </svg>
      </button>
    </div>
  )
}

export function ToastViewport({
  children,
  className,
  placement = 'top-end',
  ...viewportProps
}: ToastViewportProps): React.JSX.Element {
  return (
    <div
      {...viewportProps}
      className={classNames('fui-toast-viewport', className)}
      data-placement={placement}
    >
      {children}
    </div>
  )
}
