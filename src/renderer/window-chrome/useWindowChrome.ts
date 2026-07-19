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
    window.snipchat.windowChrome.endResize()
    if (active.target.hasPointerCapture(active.pointerId)) {
      active.target.releasePointerCapture(active.pointerId)
    }
  }, [])

  useEffect(() => {
    let subscribed = true
    const requestedAtVersion = stateEventVersion.current
    const unsubscribe = window.snipchat.windowChrome.onStateChanged((nextState) => {
      if (!subscribed) return
      stateEventVersion.current += 1
      setState(nextState)
      setStateResolved(true)
    })
    const handleBlur = (): void => endResize()

    window.addEventListener('blur', handleBlur)
    void window.snipchat.windowChrome
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
      target.setPointerCapture(event.pointerId)
      activeResize.current = { pointerId: event.pointerId, target }
      void window.snipchat.windowChrome.beginResize(edge).catch(() => {
        if (activeResize.current?.pointerId === event.pointerId) endResize(event)
      })
    },
    [endResize, state.canResize, state.material, state.maximized]
  )

  const updateResize = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (activeResize.current?.pointerId !== event.pointerId || pendingResizeFrame.current !== null) return
    pendingResizeFrame.current = requestAnimationFrame(() => {
      pendingResizeFrame.current = null
      if (activeResize.current?.pointerId === event.pointerId) {
        window.snipchat.windowChrome.updateResize()
      }
    })
  }, [])

  const minimize = useCallback((): void => {
    endResize()
    void window.snipchat.windowChrome.minimize()
  }, [endResize])

  const toggleMaximize = useCallback((): void => {
    endResize()
    void window.snipchat.windowChrome.toggleMaximize()
  }, [endResize])

  const close = useCallback((): void => {
    endResize()
    void window.snipchat.windowChrome.close()
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
