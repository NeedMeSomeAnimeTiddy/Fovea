import { useState } from 'react'
import type { ConversationExportOptions, ConversationExportPreview } from '@shared/types/app'
import { Button, Card, Select, StatusBanner, Switch } from '../design-system'
import { useModalDialog } from '../design-system/internal/useModalDialog'
import './conversation-export.css'

export function ConversationExportDialog({
  preview,
  busy,
  onCancel,
  onExport,
  returnFocus
}: {
  preview: ConversationExportPreview
  busy: boolean
  onCancel(): void
  onExport(options: ConversationExportOptions): Promise<void>
  returnFocus?: HTMLElement | null
}): React.JSX.Element {
  const [format, setFormat] = useState<ConversationExportOptions['format']>('markdown')
  const [includeScreenshots, setIncludeScreenshots] = useState(false)
  const [includeProviderMetadata, setIncludeProviderMetadata] = useState(false)
  const dialogRef = useModalDialog<HTMLElement>({ canCancel: !busy, onCancel, returnFocus })
  return <div className="export-dialog__backdrop" role="presentation">
    <Card ref={dialogRef} as="section" className="export-dialog" role="dialog" aria-label="Export conversation" aria-modal="true" tabIndex={-1}>
      <h2>Export conversation</h2>
      <StatusBanner title="Review sensitive content" tone="warning">
        The transcript and local OCR may contain private information. Nothing is uploaded; the export is written only to the destination you choose.
      </StatusBanner>
      <div className="export-dialog__preview">
        <strong>{preview.title}</strong>
        <small>{preview.messageCount} messages · {preview.ocrCharacterCount} OCR characters · {preview.screenshotCount} available screenshots</small>
        <p>{preview.excerpt || 'No transcript text yet.'}</p>
      </div>
      <Select label="Format" value={format} onChange={(event) => setFormat(event.target.value as ConversationExportOptions['format'])}>
        <option value="markdown">Readable Markdown</option>
        <option value="json">Versioned JSON</option>
      </Select>
      <Switch label="Include screenshot files" checked={includeScreenshots} disabled={preview.screenshotCount === 0} onChange={(event) => setIncludeScreenshots(event.target.checked)} />
      <Switch label="Include provider and model metadata" checked={includeProviderMetadata} onChange={(event) => setIncludeProviderMetadata(event.target.checked)} />
      {includeScreenshots && <p className="muted">Screenshots will be written to a deterministic asset folder beside the exported file.</p>}
      <div className="export-dialog__actions">
        <Button data-modal-initial-focus disabled={busy} variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button loading={busy} onClick={() => void onExport({ format, includeScreenshots, includeProviderMetadata })}>Choose destination</Button>
      </div>
    </Card>
  </div>
}
