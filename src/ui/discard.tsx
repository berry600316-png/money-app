/*
 * D-101: unsaved-changes protection. A form registers "am I dirty?" under an id; every way of closing it
 * (取消, scrim, drag down, Esc, back) goes through useCloseGuard(id)(close), which asks
 * "要捨棄這次修改嗎？" only when the form differs from how it was opened.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActionSheet } from './ActionSheet'

const checks = new Map<string, () => boolean>()

/** Register the form's dirty check while it is open. `isDirty` may change every render. */
export function useDirtyCheck(id: string, open: boolean, isDirty: () => boolean): void {
  const latest = useRef(isDirty)
  latest.current = isDirty
  useEffect(() => {
    if (!open) return
    const check = () => latest.current()
    checks.set(id, check)
    return () => {
      if (checks.get(id) === check) checks.delete(id)
    }
  }, [id, open])
}

export function isDirty(id: string): boolean {
  return checks.get(id)?.() ?? false
}

interface DiscardState {
  request: (id: string, close: () => void) => void
  pending: (() => void) | null
  keep: () => void
}
const Ctx = createContext<DiscardState>({ request: (_id, close) => close(), pending: null, keep: () => {} })

/** State only; <DiscardHost /> draws the confirmation inside the app frame. */
export function DiscardProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(() => void) | null>(null)
  const request = useCallback((id: string, close: () => void) => {
    if (isDirty(id)) setPending(() => close)
    else close()
  }, [])
  const keep = useCallback(() => setPending(null), [])
  const value = useMemo(() => ({ request, pending, keep }), [request, pending, keep])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function DiscardHost() {
  const { pending, keep } = useContext(Ctx)
  return (
    <ActionSheet
      open={pending !== null}
      onClose={keep}
      className="top"
      title="要捨棄這次修改嗎？"
      message="改過的內容還沒儲存。"
      cancelLabel="繼續編輯"
      actions={[
        {
          label: '捨棄修改',
          danger: true,
          onClick: () => {
            keep()
            pending?.()
          },
        },
      ]}
    />
  )
}

/** `guard(close)` closes right away when nothing changed, else asks first. */
export function useCloseGuard(id: string): (close: () => void) => void {
  const { request } = useContext(Ctx)
  return useCallback((close: () => void) => request(id, close), [request, id])
}

/** True while the "discard?" question is showing (other Esc handlers stand down). */
export function useDiscardAsking(): boolean {
  return useContext(Ctx).pending !== null
}
