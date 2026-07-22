import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Tooltip({ content, children, delay = 450 }: { content: ReactNode; children: ReactNode; delay?: number }): React.JSX.Element {
  const id = useId(); const anchor = useRef<HTMLSpanElement>(null); const timer = useRef<number | null>(null); const [open, setOpen] = useState(false); const [position, setPosition] = useState({ x: 0, y: 0 })
  const show = (): void => { timer.current = window.setTimeout(() => { const rect = anchor.current?.getBoundingClientRect(); if (rect) setPosition({ x: rect.left + rect.width / 2, y: rect.bottom + 7 }); setOpen(true) }, delay) }
  const hide = (): void => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; setOpen(false) }
  useEffect(() => { const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') hide() }; window.addEventListener('keydown', onKey); return () => { hide(); window.removeEventListener('keydown', onKey) } }, [])
  return <><span ref={anchor} className="fui-tooltip-anchor" aria-describedby={open ? id : undefined} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>{children}</span>{open && createPortal(<span id={id} role="tooltip" className="fui-tooltip" style={{ left: position.x, top: position.y }}>{content}</span>, document.body)}</>
}
