import { afterEach, expect, it, vi } from 'vitest'
import { hideHomeAmounts, watchAmountPrivacy } from './useHomeAmounts'

afterEach(() => vi.unstubAllGlobals())

it('hides on background, page exit and unlock; removes every listener on cleanup', () => {
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  const hide = vi.fn()
  const dispose = watchAmountPrivacy(hide)
  document.dispatchEvent(new Event('visibilitychange'))
  expect(hide).not.toHaveBeenCalled()
  Object.assign(document, { visibilityState: 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('pagehide'))
  hideHomeAmounts()
  expect(hide).toHaveBeenCalledTimes(3)
  dispose()
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('pagehide'))
  hideHomeAmounts()
  expect(hide).toHaveBeenCalledTimes(3)
})
