import { IconButton, Tooltip } from '../design-system'

export interface QuestionTitlebarActionsProps {
  pinned: boolean
  onTogglePinned(): void
  onExport?(): void
}

export function QuestionTitlebarActions({ pinned, onTogglePinned, onExport = () => undefined }: QuestionTitlebarActionsProps): React.JSX.Element {
  const label = pinned ? 'Stop keeping this window on top' : 'Keep this window on top'
  return (<>
    <Tooltip content="Export conversation">
      <IconButton className="fui-window-controls__button" icon={<ExportIcon />} label="Export conversation" onClick={onExport} />
    </Tooltip>
    <Tooltip content={pinned ? 'Stop keeping on top' : 'Keep on top'}>
      <IconButton
        aria-pressed={pinned}
        className="fui-window-controls__button"
        icon={<PinIcon />}
        label={label}
        onClick={onTogglePinned}
      />
    </Tooltip>
  </>)
}

function ExportIcon(): React.JSX.Element {
  return <svg aria-hidden="true" fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M5 14v6h14v-6" /></svg>
}

function PinIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24">
      <path d="m8 3 8 8m-6.5-6.5 7-1-1 7 3 3-5 5-3-3L5 20l3.5-4.5-3-3 5-5Z" />
    </svg>
  )
}
