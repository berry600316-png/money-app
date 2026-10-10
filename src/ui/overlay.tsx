import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A layer inside the app shell for action sheets opened from scrolling pages. */
export const OverlayContext = createContext<HTMLElement | null>(null)

export function Overlay({ children }: { children: ReactNode }) {
  const el = useContext(OverlayContext)
  return el ? createPortal(children, el) : null
}
