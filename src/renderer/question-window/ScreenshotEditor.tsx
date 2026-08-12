import { useEffect, useRef, useState } from 'react'
import type { ImageEditOperation, ImageEditPoint, ImageEditTool } from '@shared/types/app'
import { Button, TextInput } from '../design-system'
import { useModalDialog } from '../design-system/internal/useModalDialog'
import { drawEditorCanvas, isMeaningfulEdit } from '../image-editing/canvas'

const TOOLS: Array<{ tool: ImageEditTool; label: string }> = [
  { tool: 'arrow', label: 'Arrow' },
  { tool: 'rectangle', label: 'Rectangle' },
  { tool: 'freehand', label: 'Draw' },
  { tool: 'text', label: 'Text' },
  { tool: 'blur', label: 'Blur' },
  { tool: 'redact', label: 'Redact' }
]

interface ScreenshotEditorProps {
  cancelLabel?: string
  imageDataUrl: string
  saving: boolean
  onCancel(): void
  onSave(operations: ImageEditOperation[]): void
  returnFocus?: HTMLElement | null
}

export function ScreenshotEditor({ cancelLabel = 'Cancel', imageDataUrl, saving, onCancel, onSave, returnFocus }: ScreenshotEditorProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [tool, setTool] = useState<ImageEditTool>('arrow')
  const [text, setText] = useState('Label')
  const [operations, setOperations] = useState<ImageEditOperation[]>([])
  const [redo, setRedo] = useState<ImageEditOperation[]>([])
  const [draft, setDraft] = useState<ImageEditOperation | null>(null)
  const [imageVersion, setImageVersion] = useState(0)
  const dialogRef = useModalDialog<HTMLDivElement>({ canCancel: !saving, onCancel, returnFocus })

  useEffect(() => {
    const image = new Image()
    image.onload = () => {
      imageRef.current = image
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      setImageVersion((version) => version + 1)
    }
    image.src = imageDataUrl
  }, [imageDataUrl])

  useEffect(() => {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (canvas && image) drawEditorCanvas(canvas, image, operations, draft)
  }, [draft, imageVersion, operations])

  const begin = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (saving) return
    const point = pointForEvent(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'text') {
      const label = text.trim()
      if (!label) return
      commit({ id: crypto.randomUUID(), tool, points: [point], text: label, strokeWidth: 4 })
      return
    }
    setDraft({ id: crypto.randomUUID(), tool, points: [point, point], strokeWidth: 4 })
  }
  const move = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!draft || saving) return
    const point = pointForEvent(event)
    setDraft((current) => {
      if (!current) return null
      return current.tool === 'freehand'
        ? { ...current, points: [...current.points, point] }
        : { ...current, points: [current.points[0]!, point] }
    })
  }
  const finish = (): void => {
    if (!draft) return
    if (isMeaningfulEdit(draft)) commit(draft)
    setDraft(null)
  }
  const commit = (operation: ImageEditOperation): void => {
    setOperations((current) => [...current, operation])
    setRedo([])
  }
  const undo = (): void => {
    setOperations((current) => {
      const removed = current.at(-1)
      if (!removed) return current
      setRedo((items) => [...items, removed])
      return current.slice(0, -1)
    })
  }
  const redoEdit = (): void => {
    setRedo((current) => {
      const restored = current.at(-1)
      if (!restored) return current
      setOperations((items) => [...items, restored])
      return current.slice(0, -1)
    })
  }

  return (
    <div ref={dialogRef} className="screenshot-editor" role="dialog" aria-label="Edit screenshot" aria-modal="true" tabIndex={-1}>
      <div className="screenshot-editor__panel">
        <header className="screenshot-editor__header">
          <div className="screenshot-editor__intro">
            <strong>Edit screenshot</strong>
            <span>Blur can be reversible. Use solid redaction for sensitive information.</span>
          </div>
        </header>
        <div className="screenshot-editor__tools" role="toolbar" aria-label="Screenshot tools">
          {TOOLS.map((item) => (
            <button
              aria-pressed={tool === item.tool}
              className={tool === item.tool ? 'active' : ''}
              disabled={saving}
              key={item.tool}
              onClick={() => setTool(item.tool)}
              type="button"
            >
              {item.label}
            </button>
          ))}
          {tool === 'text' && (
            <div className="screenshot-editor__text-field">
              <TextInput label="Text label" value={text} onChange={(event) => setText(event.target.value)} />
            </div>
          )}
        </div>
        <div className="screenshot-editor__canvas-wrap">
          <canvas
            ref={canvasRef}
            onPointerDown={begin}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={() => setDraft(null)}
          />
        </div>
        <footer className="screenshot-editor__footer">
          <div className="screenshot-editor__history">
            <Button disabled={saving || operations.length === 0} size="compact" variant="secondary" onClick={undo}>Undo</Button>
            <Button disabled={saving || redo.length === 0} size="compact" variant="secondary" onClick={redoEdit}>Redo</Button>
            <Button disabled={saving || operations.length === 0} size="compact" variant="ghost" onClick={() => { setOperations([]); setRedo([]) }}>Clear</Button>
          </div>
          <div className="screenshot-editor__commit">
            <Button data-modal-initial-focus disabled={saving} size="compact" variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
            <Button className="screenshot-editor__save" disabled={saving || operations.length === 0} loading={saving} size="compact" onClick={() => onSave(operations)}>
              Save edited copy
            </Button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function pointForEvent(event: React.PointerEvent<HTMLCanvasElement>): ImageEditPoint {
  const bounds = event.currentTarget.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
  }
}
