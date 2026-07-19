import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Point, Rectangle } from '@shared/types/geometry'
import { Button } from '../design-system'
import '../design-system/index.css'
import './overlay.css'

function normalizeRectangle(start: Point, end: Point): Rectangle {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  }
}

function Overlay(): React.JSX.Element {
  const [start, setStart] = useState<Point | null>(null)
  const [current, setCurrent] = useState<Point | null>(null)
  const [hint, setHint] = useState('Drag to select an area · Esc to cancel')
  const overlayRef = useRef<HTMLDivElement>(null)
  const rectangle: Rectangle | null = start && current ? normalizeRectangle(start, current) : null

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void window.snipchat.capture.cancel()
    }
    window.addEventListener('keydown', onKey)
    overlayRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const point = (event: React.PointerEvent<HTMLDivElement>): Point => ({
    x: event.clientX,
    y: event.clientY
  })
  const complete = async (end: Point): Promise<void> => {
    if (!start) return
    const completedRectangle = normalizeRectangle(start, end)
    if (completedRectangle.width < 24 || completedRectangle.height < 24) {
      setHint('Selection is too small — drag at least 24 × 24')
      setStart(null)
      setCurrent(null)
      return
    }
    await window.snipchat.capture.select(completedRectangle)
  }
  const cancel = (): void => void window.snipchat.capture.cancel()

  return (
    <div
      ref={overlayRef}
      className={`overlay ${rectangle ? 'selecting' : ''}`}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const startPoint = point(event)
        setStart(startPoint)
        setCurrent(startPoint)
        setHint('Release to capture')
      }}
      onPointerMove={(event) => {
        if (start) setCurrent(point(event))
      }}
      onPointerUp={(event) => {
        if (!start) return
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        void complete(point(event))
      }}
      onPointerCancel={() => {
        setStart(null)
        setCurrent(null)
        setHint('Selection cancelled. Drag to try again.')
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        cancel()
      }}
    >
      {!rectangle && <div className="hint">{hint}</div>}
      <Button className="cancel" variant="secondary" onPointerDown={(event) => event.stopPropagation()} onClick={cancel}>
        Cancel · Esc
      </Button>
      {rectangle && (
        <div className="selection" style={{ left: rectangle.x, top: rectangle.y, width: rectangle.width, height: rectangle.height }}>
          <span>{Math.round(rectangle.width)} × {Math.round(rectangle.height)}</span>
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Overlay />)
