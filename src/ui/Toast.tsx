import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'

interface ToastState {
  id: number
  msg: string
  kind: 'ok' | 'error'
  undo?: () => void
}

type Show = (msg: string, opts?: { kind?: 'ok' | 'error'; undo?: () => void }) => void

const Ctx = createContext<Show>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<ToastState | null>(null)
  const [visible, setVisible] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const seq = useRef(0)

  const show = useCallback<Show>((msg, opts = {}) => {
    seq.current += 1
    setT({ id: seq.current, msg, kind: opts.kind ?? 'ok', undo: opts.undo })
    setVisible(true)
    window.clearTimeout(timer.current)
    const ms = opts.undo ? 4500 : opts.kind === 'error' ? 4000 : 2200
    timer.current = window.setTimeout(() => setVisible(false), ms)
  }, [])

  return (
    <Ctx.Provider value={show}>
      {children}
      <div className={'toast' + (visible ? ' show' : '') + (t?.kind === 'error' ? ' error' : '')} role="status" aria-live="polite">
        {t && (
          <>
            <span className="t-ic">
              <Icon name={t.kind === 'error' ? 'alert' : 'check'} />
            </span>
            <span className="t-msg">{t.msg}</span>
            {t.undo && (
              <button
                type="button"
                onClick={() => {
                  setVisible(false)
                  t.undo?.()
                }}
              >
                復原
              </button>
            )}
          </>
        )}
      </div>
    </Ctx.Provider>
  )
}

export function useToast(): Show {
  return useContext(Ctx)
}
