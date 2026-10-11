import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from '../db/db'
import { addCategory, addTransaction, setSetting, type TxInput } from '../db/repo'
import { BackupError, buildBackup, CSV_HEADER, parseBackup, toCsv } from './format'
import { addedSince, getSnapshot, markBackedUp, readAllData, restoreBackup, shouldRemindBackup, undoRestore } from './store'

let d: MoneyDB
let n = 0
const now = new Date(2026, 9, 10, 9, 15)
const base: TxInput = { type: 'expense', amount: 185, merchant: '全家', categoryId: 'food', paymentMethodId: 'card', date: '2026-10-10', note: '' }

beforeEach(async () => {
  d = new MoneyDB(`backup-test-${n++}`)
  await d.open()
})
afterEach(() => d.close())

async function seed(db: MoneyDB) {
  await addTransaction(base, db, now)
  await addTransaction({ ...base, amount: 52000, type: 'income', categoryId: 'salary', paymentMethodId: 'transfer', date: '2026-10-05', merchant: '公司', note: '十月' }, db, now)
  const pet = await addCategory({ name: '寵物', type: 'expense', icon: 'pet' }, db)
  await addTransaction({ ...base, amount: 420, categoryId: pet.id, merchant: '飼料, "大包"', date: '2026-10-01' }, db, now)
}

function stripDevice(data: Awaited<ReturnType<typeof readAllData>>) {
  const by = <T extends { id: string }>(a: T[]) => [...a].sort((x, y) => x.id.localeCompare(y.id))
  return { ...data, transactions: by(data.transactions), categories: by(data.categories), paymentMethods: by(data.paymentMethods) }
}

describe('backup round trip', () => {
  it('export → JSON text → parse → restore on another device gives identical data', async () => {
    await seed(d)
    const before = await readAllData(d)
    const text = JSON.stringify(buildBackup(before, now))
    const parsed = parseBackup(text) // real JSON parse + validation (L-030)

    const other = new MoneyDB(`backup-target-${n++}`)
    await other.open()
    await addTransaction({ ...base, amount: 999 }, other, now) // existing data on the target is replaced
    await restoreBackup(parsed, other, now)
    expect(stripDevice(await readAllData(other))).toEqual(stripDevice(before))
    other.close()
  })

  it('never exports device settings', async () => {
    await markBackedUp(d, now)
    const b = buildBackup(await readAllData(d), now)
    expect(b.settings.map((s) => s.key)).not.toContain('lastBackupAt')
    expect(b.settings.map((s) => s.key)).not.toContain('installedAt')
  })
})

describe('restore safety (D-40)', () => {
  it('keeps one snapshot and can undo the restore exactly', async () => {
    await seed(d)
    const before = await readAllData(d)
    const empty = buildBackup({ ...before, transactions: [] }, now)
    await restoreBackup(parseBackup(JSON.stringify(empty)), d, now)
    expect(await d.transactions.count()).toBe(0)
    const snap = await getSnapshot(d)
    expect(snap?.data.transactions).toHaveLength(3)
    await undoRestore(d)
    expect(stripDevice(await readAllData(d))).toEqual(stripDevice(before))
    expect(await getSnapshot(d)).toBeNull()
  })

  it('a second restore replaces the snapshot instead of keeping two', async () => {
    await seed(d)
    const b = parseBackup(JSON.stringify(buildBackup(await readAllData(d), now)))
    await restoreBackup(b, d, now)
    await restoreBackup(b, d, new Date(2026, 9, 11))
    const rows = await d.settings.where('key').equals('preRestoreSnapshot').count()
    expect(rows).toBe(1)
    expect((await getSnapshot(d))?.takenAt).toBe(new Date(2026, 9, 11).toISOString())
  })

  it('restore keeps device settings such as last backup time', async () => {
    await seed(d)
    await markBackedUp(d, now)
    const b = parseBackup(JSON.stringify(buildBackup(await readAllData(d), now)))
    await restoreBackup(b, d, now)
    expect((await d.settings.get('lastBackupAt'))?.value).toBe(now.toISOString())
    expect((await d.settings.get('installedAt'))?.value).toBeTruthy()
  })
})

