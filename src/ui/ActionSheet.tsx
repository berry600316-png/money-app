import { useEffect, useRef, type ReactNode } from 'react'

export interface SheetAction {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

/** iOS-style action sheet, used for the few confirmations the app really needs (restore, undo restore). */
export function ActionSheet({
  open,
  onClose,
  title,
  message,
  actions,
}: {
  open: boolean
  onClose: () => void
  title: string
  message?: ReactNode
  actions: SheetAction[]
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 60)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  return (
    <div className={'as-wrap' + (open ? ' open' : '')} aria-hidden={!open} inert={!open}>
      <div className="backdrop" onClick={onClose} />
      <div className="as" role="alertdialog" aria-modal="true" aria-labelledby="as-title" ref={ref} tabIndex={-1}>
        <div className="as-card">
          <h3 id="as-title">{title}</h3>
          {message && <div className="as-msg">{message}</div>}
          {actions.map((a) => (
            <button type="button" key={a.label} className={a.danger ? 'danger' : undefined} disabled={a.disabled} onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </div>
        <button type="button" className="as-cancel" onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  )
}
