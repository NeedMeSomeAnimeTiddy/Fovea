import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface TooltipPosition {
  placement: 'above' | 'below'
  ready: boolean
  x: number
  y: number
}

interface RectLike {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
}

const TOOLTIP_GAP = 8
const VIEWPORT_MARGIN = 8

export function calculateTooltipPosition(
  anchor: RectLike,
  tooltip: Pick<RectLike, 'height' | 'width'>,
  viewport: { height: number; width: number }
): Omit<TooltipPosition, 'ready'> {
  const halfWidth = tooltip.width / 2
  const minimumX = VIEWPORT_MARGIN + halfWidth
  const maximumX = viewport.width - VIEWPORT_MARGIN - halfWidth
  const centredX = anchor.left + anchor.width / 2
  const x = minimumX > maximumX
    ? viewport.width / 2
    : Math.min(maximumX, Math.max(minimumX, centredX))
  const fitsBelow = anchor.bottom + TOOLTIP_GAP + tooltip.height <= viewport.height - VIEWPORT_MARGIN
  const fitsAbove = anchor.top - TOOLTIP_GAP - tooltip.height >= VIEWPORT_MARGIN
  const placement = fitsBelow || !fitsAbove ? 'below' : 'above'
  const requestedY = placement === 'below'
    ? anchor.bottom + TOOLTIP_GAP
    : anchor.top - TOOLTIP_GAP - tooltip.height
  const maximumY = Math.max(VIEWPORT_MARGIN, viewport.height - VIEWPORT_MARGIN - tooltip.height)
  const y = Math.min(maximumY, Math.max(VIEWPORT_MARGIN, requestedY))
  return { placement, x, y }
}

export function Tooltip({ content, children, delay = 450 }: { content: ReactNode; children: ReactNode; delay?: number }): React.JSX.Element {
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const tooltip = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<TooltipPosition>({ placement: 'below', ready: false, x: 0, y: 0 })

  const updatePosition = useCallback((): void => {
    const anchorRect = anchor.current?.getBoundingClientRect()
    const tooltipRect = tooltip.current?.getBoundingClientRect()
    if (!anchorRect || !tooltipRect) return
    setPosition({
      ...calculateTooltipPosition(anchorRect, tooltipRect, { height: window.innerHeight, width: window.innerWidth }),
      ready: true
    })
  }, [])
  const show = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setPosition((current) => ({ ...current, ready: false }))
      setOpen(true)
    }, delay)
  }
  const hide = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    setOpen(false)
  }, [])

  useLayoutEffect(() => {
    if (open) updatePosition()
  }, [content, open, updatePosition])
  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, updatePosition])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      hide()
      window.removeEventListener('keydown', onKey)
    }
  }, [hide])

  return (
    <>
      <span
        ref={anchor}
        className="fui-tooltip-anchor"
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {open && createPortal(
        <span
          id={id}
          ref={tooltip}
          role="tooltip"
          className="fui-tooltip"
          data-placement={position.placement}
          data-ready={position.ready}
          style={{ left: position.x, top: position.y }}
        >
          {content}
        </span>,
        document.body
      )}
    </>
  )
}
