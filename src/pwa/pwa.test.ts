import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  apply: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('virtual:pwa-register', () => ({ registerSW: mocks.register }))
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubEnv('PROD', true)
  vi.stubGlobal('navigator', { serviceWorker: { controller: {}, ready: Promise.resolve() }, onLine: true })
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval }))
  mocks.register.mockReturnValue(mocks.apply)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
describe('PWA update prompt', () => {
  it('prompts without automatically reloading at launch or in the background', async () => {
    const pwa = await import('./pwa')
    await pwa.initPwa()
    mocks.register.mock.calls[0][0].onNeedRefresh()
    expect(pwa.usePwaState().updateAvailable).toBe(true)
    Object.assign(document, { visibilityState: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mocks.apply).not.toHaveBeenCalled()
    pwa.dismissUpdate()
    expect(pwa.usePwaState().updateAvailable).toBe(false)
    expect(mocks.apply).not.toHaveBeenCalled()
    await pwa.applyUpdate()
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(true)
  })
  it('registers once and checks on return, reconnect and hourly without applying', async () => {
    const pwa = await import('./pwa')
    await Promise.all([pwa.initPwa(), pwa.initPwa()])
    expect(mocks.register).toHaveBeenCalledTimes(1)
    const update = vi.fn().mockResolvedValue(undefined)
    mocks.register.mock.calls[0][0].onRegisteredSW('/sw.js', { update })
    expect(update).toHaveBeenCalledTimes(1)
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(update).toHaveBeenCalledTimes(4)
    Object.assign(document, { visibilityState: 'hidden' })
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(update).toHaveBeenCalledTimes(4)
    expect(mocks.apply).not.toHaveBeenCalled()
  })
})