describe('parseBackup rejects bad files before anything is written', () => {
  const good = () =>
    JSON.parse(
      JSON.stringify(
        buildBackup(
          { transactions: [], categories: [], paymentMethods: [], settings: [], salaryItems: [], payslips: [], importedNotifications: [], importBatches: [], cardStatements: [], statementEntries: [], reconciliations: [], monthlyPlans: [], planTemplates: [], plannedExpenses: [] },
          now,
        ),
      ),
    )
  async function validBackup() {
    await seed(d)
    return JSON.parse(JSON.stringify(buildBackup(await readAllData(d), now)))
  }
  const bad = (o: unknown) => () => parseBackup(JSON.stringify(o))

  it('rejects non-JSON and foreign files', () => {
    expect(() => parseBackup('not json')).toThrow(BackupError)
    expect(bad({ hello: 1 })).toThrow('不是 Money 的備份檔')
    expect(bad({ ...good(), format: 2 })).toThrow('版本')
    expect(bad({ ...good(), schemaVersion: 99 })).toThrow('版本')
  })

  it('rejects broken transactions with the row number', async () => {
    const b = await validBackup()
    const t0 = b.transactions[0]
    expect(bad({ ...b, transactions: [{ ...t0, amount: 12.5 }] })).toThrow('第 1 筆交易的金額')
    expect(bad({ ...b, transactions: [{ ...t0, amount: '185' }] })).toThrow('金額')
    expect(bad({ ...b, transactions: [{ ...t0, categoryId: 'nope' }] })).toThrow('分類不存在')
    expect(bad({ ...b, transactions: [{ ...t0, categoryId: 'salary' }] })).toThrow('分類不存在')
    expect(bad({ ...b, transactions: [{ ...t0, occurredAt: 'yesterday' }] })).toThrow('時間')
    expect(bad({ ...b, transactions: [{ ...t0, occurredAt: '2026-02-31T00:00:00.000Z' }] })).toThrow('時間')
    expect(bad({ ...b, transactions: [t0, t0] })).toThrow('重複')
  })

  it('rejects files that would leave no usable category or payment method (D-15)', async () => {
    const b = await validBackup()
    const cats = b.categories.map((c: { type: string }) => (c.type === 'income' ? { ...c, isActive: false } : c))
    expect(bad({ ...b, categories: cats, transactions: [] })).toThrow('收入分類')
    const pays = b.paymentMethods.map((p: object) => ({ ...p, isActive: false }))
    expect(bad({ ...b, paymentMethods: pays })).toThrow('付款方式')
  })

  it('accepts a BOM and drops device settings found in the file', async () => {
    const b = await validBackup()
    b.settings.push({ key: 'lastBackupAt', value: 'x' })
    const parsed = parseBackup('﻿' + JSON.stringify(b))
    expect(parsed.settings.map((s) => s.key)).not.toContain('lastBackupAt')
  })
})

describe('CSV export (D-42)', () => {
  /** Minimal RFC 4180 parser, used to prove the file parses back to the same fields. */
  function parseCsv(text: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let cell = ''
    let q = false
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (q) {
        if (ch === '"' && text[i + 1] === '"') {
          cell += '"'
          i++
        } else if (ch === '"') q = false
        else cell += ch
      } else if (ch === '"') q = true
      else if (ch === ',') {
        row.push(cell)
        cell = ''
      } else if (ch === '\r' && text[i + 1] === '\n') {
        row.push(cell)
        rows.push(row)
        row = []
        cell = ''
        i++
      } else cell += ch
    }
    return rows
  }

  it('has a BOM, the agreed columns, positive amounts and safe quoting', async () => {
    await seed(d)
    await addTransaction({ ...base, merchant: '=SUM(A1)', note: '多行\n備註', date: '2026-10-02' }, d, now)
    const data = await readAllData(d)
    const names = { category: (id: string) => data.categories.find((c) => c.id === id)?.name ?? '', payment: (id: string) => data.paymentMethods.find((p) => p.id === id)?.name ?? '' }
    const csv = toCsv(data.transactions, names)
    expect(csv.startsWith('﻿')).toBe(true)
    const rows = parseCsv(csv.slice(1))
    expect(rows[0]).toEqual(CSV_HEADER)
    expect(rows).toHaveLength(1 + 4)
    const pet = rows.find((r) => r[4] === '寵物')!
    expect(pet).toEqual(['2026-10-01', '12:00', '支出', '420', '寵物', '信用卡', '飼料, "大包"', ''])
    const income = rows.find((r) => r[2] === '收入')!
    expect(income[3]).toBe('52000')
    const formula = rows.find((r) => r[6].includes('SUM'))!
    expect(formula[6]).toBe("'=SUM(A1)")
    expect(formula[7]).toBe('多行\n備註')
    // oldest first
    expect(rows.slice(1).map((r) => r[0])).toEqual([...rows.slice(1).map((r) => r[0])].sort())
  })
})

describe('backup reminder (D-102)', () => {
  const day = 864e5
  const t = (daysAgo: number) => new Date(now.getTime() - daysAgo * day).toISOString()
  it('reminds after more than 30 days, whatever the number of new records', () => {
    // D-102: over 30 days is enough, however few records were added.
    expect(shouldRemindBackup({ now, lastBackupAt: t(31), installedAt: t(90), dismissedAt: null })).toBe(true)
    expect(shouldRemindBackup({ now, lastBackupAt: t(30), installedAt: t(90), dismissedAt: null })).toBe(false)
    expect(shouldRemindBackup({ now, lastBackupAt: t(29), installedAt: t(90), dismissedAt: null })).toBe(false)
    expect(shouldRemindBackup({ now, lastBackupAt: null, installedAt: t(31), dismissedAt: null })).toBe(true)
    expect(shouldRemindBackup({ now, lastBackupAt: null, installedAt: t(20), dismissedAt: null })).toBe(false)
  })
  it('a dismissal hides it for 7 days', () => {
    expect(shouldRemindBackup({ now, lastBackupAt: t(40), installedAt: t(90), dismissedAt: t(6) })).toBe(false)
    expect(shouldRemindBackup({ now, lastBackupAt: t(40), installedAt: t(90), dismissedAt: t(8) })).toBe(true)
  })
  it('counts entries created after the last backup', async () => {
    await addTransaction({ ...base, date: '2026-10-01' }, d, new Date(2026, 9, 1, 8))
    await setSetting('x', 1, d)
    const cut = new Date(2026, 9, 5).toISOString()
    await addTransaction(base, d, new Date(2026, 9, 10, 10))
    expect(await addedSince(cut, d)).toBe(1)
    expect(await addedSince(null, d)).toBe(2)
  })
})
