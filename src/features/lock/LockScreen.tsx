/*
 * D-146: the App 鎖 screens. AppLockGate sits in front of the app; LockPanel asks for Face ID first and the
 * App PIN only after Face ID was cancelled, failed or cannot be used here; PinPad is the 6-digit keypad.
 * All of them are drawn on top of everything (portal to <body>) with the app underneath made inert.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import {
  APP_LOCK_KEY,
  PIN_LENGTH,
  holdAppInert,
  passkeyAvailable,
  passkeyUnusable,
  readLockConfig,
  relockOnReturn,
  verifyPasskey,
  type AppLockConfig,
} from '../../lib/appLock'
import { Icon } from '../../ui/Icon'

const ICON_SRC = `${import.meta.env.BASE_URL}pwa-192x192.png`

/** Lock screens on top of each other; only the last one answers keys. */
const screens: HTMLElement[] = []
const onTop = (el: Element | null) => {
  const top = screens[screens.length - 1]
  return !!top && !!el && top.contains(el)
}

/**
 * A full-screen layer in front of the app. No key reaches the app underneath while it is up (a hardware
 * keyboard would otherwise type into an open entry, or save it with Enter); Esc runs `onEsc` when given.
 */
export function Screen({ children, className, label, onEsc }: { children: ReactNode; className?: string; label: string; onEsc?: (() => void) | null }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const esc = useRef(onEsc)
  esc.current = onEsc
  useEffect(() => holdAppInert(), [])
  useEffect(() => {
    const me = ref.current
    if (!me) return
    screens.push(me)
    // Capture phase at window: runs before every other key listener, which then never see the key.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape' && screens[screens.length - 1] === me && esc.current) {
        e.preventDefault()
        esc.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const i = screens.lastIndexOf(me)
      if (i >= 0) screens.splice(i, 1)
    }
  }, [])
  return createPortal(
    <div ref={ref} className={'lock' + (className ? ' ' + className : '')} role="dialog" aria-modal="true" aria-label={label}>
      {children}
    </div>,
    document.body,
  )
}

/** Only the app's mark: while the lock is being read, and whenever the app is in the background (D-146). */
export function LockCover() {
  return (
    <Screen className="lock-cover" label="Cai Jie">
      <img className="lk-icon" src={ICON_SRC} alt="" />
    </Screen>
  )
}

/** Six digits; `onSubmit` returns false for a wrong PIN (the dots shake and clear). */
export function PinPad({
  title,
  sub,
  error,
  onSubmit,
  left,
  footer,
  onCancel,
}: {
  title: string
  sub?: ReactNode
  error?: string | null
  onSubmit: (pin: string) => boolean | Promise<boolean>
  left?: { label: string; onClick: () => void } | null
  footer?: ReactNode
  onCancel?: (() => void) | null
}) {
  const [digits, setDigits] = useState('')
  const [wrong, setWrong] = useState(0)
  const busy = useRef(false)
  const root = useRef<HTMLDivElement | null>(null)
  // The digits so far, read at the moment of each tap: two quick taps before a re-render must both count.
  const typed = useRef('')
  const show = (d: string) => {
    typed.current = d
    setDigits(d)
  }
  const press = (k: string) => {
    if (busy.current) return
    if (k === 'del') return show(typed.current.slice(0, -1))
    if (typed.current.length >= PIN_LENGTH) return
    const next = typed.current + k
    show(next)
    if (next.length === PIN_LENGTH) {
      busy.current = true
      void Promise.resolve(onSubmit(next)).then((ok) => {
        busy.current = false
        if (!ok) {
          setWrong((n) => n + 1)
          show('')
        }
      })
    }
  }
  // A hardware keyboard (desktop testing, iPad keyboards); only on the top lock screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!onTop(root.current) || e.metaKey || e.ctrlKey || e.altKey) return
      if (/^[0-9]$/.test(e.key)) press(e.key)
      else if (e.key === 'Backspace') press('del')
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  return (
    <div className="pin" ref={root}>
      {onCancel && (
        <button type="button" className="lk-cancel" onClick={onCancel}>
          取消
        </button>
      )}
      <h2 className="pin-title">{title}</h2>
      {sub && <p className="pin-sub">{sub}</p>}
      <div className={'pin-dots' + (wrong ? ' shake' : '')} key={wrong} role="img" aria-label={`已輸入 ${digits.length} 位，共 ${PIN_LENGTH} 位`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <i key={i} className={i < digits.length ? 'on' : ''} />
        ))}
      </div>
      <p className="pin-err" aria-live="assertive">
        {error ?? (wrong ? '密碼不正確，請再試一次' : '')}
      </p>
      <div className="pin-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
          <button type="button" key={k} className="pin-key" onClick={() => press(k)}>
            {k}
          </button>
        ))}
        {left ? (
          <button type="button" className="pin-key fn" onClick={left.onClick}>
            {left.label}
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="pin-key" onClick={() => press('0')}>
          0
        </button>
        <button type="button" className="pin-key fn" aria-label="刪除一位" onClick={() => press('del')}>
          刪除
        </button>
      </div>
      {footer && <div className="pin-foot">{footer}</div>}
    </div>
  )
}

function ForgotHelp({ onBack }: { onBack: () => void }) {
  return (
    <div className="lk-help">
      <h2>忘記 App 密碼</h2>
      <p>
        <b>Face ID 還能用的話：</b>用 Face ID 解鎖後，到「設定 › App 鎖 › 更改 App 密碼」設新的。
      </p>
      <p>
        <b>Face ID 也不能用的話</b>，只能清掉這支 iPhone 上這個 App 的資料重來：
      </p>
      <ol>
        <li>iPhone「設定」› App › Safari › 進階 › 網站資料</li>
        <li>找到這個 App 的網址，刪除</li>
        <li>重新打開 App，用備份檔還原</li>
      </ol>
      <p className="lk-warn">沒有備份的話，資料會全部不見。</p>
      <button type="button" className="lk-btn ghost" onClick={onBack}>
        返回
      </button>
    </div>
  )
}

