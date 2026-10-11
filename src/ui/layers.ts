/*
 * Open sheets and dialogs, in opening order. Only the top one answers Esc and marks the event handled
 * (preventDefault); page-level Esc handling (App) ignores handled events and stands down while any layer
 * is open, so Esc never closes a page underneath a sheet, whatever order the listeners run in (D-101).
 */
import { useEffect, useRef } from 'react'

const stack: symbol[] = []

export function anyLayerOpen(): boolean {
  return stack.length > 0
}

/** While `open`, this layer is on the stack; `onEsc` runs when it is the top one. */
export function useLayer(open: boolean, onEsc: (() => void) | null): void {
  const latest = useRef(onEsc)
  latest.current = onEsc
  useEffect(() => {
    if (!open) return
    const me = Symbol('layer')
    // A layer with no Esc handler of its own (the entry sheet handles Esc itself) still blocks page-level Esc.
    stack.push(me)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || stack[stack.length - 1] !== me || !latest.current) return
      // Mark the key as used: a listener that runs after this one (its order depends on when it was
      // last attached) must not act on it once this layer has already closed.
      e.preventDefault()
      const a = document.activeElement as HTMLElement | null
      const tag = (a?.tagName ?? '').toUpperCase()
      // First Esc leaves a text field, the next one closes.
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        a?.blur()
        return
      }
      latest.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const i = stack.lastIndexOf(me)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [open])
}
