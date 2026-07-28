import { useEffect, useRef, useState } from 'react'
import type { CaptureContext } from '@shared/contracts/ipc'
import type { ImageEditOperation, ImageEditPoint, ImageEditTool } from '@shared/types/app'
import type { Rectangle } from '@shared/types/geometry'
import { drawEditorCanvas, isMeaningfulEdit } from '../image-editing/canvas'

const TOOLS: Array<{ tool: ImageEditTool; label: string }> = [
  { tool: 'arrow', label: 'Arrow' },
  { tool: 'rectangle', label: 'Rectangle' },
  { tool: 'freehand', label: 'Draw' },
  { tool: 'text', label: 'Text' },
  { tool: 'blur', label: 'Blur' },
  { tool: 'redact', label: 'Redact' }
]

interface CaptureEditorProps {
  context: CaptureContext
  rectangle: Rectangle
  submitting: boolean
  onCancel(): void
  onSend(operations: ImageEditOperation[]): void
}

export function CaptureEditor({ context, rectangle, submitting, onCancel, onSend }: CaptureEditorProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const textInputRef = useRef<HTMLInputElement>(null)
  const textDragRef = useRef<{ offsetX: number; offsetY: number } | null>(null)
  const [tool, setTool] = useState<ImageEditTool>('arrow')
  const [operations, setOperations] = useState<ImageEditOperation[]>([])
  const [redo, setRedo] = useState<ImageEditOperation[]>([])
  const [draft, setDraft] = useState<ImageEditOperation | null>(null)
  const [pendingText, setPendingText] = useState<{ point: ImageEditPoint; value: string } | null>(null)
  const [imageVersion, setImageVersion] = useState(0)
  const textComposerOpen = pendingText !== null

  useEffect(() => {
    if (!textComposerOpen) return
    const focusTimer = window.setTimeout(() => {
      textInputRef.current?.focus({ preventScroll: true })
    }, 0)
    return () => window.clearTimeout(focusTimer)
  }, [textComposerOpen])

  useEffect(() => {
    const image = new Image()
    image.onload = () => {
      imageRef.current = image
      setImageVersion((version) => version + 1)
    }
    image.src = context.imageDataUrl
    return () => { image.onload = null }
  }, [context.imageDataUrl])

  useEffect(() => {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image) return
    const scaleX = image.naturalWidth / context.width
    const scaleY = image.naturalHeight / context.height
    const width = Math.max(1, Math.round(rectangle.width * scaleX))
    const height = Math.max(1, Math.round(rectangle.height * scaleY))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const preview = pendingText
      ? { id: 'pending-text-preview', tool: 'text' as const, points: [pendingText.point], text: pendingText.value, strokeWidth: 4 }
      : draft
    drawEditorCanvas(canvas, image, operations, preview, {
      x: rectangle.x * scaleX,
      y: rectangle.y * scaleY,
      width: rectangle.width * scaleX,
      height: rectangle.height * scaleY
    })
  }, [context.height, context.width, draft, imageVersion, operations, pendingText, rectangle.height, rectangle.width, rectangle.x, rectangle.y])

  const commit = (operation: ImageEditOperation): void => {
    setOperations((current) => [...current, operation])
    setRedo([])
  }
  const finishText = (): void => {
    if (!pendingText) return
    const label = pendingText.value.trim()
    if (label) commit({ id: crypto.randomUUID(), tool: 'text', points: [pendingText.point], text: label, strokeWidth: 4 })
    setPendingText(null)
  }
  const beginTextDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!pendingText) return
    const bounds = canvasRef.current?.getBoundingClientRect()
    if (!bounds) return
    textDragRef.current = {
      offsetX: event.clientX - (bounds.left + pendingText.point.x * bounds.width),
      offsetY: event.clientY - (bounds.top + pendingText.point.y * bounds.height)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveTextDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const drag = textDragRef.current
    const bounds = canvasRef.current?.getBoundingClientRect()
    if (!drag || !bounds) return
    setPendingText((current) => current ? {
      ...current,
      point: {
        x: Math.max(0, Math.min(1, (event.clientX - bounds.left - drag.offsetX) / bounds.width)),
        y: Math.max(0, Math.min(1, (event.clientY - bounds.top - drag.offsetY) / bounds.height))
      }
    } : null)
  }
  const finishTextDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    textDragRef.current = null
  }
  const begin = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    event.stopPropagation()
    if (submitting) return
    const point = pointForEvent(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'text') {
      if (!pendingText) setPendingText({ point, value: '' })
      return
    }
    setDraft({ id: crypto.randomUUID(), tool, points: [point, point], strokeWidth: 4 })
  }
  const move = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    event.stopPropagation()
    if (!draft || submitting) return
    const point = pointForEvent(event)
    setDraft((current) => {
      if (!current) return null
      return current.tool === 'freehand'
        ? { ...current, points: [...current.points, point] }
        : { ...current, points: [current.points[0]!, point] }
    })
  }
  const finish = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!draft) return
    if (isMeaningfulEdit(draft)) commit(draft)
    setDraft(null)
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
    <>
      <div className="capture-editor-toolbar" role="toolbar" aria-label="Screenshot editing tools" onPointerDown={(event) => event.stopPropagation()}>
        <div className="capture-editor-toolbar__group">
          {TOOLS.map((item) => (
            <button
              aria-label={item.label}
              aria-pressed={tool === item.tool}
              className="capture-editor-tool"
              data-active={tool === item.tool}
              disabled={submitting || Boolean(pendingText)}
              key={item.tool}
              title={item.label}
              type="button"
              onClick={() => setTool(item.tool)}
            >
              <EditorIcon name={item.tool} />
            </button>
          ))}
        </div>
        <span className="capture-editor-toolbar__divider" aria-hidden="true" />
        <div className="capture-editor-toolbar__group">
          <button aria-label="Undo" className="capture-editor-tool" disabled={submitting || Boolean(pendingText) || operations.length === 0} title="Undo" type="button" onClick={undo}><EditorIcon name="undo" /></button>
          <button aria-label="Redo" className="capture-editor-tool" disabled={submitting || Boolean(pendingText) || redo.length === 0} title="Redo" type="button" onClick={redoEdit}><EditorIcon name="redo" /></button>
          <button aria-label="Clear edits" className="capture-editor-tool" disabled={submitting || (operations.length === 0 && !pendingText)} title="Clear edits" type="button" onClick={() => { setOperations([]); setRedo([]); setPendingText(null) }}><EditorIcon name="clear" /></button>
        </div>
        <span className="capture-editor-toolbar__divider" aria-hidden="true" />
        <div className="capture-editor-toolbar__group">
          <button aria-label="Cancel capture" className="capture-editor-tool" disabled={submitting} title="Cancel capture" type="button" onClick={onCancel}><EditorIcon name="cancel" /></button>
          <button aria-label="Send screenshot" className="capture-editor-tool capture-editor-send" disabled={submitting || Boolean(pendingText)} title={pendingText ? 'Add or cancel the text annotation first' : 'Send screenshot'} type="button" onClick={() => onSend(operations)}><EditorIcon name="send" /></button>
        </div>
      </div>
      <canvas
        aria-label="Selected screenshot editing canvas"
        className="capture-editor-canvas"
        ref={canvasRef}
        onPointerCancel={(event) => { event.stopPropagation(); setDraft(null) }}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={finish}
      />
      {tool === 'text' && !pendingText && (
        <div className="capture-editor-hint" role="status">Click the capture to place text</div>
      )}
      {pendingText && (
        <div
          className="capture-editor-inline-text"
          data-align-x={pendingText.point.x > 0.65 ? 'left' : 'right'}
          data-align-y={pendingText.point.y > 0.55 ? 'above' : 'below'}
          style={{ left: `${pendingText.point.x * 100}%`, top: `${pendingText.point.y * 100}%` }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            aria-label="Move text annotation"
            className="capture-editor-text-drag"
            disabled={submitting}
            title="Drag to move text"
            type="button"
            onPointerCancel={finishTextDrag}
            onPointerDown={beginTextDrag}
            onPointerMove={moveTextDrag}
            onPointerUp={finishTextDrag}
          >
            <EditorIcon name="move" />
          </button>
          <input
            aria-label="Annotation text"
            disabled={submitting}
            maxLength={200}
            placeholder="Type label…"
            ref={textInputRef}
            value={pendingText.value}
            onChange={(event) => setPendingText((current) => current ? { ...current, value: event.target.value } : null)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                finishText()
              }
            }}
          />
          <button aria-label="Add text annotation" className="capture-editor-text-confirm" disabled={submitting || !pendingText.value.trim()} title="Add text" type="button" onClick={finishText}><EditorIcon name="confirm" /></button>
          <button aria-label="Cancel text annotation" className="capture-editor-text-cancel" disabled={submitting} title="Cancel text" type="button" onClick={() => setPendingText(null)}><EditorIcon name="cancel" /></button>
        </div>
      )}
    </>
  )
}

