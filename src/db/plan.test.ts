import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from './db'
import { addTransaction, deleteTransaction, MoneyError, updateTransaction, type TxInput } from './repo'
import {
  addOneOffExpense,
  addPlanTemplate,
  editPlannedExpense,
  linkPlannedExpense,
  recordPlannedExpense,
  setPlanNumbers,
  setPlanTemplateActive,
  skipPlannedExpense,
  startPlan,
  unlinkPlannedExpense,
  unskipPlannedExpense,
  updatePlanTemplate,
  type PlanItemInput,
} from './planRepo'
import { linkCandidates, summarizePlan } from '../lib/plan'

let d: MoneyDB
let n = 0
const now = new Date(2026, 9, 11, 16, 12)
beforeEach(async () => {
  d = new MoneyDB(`plan-${n++}`)
  await d.open()
})
afterEach(() => d.close())

const rent: PlanItemInput = { name: '房租', amount: 15000, day: 5, categoryId: 'home', paymentMethodId: 'transfer' }
const power: PlanItemInput = { name: '水電費', amount: 2000, day: 8, categoryId: 'home', paymentMethodId: 'transfer' }
const phone: PlanItemInput = { name: '電話費', amount: 1000, day: 10, categoryId: 'home', paymentMethodId: 'card' }
const spend = (p: Partial<TxInput>): TxInput => ({ type: 'expense', amount: 100, merchant: '', categoryId: 'food', paymentMethodId: 'card', date: '2026-10-03', time: '12:00', note: '', ...p })

async function summary(month = '2026-10') {
  const plan = (await d.monthlyPlans.get(month)) ?? null
  const items = await d.plannedExpenses.where('month').equals(month).toArray()
  const [y, m] = month.split('-').map(Number)
  const monthTx = (await d.transactions.toArray()).filter((t) => {
    const x = new Date(t.occurredAt)
    return x.getFullYear() === y && x.getMonth() === m - 1
  })
  const ids = items.map((i) => i.transactionId).filter((x): x is string => !!x)
  const linked = new Map((await d.transactions.bulkGet(ids)).filter((t) => !!t).map((t) => [t!.id, t!]))
  return summarizePlan(month, plan, items, monthTx, linked)
}

async function setupOctober() {
  await addPlanTemplate(rent, '2026-10', d, now)
  await addPlanTemplate(power, '2026-10', d, now)
  await addPlanTemplate(phone, '2026-10', d, now)
  await startPlan('2026-10', d, now)
  await setPlanNumbers('2026-10', { income: 55000, saving: 12000 }, d, now)
}

describe('starting a month (D-106)', () => {
  it('creates one item per active template, once', async () => {
    await setupOctober()
    await startPlan('2026-10', d, now)
    expect(await d.plannedExpenses.where('month').equals('2026-10').count()).toBe(3)
  })
  it('copies income and saving goal from the latest earlier plan; nothing is recorded', async () => {
    await setupOctober()
    const nov = await startPlan('2026-11', d, now)
    expect([nov.income, nov.saving]).toEqual([55000, 12000])
    expect(await d.transactions.count()).toBe(0)
  })
  it('no income set yet → no spendable figure (D-110)', async () => {
    await startPlan('2026-10', d, now)
    const s = await summary()
    expect([s.income, s.keep, s.spendable]).toEqual([null, null, null])
  })
})

describe('the numbers (D-112)', () => {
  it('pending uses the estimate, recorded uses the real amount, skipped counts 0; C excludes linked spending', async () => {
    await setupOctober()
    const items = await d.plannedExpenses.toArray()
    const byName = (s: string) => items.find((i) => i.name === s)!
    await recordPlannedExpense(byName('房租').id, spend({ amount: 15000, categoryId: 'home', paymentMethodId: 'transfer', date: '2026-10-05' }), d, now)
    await recordPlannedExpense(byName('水電費').id, spend({ amount: 2350, categoryId: 'home', paymentMethodId: 'transfer', date: '2026-10-08' }), d, now)
    await addTransaction(spend({ amount: 6000 }), d, now)
    const s = await summary()
    expect(s.necessary).toBe(15000 + 2350 + 1000)
    expect(s.otherSpending).toBe(6000)
    expect(s.keep).toBe(55000 - 18350 - 6000)
    expect(s.spendable).toBe(55000 - 18350 - 6000 - 12000)
    expect(s.recorded).toBe(17350)
    expect(s.pendingCount).toBe(1)
    expect(s.items.find((v) => v.item.name === '水電費')?.diff).toBe(350)
    await skipPlannedExpense(byName('電話費').id, d, now)
    expect((await summary()).necessary).toBe(17350)
  })
  it('the spec example: 55,000 − 22,000 − 6,000 − 12,000 = 15,000, and negative values stay negative', async () => {
    await addPlanTemplate({ ...rent, amount: 22000 }, '2026-10', d, now)
    await startPlan('2026-10', d, now)
    await setPlanNumbers('2026-10', { income: 55000, saving: 12000 }, d, now)
    await addTransaction(spend({ amount: 6000 }), d, now)
    expect((await summary()).spendable).toBe(15000)
    await addTransaction(spend({ amount: 17000 }), d, now)
    expect((await summary()).spendable).toBe(-2000)
  })
  it('actual income is shown beside the estimate, never added to it', async () => {
    await setupOctober()
    await addTransaction({ ...spend({ amount: 53000, categoryId: 'salary', paymentMethodId: 'transfer' }), type: 'income' }, d, now)
    const s = await summary()
    expect([s.income, s.actualIncome]).toEqual([55000, 53000])
    expect(s.keep).toBe(55000 - 18000 - 0)
  })
})