/**
 * Face ID, then (after it was cancelled or failed) the App PIN (D-146). `verify` asks before a change in the
 * settings and can be cancelled; `unlock` cannot.
 */
export function LockPanel({
  mode,
  cfg,
  onUnlocked,
  onCancel,
}: {
  mode: 'unlock' | 'verify'
  cfg: AppLockConfig
  onUnlocked: () => void
  onCancel?: () => void
}) {
  const canFace = !!cfg.credentialId && passkeyAvailable()
  const [view, setView] = useState<'face' | 'pin' | 'help'>(canFace ? 'face' : 'pin')
  const [failed, setFailed] = useState(false)
  const [faceGone, setFaceGone] = useState(false)
  const [busy, setBusy] = useState(false)
  const cancel = mode === 'verify' && onCancel ? onCancel : null

  const tryFace = async (byTap: boolean) => {
    if (!cfg.credentialId || busy) return
    setBusy(true)
    const started = performance.now()
    try {
      if (await verifyPasskey(cfg.credentialId)) return onUnlocked()
      setFailed(true)
    } catch (err) {
      if (passkeyUnusable(err)) {
        setFaceGone(true)
        setView('pin')
      } else if (byTap || performance.now() - started > 700) {
        // Cancelled or failed in the system sheet. (An instant refusal of the automatic try is iOS asking
        // for a tap first: the button stays, no "failed" yet.)
        setFailed(true)
      }
    } finally {
      setBusy(false)
    }
  }

  // Try Face ID straight away (iOS may want a tap first: then the button does it).
  const tried = useRef(false)
  useEffect(() => {
    if (view !== 'face' || tried.current) return
    tried.current = true
    void tryFace(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const label = mode === 'unlock' ? 'App 已上鎖' : '驗證身分'
  if (view === 'help')
    return (
      <Screen className="lock-pin" label={label} onEsc={() => setView('pin')}>
        <ForgotHelp onBack={() => setView('pin')} />
      </Screen>
    )
  if (view === 'pin')
    return (
      <Screen className="lock-pin" label={label} onEsc={cancel}>
        <PinPad
          title="輸入 App 密碼"
          sub={faceGone ? '這支 iPhone 現在無法使用 Face ID' : undefined}
          onSubmit={(pin) => {
            if (pin !== cfg.pin) return false
            onUnlocked()
            return true
          }}
          left={canFace && !faceGone ? { label: 'Face ID', onClick: () => (setView('face'), void tryFace(true)) } : null}
          footer={
            <button type="button" className="lk-link sub" onClick={() => setView('help')}>
              忘記密碼？
            </button>
          }
          onCancel={cancel}
        />
      </Screen>
    )
  return (
    <Screen label={label} onEsc={cancel}>
      {cancel && (
        <button type="button" className="lk-cancel" onClick={cancel}>
          取消
        </button>
      )}
      <div className="lk-top">
        <img className="lk-icon" src={ICON_SRC} alt="" />
        <h2 className="lk-name">Cai Jie</h2>
        <p className="lk-msg">{failed ? '沒有完成驗證' : mode === 'unlock' ? '已上鎖' : '請先驗證身分'}</p>
      </div>
      <div className="lk-act">
        <button type="button" className="lk-btn" disabled={busy} onClick={() => void tryFace(true)}>
          <Icon name="faceId" />
          {failed ? '再試一次 Face ID' : mode === 'unlock' ? '用 Face ID 解鎖' : '用 Face ID 驗證'}
        </button>
        {failed && (
          <button type="button" className="lk-link" onClick={() => setView('pin')}>
            改用 App 密碼
          </button>
        )}
      </div>
    </Screen>
  )
}

/**
 * In front of the app (D-146): locked when the app starts and when it comes back after being away for a minute;
 * covered (just the mark) while it is in the background, so the app switcher shows no amounts.
 */
export function AppLockGate() {
  // undefined = still reading: cover until it is known, so nothing shows before a lock can.
  const raw = useLiveQuery(async () => (await db.settings.get(APP_LOCK_KEY))?.value ?? null, [])
  const cfg = raw === undefined ? undefined : readLockConfig(raw)
  const [phase, setPhase] = useState<'start' | 'open' | 'locked'>('start')
  const [covered, setCovered] = useState(false)
  const [round, setRound] = useState(0)
  const hiddenAt = useRef<number | null>(null)
  const on = useRef(false)
  on.current = !!cfg

  useEffect(() => {
    if (cfg === undefined) return
    if (phase === 'start') setPhase(cfg ? 'locked' : 'open')
    else if (!cfg && phase === 'locked') setPhase('open') // the lock was turned off
  }, [cfg, phase])

  useEffect(() => {
    const onVis = () => {
      if (!on.current) return
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now()
        setCovered(true)
        return
      }
      if (relockOnReturn(hiddenAt.current, Date.now())) {
        setPhase('locked')
        setRound((n) => n + 1) // a fresh lock screen, which tries Face ID again
      }
      hiddenAt.current = null
      setCovered(false)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  if (cfg === undefined || phase === 'start') return <LockCover />
  if (phase === 'locked' && cfg) return <LockPanel key={round} mode="unlock" cfg={cfg} onUnlocked={() => setPhase('open')} />
  return covered ? <LockCover /> : null
}
