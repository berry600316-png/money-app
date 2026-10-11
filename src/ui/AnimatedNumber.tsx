import { useEffect, useRef, useState } from 'react'
import { fmt } from '../lib/money'

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * D-113: a quiet count from the old value to the new one (≈0.4 s, ease-out). Never a slot-machine roll;
 * the number stays readable throughout. The first value appears as is.
 */
export function AnimatedNumber({ value, className, abs = true }: { value: number; className?: string; abs?: boolean }) {
  const [shown, setShown] = useState(value)
  // Where the number is on screen right now, so a change mid-count continues from there.
  const onScreen = useRef(value)
  const raf = useRef(0)
  useEffect(() => {
    const start = onScreen.current
    // Hidden pages get no animation frames: show the value at once.
    if (start === value || reduceMotion() || document.visibilityState !== 'visible') {
      onScreen.current = value
      setShown(value)
      return
    }
    const t0 = performance.now()
    const dur = 420
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur)
      const e = 1 - Math.pow(1 - p, 3)
      onScreen.current = Math.round(start + (value - start) * e)
      setShown(onScreen.current)
      if (p < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    // Frames can stop mid-count (app sent to the background): always land on the real value.
    const done = window.setTimeout(() => {
      cancelAnimationFrame(raf.current)
      onScreen.current = value
      setShown(value)
    }, dur + 80)
    return () => {
      cancelAnimationFrame(raf.current)
      window.clearTimeout(done)
    }
  }, [value])
  return <span className={className}>{fmt(abs ? Math.abs(shown) : shown)}</span>
}
