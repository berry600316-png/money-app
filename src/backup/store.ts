import { db, type MoneyDB } from '../db/db'
import type { Category, PaymentMethod, Setting } from '../db/types'
import { fromYmd, toYmd } from '../lib/dates'
import { BackupError, DEVICE_SETTING_KEYS, type BackupFile, type MoneyData } from './format'

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

/* ---------------- restore a date range (D-44..D-47) ---------------- */

export interface RangePreview {
  /** Backup transactions dated inside the range. */
  fromBackup: number
  /** Current transactions dated inside the range that will be replaced. */
  replaced: number
  /** Current transactions dated outside the range whose backup version (same id) is inside it. */
  movedIn: number
  newCategories: Category[]
  newPayments: PaymentMethod[]
}

/** Local-midnight bounds of [from, to] inclusive, as ISO strings for comparison with occurredAt. */
export function rangeBounds(from: string, to: string): [string, string] {
  const start = fromYmd(from)
  const end = fromYmd(to)
  end.setDate(end.getDate() + 1)
  return [start.toISOString(), end.toISOString()]
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

async function planRange(backup: BackupFile, from: string, to: string, d: MoneyDB) {
  if (!YMD.test(from) || !YMD.test(to) || toYmd(fromYmd(from)) !== from || toYmd(fromYmd(to)) !== to) {
    throw new BackupError('請選擇正確的日期')
  }
  if (from > to) throw new BackupError('開始日期不能晚於結束日期')
  const [start, end] = rangeBounds(from, to)
  const inRange = (iso: string) => iso >= start && iso < end
  const incoming = backup.transactions.filter((t) => inRange(t.occurredAt))
  const current = await d.transactions.where('occurredAt').between(start, end, true, false).toArray()
  const currentIds = new Set(current.map((t) => t.id))
  const outside = await d.transactions.bulkGet(incoming.map((t) => t.id).filter((id) => !currentIds.has(id)))
  const movedIn = outside.filter(Boolean).length

  const [cats, pays] = await Promise.all([d.categories.toArray(), d.paymentMethods.toArray()])
  const catById = new Map(cats.map((c) => [c.id, c]))
  const payIds = new Set(pays.map((p) => p.id))
  const bCat = new Map(backup.categories.map((c) => [c.id, c]))
  const bPay = new Map(backup.paymentMethods.map((p) => [p.id, p]))
  const newCategories: Category[] = []
  const newPayments: PaymentMethod[] = []
  const nextOrder = { expense: maxOrder(cats, 'expense'), income: maxOrder(cats, 'income') }
  let nextPayOrder = pays.reduce((m, p) => Math.max(m, p.sortOrder), -1)
  for (const t of incoming) {
    const existing = catById.get(t.categoryId)
    if (existing && existing.type !== t.type) {
      throw new BackupError(`分類「${existing.name}」在備份和目前的收支類型不同，無法還原這段期間`)
    }
    if (!existing && !newCategories.some((c) => c.id === t.categoryId)) {
      const c = bCat.get(t.categoryId)! // parseBackup guarantees every transaction's category exists in the file
      newCategories.push({ ...c, sortOrder: ++nextOrder[c.type] })
    }
    if (!payIds.has(t.paymentMethodId) && !newPayments.some((p) => p.id === t.paymentMethodId)) {
      newPayments.push({ ...bPay.get(t.paymentMethodId)!, sortOrder: ++nextPayOrder })
    }
  }
  return { start, end, incoming, current, preview: { fromBackup: incoming.length, replaced: current.length, movedIn, newCategories, newPayments } }
}

function maxOrder(cats: Category[], type: Category['type']) {
  return cats.filter((c) => c.type === type).reduce((m, c) => Math.max(m, c.sortOrder), -1)
}

/** What a range restore would do; writes nothing. Throws BackupError with a user-facing message. */
export async function previewRange(backup: BackupFile, from: string, to: string, d: MoneyDB = db): Promise<RangePreview> {
  return (await planRange(backup, from, to, d)).preview
}

/** D-44: replace only the transactions dated within [from, to]; snapshot first, all in one transaction. */
export async function restoreRange(backup: BackupFile, from: string, to: string, d: MoneyDB = db, now = new Date()): Promise<RangePreview> {
  return d.transaction('rw', d.transactions, d.categories, d.paymentMethods, d.settings, async () => {
    const plan = await planRange(backup, from, to, d)
    const snapshot: Snapshot = { takenAt: now.toISOString(), data: await readAllData(d) }
    await d.settings.put({ key: 'preRestoreSnapshot', value: snapshot })
    await d.transactions.bulkDelete(plan.current.map((t) => t.id))
    if (plan.preview.newCategories.length) await d.categories.bulkAdd(plan.preview.newCategories)
    if (plan.preview.newPayments.length) await d.paymentMethods.bulkAdd(plan.preview.newPayments)
    // bulkPut: a record the user later moved outside the range comes back as its backup version (D-47).
    await d.transactions.bulkPut(plan.incoming)
    return plan.preview
  })
}

/** Earliest and latest local dates in a backup, for the default range (D-45). */
export function backupDateSpan(backup: BackupFile): [string, string] | null {
  if (!backup.transactions.length) return null
  let min = backup.transactions[0].occurredAt
  let max = min
  for (const t of backup.transactions) {
    if (t.occurredAt < min) min = t.occurredAt
    if (t.occurredAt > max) max = t.occurredAt
  }
  return [toYmd(new Date(min)), toYmd(new Date(max))]
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