describe('recording and linking (D-108, D-109)', () => {
  it('recording adds exactly one transaction and links it', async () => {
    await setupOctober()
    const x = (await d.plannedExpenses.toArray()).find((i) => i.name === '電話費')!
    const t = await recordPlannedExpense(x.id, spend({ amount: 1000, categoryId: 'home' }), d, now)
    expect(await d.transactions.count()).toBe(1)
    expect((await d.plannedExpenses.get(x.id))?.transactionId).toBe(t.id)
    await expect(recordPlannedExpense(x.id, spend({ amount: 1000 }), d, now)).rejects.toThrow('這筆已經記過了')
    expect(await d.transactions.count()).toBe(1)
  })
  it('a date outside the item’s month is refused and nothing is written', async () => {
    await setupOctober()
    const x = (await d.plannedExpenses.toArray())[0]
    await expect(recordPlannedExpense(x.id, spend({ date: '2026-09-30' }), d, now)).rejects.toThrow('日期要在 10 月內')
    expect(await d.transactions.count()).toBe(0)
  })
  it('one transaction can back only one planned expense of its month (Q73)', async () => {
    await setupOctober()
    const [a, b] = await d.plannedExpenses.toArray()
    const t = await addTransaction(spend({ amount: 15000, categoryId: 'home' }), d, now)
    await linkPlannedExpense(a.id, t.id, d, now)
    await expect(linkPlannedExpense(b.id, t.id, d, now)).rejects.toBeInstanceOf(MoneyError)
  })
  it('only expenses of the same month can be linked', async () => {
    await setupOctober()
    const x = (await d.plannedExpenses.toArray())[0]
    const sep = await addTransaction(spend({ date: '2026-09-28' }), d, now)
    const inc = await addTransaction({ ...spend({ categoryId: 'salary' }), type: 'income' }, d, now)
    await expect(linkPlannedExpense(x.id, sep.id, d, now)).rejects.toThrow('同一個月')
    await expect(linkPlannedExpense(x.id, inc.id, d, now)).rejects.toThrow('只能對應支出')
  })
  it('deleting or moving the linked transaction makes the item pending again, counted once (D-108)', async () => {
    await setupOctober()
    const x = (await d.plannedExpenses.toArray()).find((i) => i.name === '電話費')!
    const t = await recordPlannedExpense(x.id, spend({ amount: 1200, categoryId: 'home' }), d, now)
    let v = (await summary()).items.find((i) => i.item.id === x.id)!
    expect(v.state).toBe('linked')
    await updateTransaction(t.id, spend({ amount: 1200, categoryId: 'home', date: '2026-09-30' }), d, now)
    let s = await summary()
    v = s.items.find((i) => i.item.id === x.id)!
    expect([v.state, v.broken]).toEqual(['pending', { kind: 'moved', month: '2026-09' }])
    expect(s.necessary).toBe(15000 + 2000 + 1000)
    expect(s.otherSpending).toBe(0) // moved to September: not October spending
    await updateTransaction(t.id, spend({ amount: 1200, categoryId: 'home', date: '2026-10-09' }), d, now)
    expect((await summary()).items.find((i) => i.item.id === x.id)!.state).toBe('linked')
    await deleteTransaction(t.id, d)
    s = await summary()
    v = s.items.find((i) => i.item.id === x.id)!
    expect([v.state, v.broken]).toEqual(['pending', { kind: 'deleted' }])
  })
  it('editing the linked amount updates the plan; unlinking keeps the transaction', async () => {
    await setupOctober()
    const x = (await d.plannedExpenses.toArray()).find((i) => i.name === '水電費')!
    const t = await recordPlannedExpense(x.id, spend({ amount: 2000, categoryId: 'home' }), d, now)
    await updateTransaction(t.id, spend({ amount: 2600, categoryId: 'home' }), d, now)
    expect((await summary()).necessary).toBe(15000 + 2600 + 1000)
    await unlinkPlannedExpense(x.id, d, now)
    expect(await d.transactions.get(t.id)).toBeTruthy()
    const s = await summary()
    expect(s.necessary).toBe(18000)
    expect(s.otherSpending).toBe(2600)
  })
  it('a linked item cannot be skipped; skip and unskip otherwise', async () => {
    await setupOctober()
    const [a, b] = await d.plannedExpenses.toArray()
    const t = await addTransaction(spend({ amount: a.amount, categoryId: a.categoryId }), d, now)
    await linkPlannedExpense(a.id, t.id, d, now)
    await expect(skipPlannedExpense(a.id, d, now)).rejects.toThrow('先取消對應')
    await skipPlannedExpense(b.id, d, now)
    expect((await d.plannedExpenses.get(b.id))?.status).toBe('skipped')
    await unskipPlannedExpense(b.id, d, now)
    expect((await d.plannedExpenses.get(b.id))?.status).toBe('pending')
  })
  it('suggests a single clear candidate only', async () => {
    await setupOctober()
    const x = (await d.plannedExpenses.toArray()).find((i) => i.name === '房租')!
    const a = await addTransaction(spend({ amount: 15000, categoryId: 'home', paymentMethodId: 'transfer', merchant: '房東' }), d, now)
    await addTransaction(spend({ amount: 85 }), d, now)
    const tx = await d.transactions.toArray()
    expect(linkCandidates(x, tx, new Set()).best?.id).toBe(a.id)
    await addTransaction(spend({ amount: 15000, categoryId: 'home', paymentMethodId: 'transfer', merchant: '管理費' }), d, now)
    expect(linkCandidates(x, await d.transactions.toArray(), new Set()).best).toBeNull()
  })
})

