import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from '../db/db'
import { addTransaction } from '../db/repo'
import { addSalaryItem, savePayslip, updateSalaryItem, type PayslipInput } from '../db/salary'
import type { Payslip } from '../db/types'
import { buildBackup, parseBackup, type BackupFile } from './format'
import { previewRange, readAllData, restoreBackup, restoreRange, undoRestore } from './store'

let src: MoneyDB
let cur: MoneyDB
let n = 0
const now = new Date(2026, 9, 20, 9, 0)

beforeEach(async () => {
  src = new MoneyDB(`sb-src-${n}`)
  cur = new MoneyDB(`sb-cur-${n++}`)
  await Promise.all([src.open(), cur.open()])
})
afterEach(() => {
  src.close()
  cur.close()
})

const slip = (month: string, payDate: string, bonus: number): PayslipInput => ({
  month,
  payDate,
  company: '星和科技',
  paymentMethodId: 'transfer',
  lines: [
    { itemId: 'BASE_SALARY', amount: 45000 },
    { itemId: 'BONUS_PERFORMANCE', amount: bonus },
    { itemId: 'LABOR_INSURANCE', amount: 1145 },
  ],
})
async function backupOf(d: MoneyDB): Promise<BackupFile> {
  return parseBackup(JSON.stringify(buildBackup(await readAllData(d), now)))
}
const sortById = <T extends { id: string }>(a: T[]) => [...a].sort((x, y) => x.id.localeCompare(y.id))

