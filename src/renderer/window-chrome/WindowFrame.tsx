import { useEffect, type PropsWithChildren } from 'react'
import { WINDOW_RESIZE_EDGES, type WindowResizeEdge } from '../../shared/contracts/ipc'
import { WindowControls } from '../design-system'
import { useWindowChrome } from './useWindowChrome'
import './window-chrome.css'

export interface WindowFrameProps extends PropsWithChildren {
  title: string
}

export function WindowFrame({ children, title }: WindowFrameProps): React.JSX.Element {
  const chrome = useWindowChrome()
  const { state } = chrome

  useEffect(() => {
    if (!chrome.stateResolved) return
    const frame = requestAnimationFrame(() => window.snipchat.windowChrome.ready())
    return () => cancelAnimationFrame(frame)
  }, [chrome.stateResolved])

  return (
    <div
      className="window-shell"
      data-focused={state.focused}
      data-material={state.material}
      data-maximized={state.maximized}
    >
      {WINDOW_RESIZE_EDGES.map((edge) => (
        <ResizeRegion edge={edge} key={edge} chrome={chrome} />
      ))}
      <section aria-label={title} className="window-surface">
        <header className="window-titlebar">
          <span className="window-titlebar__title">{title}</span>
          <WindowControls
            maximized={state.maximized}
            onClose={chrome.close}
            onMaximize={state.canMaximize ? chrome.toggleMaximize : undefined}
            onMinimize={state.canMinimize ? chrome.minimize : undefined}
          />
        </header>
        <div className="window-frame__content">{children}</div>
      </section>
    </div>
  )
}

interface ResizeRegionProps {
  edge: WindowResizeEdge
  chrome: ReturnType<typeof useWindowChrome>
}

function ResizeRegion({ edge, chrome }: ResizeRegionProps): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={`window-resize-region window-resize-region--${edge}`}
      data-resize-edge={edge}
      onLostPointerCapture={chrome.endResize}
      onPointerCancel={chrome.endResize}
      onPointerDown={(event) => chrome.beginResize(edge, event)}
      onPointerMove={chrome.updateResize}
      onPointerUp={chrome.endResize}
    />
  )
}
