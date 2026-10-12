/*
 * Big amounts never get cut off or run off the screen: when one does not fit its box (an 8-digit
 * month, the largest iPhone text size, a narrow phone), its font shrinks just enough to fit; when it
 * fits again it goes back to its normal size. It measures what is really drawn, so it holds for the
 * iPhone's own fonts too.
 */

/**
 * Amount boxes that must show every digit, each one line: the box measured, and the element whose
 * font shrinks (null = the box itself; the 「NT$」 in it keeps its own size).
 */
const BOXES: [box: string, big: string | null][] = [
  ['.hero-amt', null],
  ['.acc-amt', null],
  ['.pl-amt', null],
  ['.trio dd', null],
  ['.trio .v', null],
  ['.amt-wrap', '.amt'],
  ['.recon-big', '.num'],
]

/** Width the content really takes (centred content overflows on both sides, which scrollWidth misses). */
function needed(el: HTMLElement): number {
  const r = document.createRange()
  r.selectNodeContents(el)
  const cs = getComputedStyle(el)
  return r.getBoundingClientRect().width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
}

function fit(box: HTMLElement, big: HTMLElement) {
  big.style.fontSize = ''
  const avail = box.clientWidth
  if (!avail) return
  const normal = parseFloat(getComputedStyle(big).fontSize)
  // The parts in fixed units (「NT$」) do not shrink, so a few passes may be needed.
  for (let i = 0; i < 4; i++) {
    const need = needed(box)
    if (need <= avail + 0.5) return
    const size = parseFloat(getComputedStyle(big).fontSize)
    const next = Math.max(normal * 0.4, Math.floor(size * (avail / need) * 100) / 100)
    if (next >= size - 0.01) return
    big.style.fontSize = `${next}px`
  }
}

// Mutation callbacks already come batched (once per task), so this runs right away rather than on
// the next frame, which a page in the background never gets.
function fitAll() {
  for (const [boxSel, bigSel] of BOXES) {
    document.querySelectorAll<HTMLElement>(boxSel).forEach((box) => {
      const big = bigSel ? box.querySelector<HTMLElement>(bigSel) : box
      if (big) fit(box, big)
    })
  }
}

export function watchFitText(): void {
  if (typeof MutationObserver === 'undefined') return
  // Numbers change (and count up) by text updates; screens come and go by node changes.
  new MutationObserver(fitAll).observe(document.body, { subtree: true, childList: true, characterData: true })
  // Rotation, window size, and the text size (D-06 changes the root font size).
  window.addEventListener('resize', fitAll)
  new MutationObserver(fitAll).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  document.fonts?.ready.then(fitAll)
  fitAll()
}