function pointForEvent(event: React.PointerEvent<HTMLCanvasElement>): ImageEditPoint {
  const bounds = event.currentTarget.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
  }
}

function EditorIcon({ name }: { name: ImageEditTool | 'undo' | 'redo' | 'clear' | 'cancel' | 'confirm' | 'move' | 'send' }): React.JSX.Element {
  const paths: Record<typeof name, React.JSX.Element> = {
    arrow: <><path d="M5 19 19 5" /><path d="M10 5h9v9" /></>,
    rectangle: <rect x="4" y="5" width="16" height="14" rx="1" />,
    freehand: <path d="M4 17c3-8 5 2 8-6s4 7 8-4" />,
    text: <><path d="M5 5h14M12 5v14" /><path d="M8 19h8" /></>,
    blur: <><circle cx="9" cy="9" r="4" /><circle cx="15.5" cy="15.5" r="3.5" /><path d="M13 7h4M7 13v4" /></>,
    redact: <><rect x="3" y="7" width="18" height="10" rx="1" /><path d="m7 10 3 4m0-4-3 4m7-4 3 4m0-4-3 4" /></>,
    undo: <><path d="m9 7-5 5 5 5" /><path d="M5 12h8a6 6 0 0 1 6 6" /></>,
    redo: <><path d="m15 7 5 5-5 5" /><path d="M19 12h-8a6 6 0 0 0-6 6" /></>,
    clear: <><path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13" /><path d="M10 11v5m4-5v5" /></>,
    cancel: <path d="m6 6 12 12M18 6 6 18" />,
    confirm: <path d="m5 12 4 4L19 6" />,
    move: <><path d="M12 3v18M3 12h18" /><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" /></>,
    send: <><path d="m3 11 18-8-8 18-2-8-8-2Z" /><path d="m11 13 5-5" /></>
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>
}
