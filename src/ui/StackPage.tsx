import { useEffect, useState, type ReactNode } from 'react'

/** A pushed page that slides in from the right after mounting and out before unmounting. */
export function StackPage({ closing, covered, label, children }: { closing: boolean; covered: boolean; label: string; children: ReactNode }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    // A timer (not rAF) so it also runs while the app is in the background.
    const t = window.setTimeout(() => setShown(true), 20)
    return () => window.clearTimeout(t)
  }, [])
  const open = shown && !closing
  return (
    <section className={'page' + (open ? ' open' : '') + (covered ? ' covered' : '')} aria-label={label} aria-hidden={!open} inert={!open || covered}>
      {children}
    </section>
  )
}
