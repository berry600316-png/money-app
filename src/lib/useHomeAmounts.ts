import { useEffect, useState } from 'react'

const RESET_EVENT = 'home-amounts-hide'

/** Called before the lock overlay is removed. */
export function hideHomeAmounts(): void {
  window.dispatchEvent(new Event(RESET_EVENT))
}

export function watchAmountPrivacy(hide: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') hide()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', hide)
  window.addEventListener(RESET_EVENT, hide)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', hide)
    window.removeEventListener(RESET_EVENT, hide)
  }
}

export function useHomeAmounts() {
  const [visible, setVisible] = useState(false)
  useEffect(() => watchAmountPrivacy(() => setVisible(false)), [])
  return { visible, toggle: () => setVisible((value) => !value) }
}