describe('salary data in backups (D-74)', () => {
  it('full round trip keeps payslips, items and links identical', async () => {
    const extra = await addSalaryItem({ name: '交通津貼', kind: 'earning', nature: 'fixed' }, src)
    await updateSalaryItem('BONUS_PERFORMANCE', { name: '績效考核獎金' }, src)
    await savePayslip(null, { ...slip('2026-08', '2026-09-05', 2800), lines: [...slip('2026-08', '', 0).lines, { itemId: extra.id, amount: 1200 }] }, src, now)
    await savePayslip(null, slip('2026-09', '2026-10-05', 1500), src, now)
    const before = await readAllData(src)
    await restoreBackup(await backupOf(src), cur, now)
    const after = await readAllData(cur)
    expect(sortById(after.payslips)).toEqual(sortById(before.payslips))
    expect(sortById(after.salaryItems)).toEqual(sortById(before.salaryItems))
    expect(sortById(after.transactions)).toEqual(sortById(before.transactions))
  })

  it('a schema-v1 backup restores with default salary items and no payslips', async () => {
    await addTransaction({ type: 'expense', amount: 100, merchant: '', categoryId: 'food', paymentMethodId: 'card', date: '2026-10-01', note: '' }, src, now)
    const b = JSON.parse(JSON.stringify(buildBackup(await readAllData(src), now)))
    b.schemaVersion = 1
    delete b.salaryItems
    delete b.payslips
    const parsed = parseBackup(JSON.stringify(b))
    expect(parsed.payslips).toEqual([])
    expect(parsed.salaryItems).toHaveLength(13)
    await savePayslip(null, slip('2026-09', '2026-10-05', 1), cur, now)
    await restoreBackup(parsed, cur, now)
    expect(await cur.payslips.count()).toBe(0)
    expect(await cur.salaryItems.count()).toBe(13)
  })

  it('rejects broken salary data', async () => {
    await savePayslip(null, slip('2026-09', '2026-10-05', 1500), src, now)
    const b = JSON.parse(JSON.stringify(buildBackup(await readAllData(src), now)))
    const p0 = b.payslips[0]
    const bad = (patch: object) => () => parseBackup(JSON.stringify({ ...b, payslips: [{ ...p0, ...patch }] }))
    expect(bad({ month: '2026-13' })).toThrow('月份')
    expect(bad({ payDate: '2026-02-31' })).toThrow('發薪日')
    expect(bad({ transactionId: 'missing' })).toThrow('收入紀錄')
    expect(bad({ lines: [{ itemId: 'NOPE', name: 'x', amount: 1 }] })).toThrow('薪資項目')
    expect(bad({ lines: [{ itemId: 'BASE_SALARY', name: 'x', amount: -1 }] })).toThrow('金額')
    expect(() => parseBackup(JSON.stringify({ ...b, payslips: [p0, { ...p0, id: 'other' }] }))).toThrow('兩張薪資單')
    expect(() => parseBackup(JSON.stringify({ ...b, salaryItems: undefined }))).toThrow('不完整')
    const t0 = b.transactions.find((t: { id: string }) => t.id === p0.transactionId)
    const otherMonth = { ...p0, id: 'other', month: '2026-08' }
    expect(() => parseBackup(JSON.stringify({ ...b, payslips: [p0, otherMonth] }))).toThrow('同一筆收入')
    expect(() => parseBackup(JSON.stringify({ ...b, transactions: [{ ...t0, source: 'manual' }] }))).toThrow('不一致')
  })

  it('range restore moves payslips with their income, judged by pay date', async () => {
    // backup: Aug slip paid 9/5, Sep slip paid 10/5
    await savePayslip(null, slip('2026-08', '2026-09-05', 2800), src, now)
    await savePayslip(null, slip('2026-09', '2026-10-05', 1500), src, now)
    const backup = await backupOf(src)
    // current: different Sep slip (edited bonus) and a new Oct slip
    await restoreBackup(backup, cur, now)
    const sep = (await cur.payslips.where('month').equals('2026-09').first())!
    await savePayslip(sep.id, slip('2026-09', '2026-10-05', 9999), cur, now)
    await savePayslip(null, slip('2026-10', '2026-10-20', 3200), cur, now)
    const aug = await cur.payslips.where('month').equals('2026-08').first()

    const p = await previewRange(backup, '2026-10-01', '2026-10-10', cur)
    expect(p).toMatchObject({ payslipsFromBackup: 1, payslipsReplaced: 1, fromBackup: 1, replaced: 1 })
    await restoreRange(backup, '2026-10-01', '2026-10-10', cur, now)

    const sepAfter = (await cur.payslips.where('month').equals('2026-09').first())!
    expect(sepAfter.lines.find((l) => l.itemId === 'BONUS_PERFORMANCE')?.amount).toBe(1500)
    expect((await cur.transactions.get(sepAfter.transactionId!))?.amount).toBe(45000 + 1500 - 1145)
    expect(await cur.payslips.where('month').equals('2026-08').first()).toEqual(aug) // outside the range
    expect(await cur.payslips.where('month').equals('2026-10').count()).toBe(1) // after the range
    // every payslip still points at an existing income, and every payslip income has its payslip
    const slips: Payslip[] = await cur.payslips.toArray()
    for (const s of slips) if (s.transactionId) expect(await cur.transactions.get(s.transactionId)).toBeTruthy()
    const linked = (await cur.transactions.toArray()).filter((t) => t.source === 'payslip')
    expect(linked.map((t) => t.externalId).sort()).toEqual(slips.map((s) => s.id).sort())
  })

  it('range restore replaces a same-month payslip dated elsewhere, and undo puts it back', async () => {
    await savePayslip(null, slip('2026-09', '2026-10-05', 1500), src, now)
    const backup = await backupOf(src)
    // current: an unrelated Sep slip paid on 10/15 (different id)
    await savePayslip(null, slip('2026-09', '2026-10-15', 7777), cur, now)
    const before = await readAllData(cur)
    const p = await previewRange(backup, '2026-10-01', '2026-10-10', cur)
    expect(p).toMatchObject({ payslipsFromBackup: 1, payslipsReplaced: 1 })
    await restoreRange(backup, '2026-10-01', '2026-10-10', cur, now)
    const all = await cur.payslips.toArray()
    expect(all).toHaveLength(1)
    expect(all[0].payDate).toBe('2026-10-05')
    expect(await cur.transactions.count()).toBe(1) // the replaced slip's income went with it
    await undoRestore(cur)
    const back = await readAllData(cur)
    expect(sortById(back.payslips)).toEqual(sortById(before.payslips))
    expect(sortById(back.transactions)).toEqual(sortById(before.transactions))
  })

  it('range restore adds salary items the payslips need', async () => {
    const extra = await addSalaryItem({ name: '交通津貼', kind: 'earning', nature: 'fixed' }, src)
    await savePayslip(null, { ...slip('2026-09', '2026-10-05', 0), lines: [{ itemId: extra.id, amount: 1200 }] }, src, now)
    const backup = await backupOf(src)
    const p = await previewRange(backup, '2026-10-01', '2026-10-31', cur)
    expect(p.newSalaryItems.map((i) => i.name)).toEqual(['交通津貼'])
    await restoreRange(backup, '2026-10-01', '2026-10-31', cur, now)
    expect(await cur.salaryItems.get(extra.id)).toBeTruthy()
  })
})
