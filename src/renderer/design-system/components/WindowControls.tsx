import { type HTMLAttributes, type SVGProps } from 'react'

import { classNames } from '../internal/classNames'
import { IconButton } from './IconButton'

type WindowIconProps = SVGProps<SVGSVGElement>

function WindowIcon(props: WindowIconProps): React.JSX.Element {
  return (
    <svg
      {...props}
      aria-hidden="true"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
    />
  )
}

function MinimizeIcon(): React.JSX.Element {
  return (
    <WindowIcon>
      <path d="M6 12h12" />
    </WindowIcon>
  )
}

function MaximizeIcon(): React.JSX.Element {
  return (
    <WindowIcon>
      <rect height="12" rx="1" width="12" x="6" y="6" />
    </WindowIcon>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <WindowIcon>
      <path d="m7 7 10 10" />
      <path d="M17 7 7 17" />
    </WindowIcon>
  )
}

export interface WindowControlsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  closeLabel?: string
  maximizeLabel?: string
  minimizeLabel?: string
  onClose: () => void
  onMaximize?: () => void
  onMinimize?: () => void
}

export function WindowControls({
  className,
  closeLabel = 'Close window',
  maximizeLabel = 'Maximize window',
  minimizeLabel = 'Minimize window',
  onClose,
  onMaximize,
  onMinimize,
  ...controlsProps
}: WindowControlsProps): React.JSX.Element {
  return (
    <div {...controlsProps} className={classNames('fui-window-controls', className)}>
      {onMinimize ? (
        <IconButton
          className="fui-window-controls__button"
          icon={<MinimizeIcon />}
          label={minimizeLabel}
          onClick={onMinimize}
          variant="ghost"
        />
      ) : null}
      {onMaximize ? (
        <IconButton
          className="fui-window-controls__button"
          icon={<MaximizeIcon />}
          label={maximizeLabel}
          onClick={onMaximize}
          variant="ghost"
        />
      ) : null}
      <IconButton
        className="fui-window-controls__button fui-window-controls__button--close"
        icon={<CloseIcon />}
        label={closeLabel}
        onClick={onClose}
        variant="ghost"
      />
    </div>
  )
}
