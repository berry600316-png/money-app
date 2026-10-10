/*
 * D-06: follow the iPhone text-size setting, capped at 1.3×.
 * Safari exposes the user's preferred size through `font: -apple-system-body`
 * (17px at the default setting). Other browsers keep the 16px base.
 */
const DEFAULT_BODY_PX = 17
const MIN_SCALE = 0.88
const MAX_SCALE = 1.3

export function applyTextScale(): void {
  let scale = 1
  if (typeof CSS !== 'undefined' && CSS.supports('font', '-apple-system-body')) {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;font:-apple-system-body'
    probe.textContent = 'x'
    document.body.appendChild(probe)
    const px = parseFloat(getComputedStyle(probe).fontSize)
    probe.remove()
    if (px > 0) scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, px / DEFAULT_BODY_PX))
  }
  document.documentElement.style.fontSize = `${(16 * scale).toFixed(2)}px`
}

export function watchTextScale(): void {
  applyTextScale()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') applyTextScale()
  })
}
