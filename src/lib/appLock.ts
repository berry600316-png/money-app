/*
 * App 鎖 (D-146): a screen in front of the app, not encryption. Face ID through a passkey first (when Face ID
 * fails, iOS itself offers the iPhone passcode), the app's own 6-digit PIN only as the last resort.
 * Kept in settings under `appLock`, a device setting (backup/format.ts): never in a backup file, never replaced
 * by a restore. The PIN is kept as typed (User's decision, 2026-10-25). With no server, the passkey answer is
 * taken from the iPhone as it comes: the app checks the credential and that the user was verified.
 */
import { db, type MoneyDB } from '../db/db'

export const APP_LOCK_KEY = 'appLock'
export const PIN_LENGTH = 6
/** Away from the app this long (ms), and it asks again on return. */
export const RELOCK_AFTER_MS = 60_000

export interface AppLockConfig {
  pin: string
  /** The passkey for Face ID (base64url), null until one is added. */
  credentialId: string | null
}

export const isPin = (s: unknown): s is string => typeof s === 'string' && /^[0-9]{6}$/.test(s)

/** A stored value as a lock, or null (no lock). Anything malformed counts as no lock. */
export function readLockConfig(v: unknown): AppLockConfig | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (!isPin(o.pin)) return null
  const id = typeof o.credentialId === 'string' && o.credentialId ? o.credentialId : null
  return { pin: o.pin, credentialId: id }
}

export async function saveLockConfig(c: AppLockConfig | null, d: MoneyDB = db): Promise<void> {
  if (c === null) await d.settings.delete(APP_LOCK_KEY)
  else {
    if (!isPin(c.pin)) throw new Error('App 密碼需為 6 位數字')
    await d.settings.put({ key: APP_LOCK_KEY, value: { pin: c.pin, credentialId: c.credentialId } })
  }
}

/** Coming back after being away since `hiddenAt`: ask again? */
export function relockOnReturn(hiddenAt: number | null, now: number): boolean {
  return hiddenAt !== null && now - hiddenAt >= RELOCK_AFTER_MS
}

/* ---------------- passkey (WebAuthn) ---------------- */

export function passkeyAvailable(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Authenticator data, byte 32 = flags; bit 2 (UV) = the user was verified (Face ID or the iPhone passcode). */
export function userVerified(authData: Uint8Array): boolean {
  return authData.length > 32 && (authData[32] & 0x04) !== 0
}

/** Adds a passkey on this iPhone (Face ID). Returns its id; throws when cancelled or not possible. */
export async function registerPasskey(): Promise<string> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: 'Cai Jie' },
      user: { id: randomBytes(16), name: 'Cai Jie', displayName: 'Cai Jie' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('沒有建立通行密鑰')
  return toBase64Url(new Uint8Array(cred.rawId))
}

let pending: Promise<boolean> | null = null

/**
 * Face ID with that passkey. true = verified; false = answered but not verified; throws when cancelled,
 * failed or not possible here (DOMException name: NotAllowedError, SecurityError, …). One request at a time.
 */
export function verifyPasskey(credentialId: string): Promise<boolean> {
  if (pending) return pending
  pending = (async () => {
    try {
      const cred = (await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) }],
          userVerification: 'required',
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null
      if (!cred || toBase64Url(new Uint8Array(cred.rawId)) !== credentialId) return false
      return userVerified(new Uint8Array((cred.response as AuthenticatorAssertionResponse).authenticatorData))
    } finally {
      pending = null
    }
  })()
  return pending
}

/** This device cannot do it at all (rather than the user cancelling): go straight to the App PIN. */
export function passkeyUnusable(err: unknown): boolean {
  const name = err instanceof DOMException ? err.name : ''
  return name === 'SecurityError' || name === 'NotSupportedError' || name === 'InvalidStateError'
}

/* ---------------- the app behind the lock ---------------- */

let held = 0

/** While a lock screen is up, the app underneath cannot be reached (taps, keyboard, VoiceOver). */
export function holdAppInert(): () => void {
  held += 1
  document.querySelector('.device')?.setAttribute('inert', '')
  return () => {
    held -= 1
    if (held === 0) document.querySelector('.device')?.removeAttribute('inert')
  }
}
