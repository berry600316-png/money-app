import { useEffect, useRef, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { useLayer } from './layers'

/**
 * Bottom sheet with iOS-like behaviour: slides up, scrim tap or a downward drag on the
 * header closes it, and it rises above the on-screen keyboard (--kb, see useKeyboardInset).
 */
export function BottomSheet({
  open,
  onClose,
  labelledBy,
  head,
  children,
  className,
  sheetRef,
  escClose = true,
}: {
  open: boolean
  onClose: () => void
  labelledBy: string
  head: ReactNode
  children: ReactNode
  className?: string
  sheetRef?: RefObject<HTMLDivElement | null>
  /** false when the content handles Esc itself (the entry sheet's keypad). */
  escClose?: boolean
}) {
  const localRef = useRef<HTMLDivElement | null>(null)
  const ref = sheetRef ?? localRef
  const drag = useRef({ down: false, dragging: false, y0: 0, dy: 0, t0: 0 })
  // Esc closes the top-most layer only, through the same onClose as every other way out (D-101).
  useLayer(open, escClose ? onClose : null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open) {
      el.style.transform = ''
      const t = window.setTimeout(() => el.focus({ preventScroll: true }), 60)
      return () => window.clearTimeout(t)
    }
    const active = document.activeElement as HTMLElement | null
    if (active && el.contains(active)) active.blur()
  }, [open, ref])

  const onPointerDown = (e: PointerEvent) => {
    drag.current = { down: true, dragging: false, y0: e.clientY, dy: 0, t0: Date.now() }
  }
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d.down) return
    d.dy = e.clientY - d.y0
    const el = ref.current
    if (!el) return
    if (!d.dragging && d.dy > 6) {
      d.dragging = true
      el.classList.add('dragging')
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* capture is optional */
      }
    }
    if (d.dragging) el.style.transform = `translateY(${Math.max(0, d.dy)}px)`
  }
  const onPointerEnd = () => {
    const d = drag.current
    if (!d.down) return
    d.down = false
    if (!d.dragging) return
    const el = ref.current
    el?.classList.remove('dragging')
    const velocity = d.dy / Math.max(1, Date.now() - d.t0)
    if (el) el.style.transform = ''
    if (d.dy > 110 || velocity > 0.6) onClose()
    window.setTimeout(() => (drag.current.dragging = false), 0)
  }

  return (
    <div className={'sheet-wrap' + (open ? ' open' : '')} aria-hidden={!open}>
      <div className="backdrop" onClick={onClose} />
      <div
        ref={ref}
        className={'sheet' + (className ? ' ' + className : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        inert={!open}
      >
        <div
          className="sheet-head"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onClickCapture={(e) => {
            if (drag.current.dragging) {
              e.stopPropagation()
              e.preventDefault()
            }
          }}
        >
          <div className="grabber" aria-hidden="true" />
          {head}
        </div>
        {children}
      </div>
    </div>
  )
}
