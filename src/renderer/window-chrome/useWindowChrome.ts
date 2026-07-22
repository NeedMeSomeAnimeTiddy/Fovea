import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { WindowChromeState, WindowResizeEdge } from '@shared/contracts/ipc'

const INITIAL_STATE: WindowChromeState = {
  focused: false,
  maximized: false,
  material: 'transparent',
  canMinimize: true,
  canMaximize: true,
  canResize: true
}

interface ActivePointerResize {
  pointerId: number
  target: HTMLElement
}

export interface WindowChromeController {
  state: WindowChromeState
  stateResolved: boolean
  minimize(): void
  toggleMaximize(): void
  close(): void
  beginResize(edge: WindowResizeEdge, event: ReactPointerEvent<HTMLElement>): void
  updateResize(event: ReactPointerEvent<HTMLElement>): void
  endResize(event?: ReactPointerEvent<HTMLElement>): void
}

export function useWindowChrome(): WindowChromeController {
  const [state, setState] = useState<WindowChromeState>(INITIAL_STATE)
  const [stateResolved, setStateResolved] = useState(false)
  const activeResize = useRef<ActivePointerResize | null>(null)
  const pendingResizeFrame = useRef<number | null>(null)
  const stateEventVersion = useRef(0)

  const endResize = useCallback((event?: ReactPointerEvent<HTMLElement>): void => {
    const active = activeResize.current
    if (!active || (event && event.pointerId !== active.pointerId)) return

    activeResize.current = null
    if (pendingResizeFrame.current !== null) {
      cancelAnimationFrame(pendingResizeFrame.current)
      pendingResizeFrame.current = null
    }
    window.fovea.windowChrome.endResize()
    try {
      if (active.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId)
      }
    } catch {
      // The browser can revoke capture between the check and release while the
      // native window is minimizing, closing, or crossing a display boundary.
    }
  }, [])

  useEffect(() => {
    let subscribed = true
    const requestedAtVersion = stateEventVersion.current
    const unsubscribe = window.fovea.windowChrome.onStateChanged((nextState) => {
      if (!subscribed) return
      stateEventVersion.current += 1
      setState(nextState)
      setStateResolved(true)
    })
    const handleBlur = (): void => endResize()

    window.addEventListener('blur', handleBlur)
    void window.fovea.windowChrome
      .getState()
      .then((nextState) => {
        if (!subscribed || stateEventVersion.current !== requestedAtVersion) return
        setState(nextState)
        setStateResolved(true)
      })
      .catch(() => {
        // Main owns the bounded readiness timeout and the single solid retry.
      })

    return () => {
      subscribed = false
      unsubscribe()
      window.removeEventListener('blur', handleBlur)
      endResize()
    }
  }, [endResize])

  const beginResize = useCallback(
    (edge: WindowResizeEdge, event: ReactPointerEvent<HTMLElement>): void => {
      if (event.button !== 0 || !state.canResize || state.maximized || state.material === 'solid') return
      endResize()
      event.preventDefault()
      event.stopPropagation()
      const target = event.currentTarget
      try {
        target.setPointerCapture(event.pointerId)
      } catch {
        window.fovea.windowChrome.endResize()
        return
      }
      activeResize.current = { pointerId: event.pointerId, target }
      void window.fovea.windowChrome.beginResize(edge).catch(() => {
        const active = activeResize.current
        if (active?.pointerId === event.pointerId && active.target === target) endResize(event)
      })
    },
    [endResize, state.canResize, state.material, state.maximized]
  )

  const updateResize = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (activeResize.current?.pointerId !== event.pointerId || pendingResizeFrame.current !== null) return
    const pointerId = event.pointerId
    pendingResizeFrame.current = requestAnimationFrame(() => {
      pendingResizeFrame.current = null
      if (activeResize.current?.pointerId === pointerId) {
        window.fovea.windowChrome.updateResize()
      }
    })
  }, [])

  const minimize = useCallback((): void => {
    endResize()
    void window.fovea.windowChrome.minimize()
  }, [endResize])

  const toggleMaximize = useCallback((): void => {
    endResize()
    void window.fovea.windowChrome.toggleMaximize()
  }, [endResize])

  const close = useCallback((): void => {
    endResize()
    void window.fovea.windowChrome.close()
  }, [endResize])

  return {
    state,
    stateResolved,
    minimize,
    toggleMaximize,
    close,
    beginResize,
    updateResize,
    endResize
  }
}
