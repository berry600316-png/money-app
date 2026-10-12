import { useEffect, useState } from 'react'

/** D-98: about 1.5 s from first frame to the home screen (User asked for 1.5 s). */
const HOLD_MS = 1150
const FADE_MS = 350

let appReady = false
const readyListeners = new Set<() => void>()

/** Called once the home screen has its data (the launch never pretends data is loaded). */
export function markAppReady(): void {
  if (appReady) return
  appReady = true
  for (const l of readyListeners) l()
}

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Cold-start brand mark (D-98 option C, reshaped by D-116: a notched square drawn around "CJ", a short rule,
 * "CAI JIE"). Mounted once per page load,
 * so returning from the background never replays it. A tap skips it once data is ready.
 */
export function Launch() {
  const [phase, setPhase] = useState<'play' | 'out' | 'gone'>(() => (reduceMotion() ? 'gone' : 'play'))

  useEffect(() => {
    if (phase !== 'play') return
    let held = false
    let ready = appReady
    const tryOut = () => {
      if (held && ready) setPhase('out')
    }
    const t = window.setTimeout(() => {
      held = true
      tryOut()
    }, HOLD_MS)
    const onReady = () => {
      ready = true
      tryOut()
    }
    readyListeners.add(onReady)
    return () => {
      window.clearTimeout(t)
      readyListeners.delete(onReady)
    }
  }, [phase])

  useEffect(() => {
    if (phase !== 'out') return
    document.documentElement.classList.add('app-entering')
    const t = window.setTimeout(() => {
      setPhase('gone')
      document.documentElement.classList.remove('app-entering')
    }, FADE_MS + 250)
    return () => window.clearTimeout(t)
  }, [phase])

  if (phase === 'gone') return null
  return (
    <div
      className={'launch' + (phase === 'out' ? ' out' : '')}
      aria-hidden="true"
      onPointerDown={() => {
        if (appReady) setPhase('out')
      }}
    >
      <div className="mark">
        <div className="mono">
          <svg viewBox="0 0 80 80" aria-hidden="true">
            <path d="M1 1H65L79 15V79H15L1 65Z" pathLength="100" />
          </svg>
          <b>CJ</b>
        </div>
        <i className="rule" />
        <span className="word">CAI JIE</span>
      </div>
    </div>
  )
}
