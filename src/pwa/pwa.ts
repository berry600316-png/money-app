import { useSyncExternalStore } from 'react'

/*
 * Service worker + storage status shared with the settings page.
 * D-43: apply updates only after the user explicitly chooses to refresh.
 */

export interface PwaState {
  /** Service workers exist in this browser and the app is served over HTTPS/localhost. */
  supported: boolean
  /** App assets are cached; the app opens without network. */
  offlineReady: boolean
  /** null = unknown / API missing */
  persisted: boolean | null
  updateAvailable: boolean
}

let state: PwaState = { supported: false, offlineReady: false, persisted: null, updateAvailable: false }
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

let initialized = false
let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined

export function dismissUpdate(): void {
  set({ updateAvailable: false })
}

export async function applyUpdate(): Promise<void> {
  await updateSW?.(true)
}

export async function initPwa(): Promise<void> {
  void refreshPersisted()
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD || initialized) return
  initialized = true
  set({ supported: true, offlineReady: !!navigator.serviceWorker.controller })
  try {
    const { registerSW } = await import('virtual:pwa-register')
    updateSW = registerSW({
      immediate: true,
      onOfflineReady() { set({ offlineReady: true }) },
      onNeedRefresh() { set({ updateAvailable: true }) },
      onRegisteredSW(_url, reg) {
        if (!reg) return
        const check = () => {
          if (document.visibilityState === 'visible' && navigator.onLine !== false) {
            void reg.update().catch(() => undefined)
          }
        }
        document.addEventListener('visibilitychange', check)
        window.addEventListener('online', check)
        window.setInterval(check, 60 * 60 * 1000)
        check()
      },
      onRegisterError() { initialized = false },
    })
    void navigator.serviceWorker.ready.then(() => set({ offlineReady: true })).catch(() => undefined)
  } catch {
    initialized = false
  }
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
