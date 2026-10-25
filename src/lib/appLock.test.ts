import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from '../db/db'
import { buildBackup, DEVICE_SETTING_KEYS, parseBackup } from '../backup/format'
import { readAllData, restoreBackup, undoRestore } from '../backup/store'
import {
  APP_LOCK_KEY,
  fromBase64Url,
  isPin,
  passkeyUnusable,
  readLockConfig,
  relockOnReturn,
  RELOCK_AFTER_MS,
  saveLockConfig,
  toBase64Url,
  userVerified,
} from './appLock'

describe('App 鎖 rules (D-146)', () => {
  it('the App PIN is exactly 6 digits', () => {
    expect(['123456', '000000'].every(isPin)).toBe(true)
    for (const bad of ['12345', '1234567', '12345a', '１２３４５６', ' 123456', '', 123456, null]) expect(isPin(bad), String(bad)).toBe(false)
  })

  it('a stored value is a lock only when it is well formed', () => {
    expect(readLockConfig({ pin: '123456', credentialId: 'abc' })).toEqual({ pin: '123456', credentialId: 'abc' })
    expect(readLockConfig({ pin: '123456' })).toEqual({ pin: '123456', credentialId: null })
    expect(readLockConfig({ pin: '123456', credentialId: '' })).toEqual({ pin: '123456', credentialId: null })
    for (const bad of [null, undefined, 'x', [], {}, { pin: '12345' }, { pin: 123456 }]) expect(readLockConfig(bad)).toBeNull()
  })

  it('asks again only after a minute away (exactly a minute counts)', () => {
    const t = 1_000_000
    expect(relockOnReturn(null, t)).toBe(false)
    expect(relockOnReturn(t, t + 59_999)).toBe(false)
    expect(relockOnReturn(t, t + RELOCK_AFTER_MS)).toBe(true)
    expect(relockOnReturn(t, t + 3_600_000)).toBe(true)
  })

  it('passkey helpers: base64url round trip, the user-verified flag, errors that mean "cannot here"', () => {
    for (const bytes of [new Uint8Array([]), new Uint8Array([0, 255, 62, 63, 250]), crypto.getRandomValues(new Uint8Array(33))]) {
      const s = toBase64Url(bytes)
      expect(s).not.toMatch(/[+/=]/)
      expect([...fromBase64Url(s)]).toEqual([...bytes])
    }
    const auth = (flags: number) => {
      const a = new Uint8Array(37)
      a[32] = flags
      return a
    }
    expect(userVerified(auth(0x05))).toBe(true) // UP + UV
    expect(userVerified(auth(0x01))).toBe(false) // presence only
    expect(userVerified(new Uint8Array(10))).toBe(false)
    expect(passkeyUnusable(new DOMException('x', 'NotAllowedError'))).toBe(false) // cancelled: try again or use the PIN
    expect(passkeyUnusable(new DOMException('x', 'SecurityError'))).toBe(true)
    expect(passkeyUnusable(new DOMException('x', 'NotSupportedError'))).toBe(true)
  })
})

describe('App 鎖 stays on this iPhone (D-146)', () => {
  let a: MoneyDB
  let b: MoneyDB
  let n = 0
  const now = new Date(2026, 9, 25, 20, 0)
  beforeEach(async () => {
    a = new MoneyDB(`lock-a-${n}`)
    b = new MoneyDB(`lock-b-${n++}`)
    await Promise.all([a.open(), b.open()])
  })
  afterEach(() => {
    a.close()
    b.close()
  })

  it('saves and removes the lock; refuses a PIN that is not 6 digits', async () => {
    await saveLockConfig({ pin: '246810', credentialId: 'cred' }, a)
    expect(readLockConfig((await a.settings.get(APP_LOCK_KEY))?.value)).toEqual({ pin: '246810', credentialId: 'cred' })
    await expect(saveLockConfig({ pin: '2468', credentialId: null }, a)).rejects.toThrow('6 位')
    await saveLockConfig(null, a)
    expect(await a.settings.get(APP_LOCK_KEY)).toBeUndefined()
  })

  it('never goes into a backup file, and a restore (and its undo) keeps this iPhone\'s lock', async () => {
    expect(DEVICE_SETTING_KEYS.has(APP_LOCK_KEY)).toBe(true)
    await saveLockConfig({ pin: '135790', credentialId: 'from-a' }, a)
    const text = JSON.stringify(buildBackup(await readAllData(a), now))
    expect(text).not.toContain('135790')
    expect(text).not.toContain('from-a')
    expect(text).not.toContain(APP_LOCK_KEY)

    // A file that carries one anyway (edited by hand) does not bring it in.
    const forged = JSON.parse(text)
    forged.settings.push({ key: APP_LOCK_KEY, value: { pin: '000000', credentialId: 'forged' } })
    expect(parseBackup(JSON.stringify(forged)).settings.some((s) => s.key === APP_LOCK_KEY)).toBe(false)

    await saveLockConfig({ pin: '864200', credentialId: 'on-b' }, b)
    await restoreBackup(parseBackup(JSON.stringify(forged)), b, now)
    expect(readLockConfig((await b.settings.get(APP_LOCK_KEY))?.value)).toEqual({ pin: '864200', credentialId: 'on-b' })
    await undoRestore(b)
    expect(readLockConfig((await b.settings.get(APP_LOCK_KEY))?.value)).toEqual({ pin: '864200', credentialId: 'on-b' })
  })
})
