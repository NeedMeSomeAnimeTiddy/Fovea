import { IconButton, Tooltip } from '../design-system'

export interface QuestionTitlebarActionsProps {
  compact: boolean
  layoutDisabled?: boolean
  pinned: boolean
  onToggleCompact(): void
  onTogglePinned(): void
}

export function QuestionTitlebarActions({ compact, layoutDisabled = false, pinned, onToggleCompact, onTogglePinned }: QuestionTitlebarActionsProps): React.JSX.Element {
  const layoutLabel = compact ? 'Use expanded layout' : 'Use compact layout'
  const pinLabel = pinned ? 'Stop keeping this window on top' : 'Keep this window on top'
  return (
    <>
      <Tooltip content={layoutLabel}>
        <IconButton
          aria-pressed={compact}
          className="fui-window-controls__button"
          disabled={layoutDisabled}
          icon={<LayoutIcon compact={compact} />}
          label={layoutLabel}
          onClick={onToggleCompact}
        />
      </Tooltip>
      <Tooltip content={pinned ? 'Stop keeping on top' : 'Keep on top'}>
        <IconButton
          aria-pressed={pinned}
          className="fui-window-controls__button"
          icon={<PinIcon />}
          label={pinLabel}
          onClick={onTogglePinned}
        />
      </Tooltip>
    </>
  )
}

function LayoutIcon({ compact }: { compact: boolean }): React.JSX.Element {
  return (
    <svg aria-hidden="true" fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24">
      {compact
        ? <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /><path d="m8 8-5-5m13 5 5-5M8 16l-5 5m13-5 5 5" /></>
        : <><path d="M9 9H4V4M15 9h5V4M9 15H4v5M15 15h5v5" /><path d="M4 4l5 5m11-5-5 5M4 20l5-5m11 5-5-5" /></>}
    </svg>
  )
}

function PinIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24">
      <path d="m8 3 8 8m-6.5-6.5 7-1-1 7 3 3-5 5-3-3L5 20l3.5-4.5-3-3 5-5Z" />
    </svg>
  )
}
