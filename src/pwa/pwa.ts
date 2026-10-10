import { useSyncExternalStore } from 'react'

/*
 * Service worker + storage status shared with the settings page.
 * D-43: a new version is applied only at a safe moment — right at launch, or when the
 * app goes to the background with no sheet open — never while the user is typing.
 */

export interface PwaState {
  /** Service workers exist in this browser and the app is served over HTTPS/localhost. */
  supported: boolean
  /** App assets are cached; the app opens without network. */
  offlineReady: boolean
  /** null = unknown / API missing */
  persisted: boolean | null
}

let state: PwaState = { supported: false, offlineReady: false, persisted: null }
const listeners = new Set<() => void>()

function set(patch: Partial<PwaState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function usePwaState(): PwaState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

const LAUNCH_WINDOW_MS = 4000

export async function initPwa(canReloadNow: () => boolean): Promise<void> {
  void refreshPersisted()
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return
  set({ supported: true, offlineReady: !!navigator.serviceWorker.controller })

  const startedAt = Date.now()
  let pending = false
  const { registerSW } = await import('virtual:pwa-register')
  const updateSW = registerSW({
    immediate: true,
    onOfflineReady() {
      set({ offlineReady: true })
    },
    onNeedRefresh() {
      pending = true
      if (Date.now() - startedAt < LAUNCH_WINDOW_MS && canReloadNow()) void updateSW(true)
    },
    onRegisteredSW(_url, reg) {
      // iOS keeps standalone apps alive for days; look for updates when the app comes back.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg?.update()
      })
    },
  })
  navigator.serviceWorker.ready.then(() => set({ offlineReady: true }))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pending && canReloadNow()) void updateSW(true)
  })
}

export async function refreshPersisted(): Promise<void> {
  try {
    if (navigator.storage?.persisted) set({ persisted: await navigator.storage.persisted() })
  } catch {
    set({ persisted: null })
  }
}

/** Ask the browser to keep our data (spec 0.9). It may still say no; we show the real answer. */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null
    if (await navigator.storage.persisted()) {
      set({ persisted: true })
      return true
    }
    const granted = await navigator.storage.persist()
    set({ persisted: granted })
    return granted
  } catch {
    return null
  }
}
