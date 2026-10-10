import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from '../db/db'
import { addCategory, addPaymentMethod, addTransaction, updateTransaction, type TxInput } from '../db/repo'
import type { Transaction } from '../db/types'
import { BackupError, buildBackup, parseBackup, type BackupFile } from './format'
import { backupDateSpan, getSnapshot, previewRange, readAllData, restoreRange, undoRestore } from './store'

let src: MoneyDB
let cur: MoneyDB
let n = 0
const now = new Date(2026, 9, 10, 9, 0)
const base: TxInput = { type: 'expense', amount: 100, merchant: '', categoryId: 'food', paymentMethodId: 'card', date: '2026-09-01', note: '' }

beforeEach(async () => {
  src = new MoneyDB(`range-src-${n}`)
  cur = new MoneyDB(`range-cur-${n++}`)
  await Promise.all([src.open(), cur.open()])
})
afterEach(() => {
  src.close()
  cur.close()
})

async function snapshotOf(d: MoneyDB): Promise<BackupFile> {
  return parseBackup(JSON.stringify(buildBackup(await readAllData(d), now)))
}
const byId = (a: Transaction[]) => [...a].sort((x, y) => x.id.localeCompare(y.id))
const at = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString()

describe('restoreRange (D-44)', () => {
  it('replaces only transactions inside [from, to], local time, ends inclusive', async () => {
    // backup: Aug 31 23:50, Sep 1 00:00, Sep 30 23:50, Oct 1 00:00
    const rows: Transaction[] = [at(2026, 8, 31, 23, 50), at(2026, 9, 1, 0), at(2026, 9, 30, 23, 50), at(2026, 10, 1, 0)].map((iso, i) => ({
      id: `b${i}`, type: 'expense', amount: 10 + i, merchant: `B${i}`, categoryId: 'food', paymentMethodId: 'card',
      occurredAt: iso, note: '', source: 'manual', externalId: null, createdAt: iso, updatedAt: iso,
    }))
    await src.transactions.bulkAdd(rows)
    const backup = await snapshotOf(src)

    // current: one inside September, one in August, one in October
    const inSep = await addTransaction({ ...base, date: '2026-09-15', merchant: 'C-sep' }, cur, now)
    const inAug = await addTransaction({ ...base, date: '2026-08-20', merchant: 'C-aug' }, cur, now)
    const inOct = await addTransaction({ ...base, date: '2026-10-02', merchant: 'C-oct' }, cur, now)

    const p = await previewRange(backup, '2026-09-01', '2026-09-30', cur)
    expect(p).toMatchObject({ fromBackup: 2, replaced: 1, movedIn: 0, newCategories: [], newPayments: [] })

    await restoreRange(backup, '2026-09-01', '2026-09-30', cur, now)
    const after = byId(await cur.transactions.toArray())
    expect(after.map((t) => t.id).sort()).toEqual(['b1', 'b2', inAug.id, inOct.id].sort())
    expect(await cur.transactions.get(inSep.id)).toBeUndefined()
    expect(await cur.transactions.get(inAug.id)).toEqual(inAug)
    expect(await cur.transactions.get(inOct.id)).toEqual(inOct)
  })

  it('brings back missing categories and payment methods, leaves existing ones alone (D-46)', async () => {
    const pet = await addCategory({ name: '寵物', type: 'expense', icon: 'pet' }, src)
    const richart = await addPaymentMethod({ name: 'Richart 卡', type: 'credit_card' }, src)
    await addTransaction({ ...base, categoryId: pet.id, paymentMethodId: richart.id, date: '2026-09-05' }, src, now)
    const backup = await snapshotOf(src)

    await cur.categories.update('food', { name: '吃飯' }) // current rename must survive
    const p = await previewRange(backup, '2026-09-01', '2026-09-30', cur)
    expect(p.newCategories.map((c) => c.name)).toEqual(['寵物'])
    expect(p.newPayments.map((x) => x.name)).toEqual(['Richart 卡'])
    await restoreRange(backup, '2026-09-01', '2026-09-30', cur, now)
    expect((await cur.categories.get(pet.id))?.sortOrder).toBe(8)
    expect((await cur.paymentMethods.get(richart.id))?.name).toBe('Richart 卡')
    expect((await cur.categories.get('food'))?.name).toBe('吃飯')
    expect(await cur.categories.count()).toBe(12)
  })

  it('a record moved outside the range comes back as its backup version (D-47)', async () => {
    const t = await addTransaction({ ...base, date: '2026-09-10' }, src, now)
    const backup = await snapshotOf(src)
    await cur.transactions.add(t)
    await updateTransaction(t.id, { ...base, date: '2026-10-03', amount: 999 }, cur, now)
    const p = await previewRange(backup, '2026-09-01', '2026-09-30', cur)
    expect(p).toMatchObject({ fromBackup: 1, replaced: 0, movedIn: 1 })
    await restoreRange(backup, '2026-09-01', '2026-09-30', cur, now)
    expect(await cur.transactions.get(t.id)).toEqual(t)
    expect(await cur.transactions.count()).toBe(1)
  })

  it('keeps a snapshot so the range restore can be undone exactly', async () => {
    await addTransaction({ ...base, date: '2026-09-02', amount: 1 }, src, now)
    const backup = await snapshotOf(src)
    await addTransaction({ ...base, date: '2026-09-03', amount: 2 }, cur, now)
    await addTransaction({ ...base, date: '2026-07-03', amount: 3 }, cur, now)
    const before = await readAllData(cur)
    await restoreRange(backup, '2026-09-01', '2026-09-30', cur, now)
    expect((await getSnapshot(cur))?.data.transactions).toHaveLength(2)
    await undoRestore(cur)
    const after = await readAllData(cur)
    expect(byId(after.transactions)).toEqual(byId(before.transactions))
  })

  it('rejects bad ranges and type conflicts without writing anything', async () => {
    const backup = await snapshotOf(src)
    await addTransaction(base, cur, now)
    const before = await readAllData(cur)
    await expect(previewRange(backup, '2026-09-30', '2026-09-01', cur)).rejects.toThrow('開始日期不能晚於結束日期')
    await expect(restoreRange(backup, '2026-02-31', '2026-03-01', cur, now)).rejects.toThrow(BackupError)

    // same category id, different type in the current data
    const t = await addTransaction({ ...base, date: '2026-09-04' }, src, now)
    const conflict = await snapshotOf(src)
    await cur.categories.update('food', { type: 'income' })
    await expect(restoreRange(conflict, '2026-09-01', '2026-09-30', cur, now)).rejects.toThrow('收支類型不同')
    await cur.categories.update('food', { type: 'expense' })
    expect(byId((await readAllData(cur)).transactions)).toEqual(byId(before.transactions))
    expect(await getSnapshot(cur)).toBeNull()
    expect(t.id).toBeTruthy()
  })

  it('default range spans the earliest and latest backup dates (D-45)', async () => {
    await addTransaction({ ...base, date: '2026-03-14' }, src, now)
    await addTransaction({ ...base, date: '2026-09-02' }, src, now)
    expect(backupDateSpan(await snapshotOf(src))).toEqual(['2026-03-14', '2026-09-02'])
    const empty = await snapshotOf(cur)
    expect(backupDateSpan(empty)).toBeNull()
  })
})
