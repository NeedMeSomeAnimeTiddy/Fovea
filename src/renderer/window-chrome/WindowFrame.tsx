import { useEffect, useState, type PropsWithChildren } from 'react'
import type { SpectralEdgeState } from '../../shared/types/app'
import { WINDOW_RESIZE_EDGES, type WindowResizeEdge } from '../../shared/contracts/ipc'
import { WindowControls } from '../design-system'
import { useWindowChrome } from './useWindowChrome'
import './window-chrome.css'

export interface WindowFrameProps extends PropsWithChildren {
  title: string
  showTitlebar?: boolean
  showResizeRegions?: boolean
  edgeState?: SpectralEdgeState
}

export function WindowFrame({ children, title, showTitlebar = true, showResizeRegions = true, edgeState = 'idle' }: WindowFrameProps): React.JSX.Element {
  const chrome = useWindowChrome()
  const { state } = chrome
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')

  useEffect(() => {
    if (!chrome.stateResolved) return
    const frame = requestAnimationFrame(() => window.fovea.windowChrome.ready())
    return () => cancelAnimationFrame(frame)
  }, [chrome.stateResolved])

  useEffect(() => {
    const handleVisibility = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  return (
    <div
      className="window-shell"
      data-focused={state.focused}
      data-material={state.material}
      data-maximized={state.maximized}
      data-visible={visible}
    >
      {showResizeRegions && WINDOW_RESIZE_EDGES.map((edge) => (
        <ResizeRegion edge={edge} key={edge} chrome={chrome} />
      ))}
      <div aria-hidden="true" className="window-edge-glow" data-edge-state={edgeState} />
      <section aria-label={title} className="window-surface">
        {showTitlebar && <header className="window-titlebar">
          <span className="window-titlebar__title">{title}</span>
          <WindowControls
            maximized={state.maximized}
            onClose={chrome.close}
            onMaximize={state.canMaximize ? chrome.toggleMaximize : undefined}
            onMinimize={state.canMinimize ? chrome.minimize : undefined}
          />
        </header>}
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
