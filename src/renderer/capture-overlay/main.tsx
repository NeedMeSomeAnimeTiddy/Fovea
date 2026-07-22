import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { CaptureContext } from '@shared/contracts/ipc'
import type { Point, Rectangle } from '@shared/types/geometry'
import { initialiseAppearance } from '../appearance'
import '../design-system/index.css'
import './overlay.css'

type OverlayPhase = 'idle' | 'selecting' | 'invalid' | 'submitting'
const MINIMUM_SELECTION = 24
const CORNERS = ['nw', 'ne', 'se', 'sw'] as const

function Overlay(): React.JSX.Element {
  const [start, setStart] = useState<Point | null>(null)
  const [current, setCurrent] = useState<Point>({ x: innerWidth / 2, y: innerHeight / 2 })
  const [phase, setPhase] = useState<OverlayPhase>('idle')
  const [feedback, setFeedback] = useState('Select any part of the frozen screen')
  const [context, setContext] = useState<CaptureContext | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const rectangle = start ? normalize(start, current) : null

  useEffect(() => {
    void initialiseAppearance()
    void window.fovea.capture.getContext().then(setContext).catch((reason) => {
      setPhase('invalid')
      setFeedback(message(reason))
    })
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') void window.fovea.capture.cancel() }
    addEventListener('keydown', onKey)
    root.current?.focus()
    return () => removeEventListener('keydown', onKey)
  }, [])

  const complete = async (end: Point): Promise<void> => {
    if (!start) return
    const next = normalize(start, end)
    if (next.width < MINIMUM_SELECTION || next.height < MINIMUM_SELECTION) {
      setPhase('invalid')
      setFeedback(`Minimum selection is ${MINIMUM_SELECTION} × ${MINIMUM_SELECTION}`)
      setStart(null)
      return
    }
    setPhase('submitting')
    try { await window.fovea.capture.select(next) }
    catch (reason) {
      setPhase('invalid')
      setFeedback(message(reason))
      setStart(null)
    }
  }

  return <div
    ref={root}
    tabIndex={-1}
    className={`overlay ${phase}`}
    onPointerDown={(event) => {
      if (!context || event.button !== 0 || phase === 'submitting') return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const next = pointer(event)
      setStart(next)
      setCurrent(next)
      setPhase('selecting')
    }}
    onPointerMove={(event) => setCurrent(pointer(event))}
    onPointerUp={(event) => {
      if (!start) return
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      void complete(pointer(event))
    }}
    onPointerCancel={() => {
      setStart(null)
      setPhase('idle')
      setFeedback('Select any part of the frozen screen')
    }}
    onContextMenu={(event) => { event.preventDefault(); void window.fovea.capture.cancel() }}
  >
    {context && <img className="frozen-frame" src={context.imageDataUrl} alt="" draggable={false} style={captureImageStyle(context)} />}
    <div className="capture-scrim" />

    {phase === 'selecting' && <>
      <div className="capture-guide horizontal" style={{ top: current.y }} />
      <div className="capture-guide vertical" style={{ left: current.x }} />
    </>}

    {rectangle && (rectangle.width > 0 || rectangle.height > 0) && context && <div className={`selection-root ${phase === 'submitting' ? 'confirming' : ''}`} style={rectangleStyle(rectangle)}>
      <div className="selection-viewport">
        <img className="selection-frame" src={context.imageDataUrl} alt="" draggable={false} style={selectionImageStyle(rectangle, context)} />
      </div>
      <div className="selection-outline" />
      {CORNERS.map((corner) => <i key={corner} className={`corner-handle ${corner}`} />)}
      <output className={`dimensions ${dimensionPosition(rectangle)}`}>{Math.round(rectangle.width)} × {Math.round(rectangle.height)}</output>
    </div>}

    {!rectangle && phase !== 'submitting' && <CaptureHud
      error={phase === 'invalid'}
      detail={feedback}
      onCancel={() => void window.fovea.capture.cancel()}
    />}
    {phase === 'submitting' && <div className="capture-status" role="status"><span className="status-dot" />Opening Fovea…</div>}
  </div>
}

function CaptureHud({ error, detail, onCancel }: { error: boolean; detail: string; onCancel(): void }): React.JSX.Element {
  return <div className={`capture-hud ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'} aria-live="polite" onPointerDown={(event) => event.stopPropagation()}>
    <span className="hud-symbol" aria-hidden="true">{error ? '!' : <svg viewBox="0 0 20 20"><path d="M6 2H2v4M14 2h4v4M6 18H2v-4m12 4h4v-4" /></svg>}</span>
    <span className="hud-copy"><strong>{error ? 'Try a larger area' : 'Drag to capture'}</strong><small>{detail}</small></span>
    <button className="hud-cancel" onPointerDown={(event) => event.stopPropagation()} onClick={onCancel}>Cancel <kbd>Esc</kbd></button>
  </div>
}

function normalize(start: Point, end: Point): Rectangle {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}
function pointer(event: ReactPointerEvent): Point { return { x: event.clientX, y: event.clientY } }
function rectangleStyle(rectangle: Rectangle): CSSProperties { return { left: rectangle.x, top: rectangle.y, width: rectangle.width, height: rectangle.height } }
function captureImageStyle(context: CaptureContext): CSSProperties { return { width: context.width, height: context.height } }
function selectionImageStyle(rectangle: Rectangle, context: CaptureContext): CSSProperties { return { left: -rectangle.x, top: -rectangle.y, width: context.width, height: context.height } }
function dimensionPosition(rectangle: Rectangle): string {
  const vertical = rectangle.y >= 48 ? 'above' : innerHeight - rectangle.y - rectangle.height >= 48 ? 'below' : 'inside'
  const horizontal = innerWidth - rectangle.x < 112 ? 'edge-right' : 'edge-left'
  return `${vertical} ${horizontal}`
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }

createRoot(document.getElementById('root')!).render(<Overlay />)