describe('templates and month independence (D-107)', () => {
  it('a template change updates this and later untouched months, never edited, recorded, skipped or past ones', async () => {
    await setupOctober()
    await startPlan('2026-09', d, now) // a past month planned late
    await startPlan('2026-11', d, now)
    const tpl = (await d.planTemplates.toArray()).find((t) => t.name === '水電費')!
    const oct = (await d.plannedExpenses.toArray()).find((i) => i.month === '2026-10' && i.templateId === tpl.id)!
    await editPlannedExpense(oct.id, { ...power, amount: 2000 }, d, now) // Oct edited by hand (same values)
    await updatePlanTemplate(tpl.id, { ...power, amount: 2600 }, d, now)
    const all = (await d.plannedExpenses.toArray()).filter((i) => i.templateId === tpl.id)
    const amt = (m: string) => all.find((i) => i.month === m)!.amount
    expect([amt('2026-09'), amt('2026-10'), amt('2026-11')]).toEqual([2000, 2000, 2600])
  })
  it('changing November does not touch October', async () => {
    await setupOctober()
    await startPlan('2026-11', d, now)
    const nov = (await d.plannedExpenses.toArray()).find((i) => i.month === '2026-11' && i.name === '水電費')!
    await editPlannedExpense(nov.id, { ...power, amount: 2600 }, d, now)
    const oct = (await d.plannedExpenses.toArray()).find((i) => i.month === '2026-10' && i.name === '水電費')!
    expect(oct.amount).toBe(2000)
  })
  it('stopping a template removes only untouched current/future items; starting again adds them back once', async () => {
    await setupOctober()
    await startPlan('2026-11', d, now)
    const tpl = (await d.planTemplates.toArray()).find((t) => t.name === '電話費')!
    const oct = (await d.plannedExpenses.toArray()).find((i) => i.month === '2026-10' && i.templateId === tpl.id)!
    const t = await recordPlannedExpense(oct.id, spend({ amount: 1000, categoryId: 'home' }), d, now)
    await setPlanTemplateActive(tpl.id, false, d, now)
    let items = (await d.plannedExpenses.toArray()).filter((i) => i.templateId === tpl.id)
    expect(items.map((i) => i.month)).toEqual(['2026-10']) // recorded one kept
    expect(await d.transactions.get(t.id)).toBeTruthy()
    await startPlan('2026-12', d, now)
    expect((await d.plannedExpenses.toArray()).filter((i) => i.month === '2026-12' && i.templateId === tpl.id)).toHaveLength(0)
    await setPlanTemplateActive(tpl.id, true, d, now)
    await setPlanTemplateActive(tpl.id, true, d, now)
    items = (await d.plannedExpenses.toArray()).filter((i) => i.templateId === tpl.id)
    expect(items.map((i) => i.month).sort()).toEqual(['2026-10', '2026-11', '2026-12'])
  })
  it('one-off items belong to one month; validation', async () => {
    await setupOctober()
    await addOneOffExpense('2026-10', { name: '牙醫', amount: 800, day: 31, categoryId: 'medical', paymentMethodId: 'cash' }, d, now)
    expect((await summary()).necessary).toBe(18000 + 800)
    await expect(addOneOffExpense('2026-10', { ...rent, name: ' ' }, d, now)).rejects.toThrow('請輸入名稱')
    await expect(addOneOffExpense('2026-10', { ...rent, day: 32 }, d, now)).rejects.toThrow('每月日期')
    await expect(addOneOffExpense('2026-10', { ...rent, categoryId: 'salary' }, d, now)).rejects.toThrow('支出分類')
    await expect(addOneOffExpense('2026-12', rent, d, now)).rejects.toThrow('還沒開始規劃')
  })
  it('a 31st in a 30-day month falls on the last day (D-111)', async () => {
    await addPlanTemplate({ ...rent, day: 31 }, '2026-11', d, now)
    await startPlan('2026-11', d, now)
    expect((await summary('2026-11')).items[0].dueDay).toBe(30)
  })
})
