import { db, type MoneyDB } from '../db/db'
import type { Setting } from '../db/types'
import { DEVICE_SETTING_KEYS, type BackupFile, type MoneyData } from './format'

export interface Snapshot {
  takenAt: string
  data: MoneyData
}

export async function readAllData(d: MoneyDB = db): Promise<MoneyData> {
  return d.transaction('r', d.transactions, d.categories, d.paymentMethods, d.settings, async () => ({
    transactions: await d.transactions.toArray(),
    categories: await d.categories.toArray(),
    paymentMethods: await d.paymentMethods.toArray(),
    settings: (await d.settings.toArray()).filter((s) => !DEVICE_SETTING_KEYS.has(s.key)),
  }))
}

/** Replace user data inside an already-open rw transaction; device settings are kept. */
async function replaceData(d: MoneyDB, data: MoneyData) {
  await d.transactions.clear()
  await d.categories.clear()
  await d.paymentMethods.clear()
  const keepKeys = (await d.settings.toCollection().primaryKeys()).filter((k) => !DEVICE_SETTING_KEYS.has(String(k)))
  await d.settings.bulkDelete(keepKeys)
  await d.categories.bulkAdd(data.categories)
  await d.paymentMethods.bulkAdd(data.paymentMethods)
  await d.transactions.bulkAdd(data.transactions)
  const userSettings: Setting[] = data.settings.filter((s) => !DEVICE_SETTING_KEYS.has(s.key))
  if (userSettings.length) await d.settings.bulkPut(userSettings)
}

/**
 * D-40: replace everything with the backup. The current data is saved as the single
 * "before restore" snapshot in the same transaction, so either both happen or neither does.
 */
export async function restoreBackup(backup: BackupFile, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', d.transactions, d.categories, d.paymentMethods, d.settings, async () => {
    const current = await readAllData(d)
    const snapshot: Snapshot = { takenAt: now.toISOString(), data: current }
    await d.settings.put({ key: 'preRestoreSnapshot', value: snapshot })
    await replaceData(d, backup)
  })
}

export async function getSnapshot(d: MoneyDB = db): Promise<Snapshot | null> {
  const row = await d.settings.get('preRestoreSnapshot')
  return (row?.value as Snapshot | undefined) ?? null
}

/** Put back the data from before the last restore, then forget the snapshot. */
export async function undoRestore(d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.transactions, d.categories, d.paymentMethods, d.settings, async () => {
    const row = await d.settings.get('preRestoreSnapshot')
    const snap = row?.value as Snapshot | undefined
    if (!snap) throw new Error('no snapshot')
    await replaceData(d, snap.data)
    await d.settings.delete('preRestoreSnapshot')
  })
}

export async function markBackedUp(d: MoneyDB = db, now = new Date()): Promise<void> {
  const count = await d.transactions.count()
  await d.settings.bulkPut([
    { key: 'lastBackupAt', value: now.toISOString() },
    { key: 'txCountAtLastBackup', value: count },
  ])
}

const DAY = 864e5

/**
 * D-41: remind when the last backup (or install, if never) is over 30 days old and at least
 * 20 transactions were added since; a dismissal hides it for 7 days.
 */
export function shouldRemindBackup(input: {
  now: Date
  lastBackupAt: string | null
  installedAt: string | null
  dismissedAt: string | null
  addedSince: number
}): boolean {
  const base = input.lastBackupAt ?? input.installedAt
  if (!base) return false
  const age = input.now.getTime() - Date.parse(base)
  if (age <= 30 * DAY || input.addedSince < 20) return false
  if (input.dismissedAt && input.now.getTime() - Date.parse(input.dismissedAt) < 7 * DAY) return false
  return true
}

export async function addedSince(iso: string | null, d: MoneyDB = db): Promise<number> {
  if (!iso) return d.transactions.count()
  return d.transactions.filter((t) => t.createdAt > iso).count()
}
