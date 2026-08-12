import { useLayoutEffect, useRef, type RefObject } from 'react'

interface ModalDialogOptions {
  canCancel?: boolean
  onCancel(): void
  returnFocus?: HTMLElement | null
}

interface HiddenElementState {
  ariaHidden: string | null
  element: HTMLElement
  inert: string | null
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/** Keeps keyboard and assistive-technology focus inside a renderer-owned modal. */
export function useModalDialog<T extends HTMLElement>({
  canCancel = true,
  onCancel,
  returnFocus
}: ModalDialogOptions): RefObject<T | null> {
  const dialogRef = useRef<T>(null)
  const canCancelRef = useRef(canCancel)
  const onCancelRef = useRef(onCancel)
  const fallbackReturnFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  )
  canCancelRef.current = canCancel
  onCancelRef.current = onCancel

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const fallbackReturnFocus = fallbackReturnFocusRef.current
    const focusTarget = preferredFocusTarget(dialog)
    focusTarget.focus({ preventScroll: true })
    const hiddenOutside = hideOutsideModal(dialog)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (event.isComposing || event.keyCode === 229) return
        event.preventDefault()
        event.stopPropagation()
        if (canCancelRef.current) onCancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableElements(dialog)
      if (!focusable.length) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]!
      const last = focusable.at(-1)!
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      restoreHiddenElements(hiddenOutside)
      const target = returnFocus ?? fallbackReturnFocus
      if (target?.isConnected) target.focus({ preventScroll: true })
    }
  }, [returnFocus])

  return dialogRef
}

function preferredFocusTarget(dialog: HTMLElement): HTMLElement {
  const focusable = focusableElements(dialog)
  const preferred = dialog.querySelector<HTMLElement>('[data-modal-initial-focus]')
  return preferred && focusable.includes(preferred) ? preferred : focusable[0] ?? dialog
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => element.getAttribute('aria-hidden') !== 'true' && !element.closest('[inert]'))
}

function hideOutsideModal(dialog: HTMLElement): HiddenElementState[] {
  const hidden: HiddenElementState[] = []
  let current: HTMLElement | null = dialog
  while (current && current !== document.body) {
    const parent: HTMLElement | null = current.parentElement
    if (!parent) break
    for (const sibling of parent.children) {
      if (sibling === current || !(sibling instanceof HTMLElement)) continue
      hidden.push({
        ariaHidden: sibling.getAttribute('aria-hidden'),
        element: sibling,
        inert: sibling.getAttribute('inert')
      })
      sibling.setAttribute('aria-hidden', 'true')
      sibling.setAttribute('inert', '')
    }
    current = parent
  }
  return hidden
}

function restoreHiddenElements(hidden: HiddenElementState[]): void {
  for (const { ariaHidden, element, inert } of hidden.reverse()) {
    restoreAttribute(element, 'aria-hidden', ariaHidden)
    restoreAttribute(element, 'inert', inert)
  }
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name)
  else element.setAttribute(name, value)
}
