import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from '../db/db'
import { addPlanTemplate, recordPlannedExpense, setPlanNumbers, startPlan } from '../db/planRepo'
import { addTransaction, type TxInput } from '../db/repo'
import { summarizePlan } from '../lib/plan'
import { BackupError, buildBackup, parseBackup } from './format'
import { readAllData, restoreBackup, restoreRange, undoRestore } from './store'

let a: MoneyDB
let b: MoneyDB
let n = 0
const now = new Date(2026, 9, 11, 16, 12)
beforeEach(async () => {
  a = new MoneyDB(`pb-a-${n}`)
  b = new MoneyDB(`pb-b-${n++}`)
  await Promise.all([a.open(), b.open()])
})
afterEach(() => {
  a.close()
  b.close()
})

const spend = (p: Partial<TxInput>): TxInput => ({ type: 'expense', amount: 100, merchant: '', categoryId: 'home', paymentMethodId: 'transfer', date: '2026-10-05', time: '09:00', note: '', ...p })

async function seedPlan(d: MoneyDB) {
  await addPlanTemplate({ name: '房租', amount: 15000, day: 5, categoryId: 'home', paymentMethodId: 'transfer' }, '2026-10', d, now)
  await addPlanTemplate({ name: '電話費', amount: 1000, day: 10, categoryId: 'home', paymentMethodId: 'card' }, '2026-10', d, now)
  await startPlan('2026-10', d, now)
  await setPlanNumbers('2026-10', { income: 55000, saving: 12000 }, d, now)
  const rent = (await d.plannedExpenses.toArray()).find((x) => x.name === '房租')!
  return recordPlannedExpense(rent.id, spend({ amount: 15000 }), d, now)
}

async function summary(d: MoneyDB) {
  const plan = (await d.monthlyPlans.get('2026-10')) ?? null
  const items = await d.plannedExpenses.where('month').equals('2026-10').toArray()
  const tx = await d.transactions.toArray()
  return summarizePlan('2026-10', plan, items, tx, new Map(tx.map((t) => [t.id, t])))
}

describe('planning in backups (D-114)', () => {
  it('a full backup restores plans, templates, items and their links', async () => {
    await seedPlan(a)
    const file = parseBackup(JSON.stringify(buildBackup(await readAllData(a), now)))
    expect(file.schemaVersion).toBe(8)
    await restoreBackup(file, b, now)
    const s = await summary(b)
    expect([s.income, s.saving, s.necessary, s.recorded, s.spendable]).toEqual([55000, 12000, 16000, 15000, 55000 - 16000 - 0 - 12000])
    expect(await b.planTemplates.count()).toBe(2)
  })
  it('undo after a restore brings the plans back too', async () => {
    await seedPlan(b)
    const empty = parseBackup(JSON.stringify(buildBackup(await readAllData(a), now)))
    await restoreBackup(empty, b, now)
    expect(await b.monthlyPlans.count()).toBe(0)
    await undoRestore(b)
    expect(await b.monthlyPlans.count()).toBe(1)
    expect(await b.plannedExpenses.count()).toBe(2)
  })
  it('older backups (schema 3) restore with no plans', async () => {
    await seedPlan(a)
    const raw = JSON.parse(JSON.stringify(buildBackup(await readAllData(a), now)))
    raw.schemaVersion = 3
    delete raw.monthlyPlans
    delete raw.planTemplates
    delete raw.plannedExpenses
    const file = parseBackup(JSON.stringify(raw))
    expect([file.monthlyPlans, file.planTemplates, file.plannedExpenses]).toEqual([[], [], []])
  })
  it('rejects broken planning data before anything is written', async () => {
    await seedPlan(a)
    const snapshot = await readAllData(a)
    const raw = () => JSON.parse(JSON.stringify(buildBackup(snapshot, now)))
    const bad1 = raw()
    bad1.plannedExpenses[0].templateId = 'nope'
    expect(() => parseBackup(JSON.stringify(bad1))).toThrow(BackupError)
    const bad2 = raw()
    bad2.monthlyPlans[0].income = -1
    expect(() => parseBackup(JSON.stringify(bad2))).toThrow('金額不正確')
    const bad3 = raw()
    bad3.plannedExpenses.push({ ...bad3.plannedExpenses[0], id: 'dup' })
    expect(() => parseBackup(JSON.stringify(bad3))).toThrow('同月份的固定項目')
    const bad4 = raw()
    bad4.planTemplates[0].categoryId = 'salary'
    expect(() => parseBackup(JSON.stringify(bad4))).toThrow('分類不存在')
  })
  it('a range restore keeps every plan; a replaced linked record shows as not recorded (D-108)', async () => {
    const t = await seedPlan(b)
    await addTransaction(spend({ amount: 300, categoryId: 'food', date: '2026-10-06' }), b, now)
    const before = await summary(b)
    expect(before.recorded).toBe(15000)
    // A backup without October's records replaces 10/01–10/31.
    const empty = parseBackup(JSON.stringify(buildBackup(await readAllData(a), now)))
    await restoreRange(empty, '2026-10-01', '2026-10-31', b, now)
    expect(await b.transactions.get(t.id)).toBeUndefined()
    expect(await b.monthlyPlans.count()).toBe(1)
    expect(await b.plannedExpenses.count()).toBe(2)
    const after = await summary(b)
    const rent = after.items.find((v) => v.item.name === '房租')!
    expect([rent.state, rent.broken]).toEqual(['pending', { kind: 'deleted' }])
    expect(after.recorded).toBe(0)
    expect(after.otherSpending).toBe(0)
  })
})
