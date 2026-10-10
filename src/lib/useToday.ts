import { useEffect, useState } from 'react'
import { toYmd } from './dates'

/**
 * Today's local date, kept current while the app stays open across midnight
 * (iOS can keep a home-screen app alive for days).
 */
export function useToday(): string {
  const [today, setToday] = useState(() => toYmd(new Date()))
  useEffect(() => {
    const sync = () => setToday(toYmd(new Date()))
    const now = new Date()
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1)
    const t = window.setTimeout(sync, nextMidnight.getTime() - now.getTime())
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [today])
  return today
}
