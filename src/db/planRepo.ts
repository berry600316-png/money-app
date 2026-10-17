/*
 * Monthly planning writes (D-105..D-111). Each function is one IndexedDB transaction. Plans never create,
 * change or delete a transaction, except recordPlannedExpense, which adds the user's own entry and links
 * it in the same transaction (D-109).
 */
import { db, type MoneyDB } from './db'
import { addTransaction, MoneyError, type TxInput } from './repo'
import type { MonthlyPlan, PlannedExpense, PlanTemplate, Transaction } from './types'
import type { DeleteImpact } from './deletion'
import { isValidAmount, MAX_AMOUNT } from '../lib/money'
import { currentMonthKey } from '../lib/months'
import { monthOfIso } from '../lib/plan'

export const PLAN_NAME_MAX = 20

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
const isMoney0 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_AMOUNT

export interface PlanItemInput {
  name: string
  amount: number
  /** 1–31; later than the month's last day means that last day (D-111). */
  day: number
  categoryId: string
  paymentMethodId: string
}

async function checkItem(d: MoneyDB, input: PlanItemInput): Promise<PlanItemInput> {
  const name = input.name.trim().slice(0, PLAN_NAME_MAX)
  if (!name) throw new MoneyError('請輸入名稱')
  if (!isValidAmount(input.amount)) throw new MoneyError(`金額需為 1 到 ${MAX_AMOUNT.toLocaleString('en-US')} 的整數`)
  if (!Number.isInteger(input.day) || input.day < 1 || input.day > 31) throw new MoneyError('每月日期需為 1 到 31')
  const [cat, pay] = await Promise.all([d.categories.get(input.categoryId), d.paymentMethods.get(input.paymentMethodId)])
  if (!cat || cat.type !== 'expense') throw new MoneyError('請選擇支出分類')
  if (!pay) throw new MoneyError('請選擇付款方式')
  return { ...input, name }
}

function itemFrom(month: string, t: Pick<PlanTemplate, 'id' | 'name' | 'amount' | 'day' | 'categoryId' | 'paymentMethodId'> | null, input: PlanItemInput, stamp: string): PlannedExpense {
  return {
    id: newId(),
    month,
    templateId: t ? t.id : null,
    name: input.name,
    amount: input.amount,
    day: input.day,
    categoryId: input.categoryId,
    paymentMethodId: input.paymentMethodId,
    status: 'pending',
    transactionId: null,
    edited: false,
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/* ---------------- plans ---------------- */

/**
 * D-106: start planning a month. Income and saving goal come from the latest earlier plan; one item per
 * active template. Starting twice changes nothing.
 */
export async function startPlan(month: string, d: MoneyDB = db, now = new Date()): Promise<MonthlyPlan> {
  if (!isMonth(month)) throw new MoneyError('月份不正確')
  return d.transaction('rw', [d.monthlyPlans, d.planTemplates, d.plannedExpenses], async () => {
    const existing = await d.monthlyPlans.get(month)
    if (existing) return existing
    const stamp = now.toISOString()
    const prev = await d.monthlyPlans.where('month').below(month).last()
    const plan: MonthlyPlan = { month, income: prev?.income ?? null, saving: prev?.saving ?? 0, createdAt: stamp, updatedAt: stamp }
    await d.monthlyPlans.add(plan)
    const templates = (await d.planTemplates.toArray()).filter((t) => t.isActive)
    await d.plannedExpenses.bulkAdd(templates.map((t) => itemFrom(month, t, t, stamp)))
    return plan
  })
}

export async function setPlanNumbers(month: string, patch: { income?: number | null; saving?: number }, d: MoneyDB = db, now = new Date()): Promise<void> {
  if (patch.income !== undefined && patch.income !== null && !isMoney0(patch.income)) throw new MoneyError('預估收入需為 0 到 99,999,999 的整數')
  if (patch.saving !== undefined && !isMoney0(patch.saving)) throw new MoneyError('存錢目標需為 0 到 99,999,999 的整數')
  await d.transaction('rw', d.monthlyPlans, async () => {
    const p = await d.monthlyPlans.get(month)
    if (!p) throw new MoneyError('這個月還沒開始規劃')
    await d.monthlyPlans.put({ ...p, ...patch, updatedAt: now.toISOString() })
  })
}

/* ---------------- templates (D-107) ---------------- */

/** Months from `from` on that already have a plan. */
async function startedMonthsFrom(d: MoneyDB, from: string): Promise<string[]> {
  return (await d.monthlyPlans.where('month').aboveOrEqual(from).primaryKeys()) as string[]
}

/** New fixed item: also added to `fromMonth` and later months already being planned. */
export async function addPlanTemplate(input: PlanItemInput, fromMonth: string, d: MoneyDB = db, now = new Date()): Promise<PlanTemplate> {
  return d.transaction('rw', [d.planTemplates, d.plannedExpenses, d.monthlyPlans, d.categories, d.paymentMethods], async () => {
    const clean = await checkItem(d, input)
    const stamp = now.toISOString()
    const t: PlanTemplate = { id: newId(), ...clean, isActive: true, createdAt: stamp, updatedAt: stamp }
    await d.planTemplates.add(t)
    const months = await startedMonthsFrom(d, fromMonth)
    await d.plannedExpenses.bulkAdd(months.map((m) => itemFrom(m, t, clean, stamp)))
    return t
  })
}

/** Items a template change may follow: this month on, still pending, unlinked and never edited by hand. */
async function followers(d: MoneyDB, templateId: string, now: Date): Promise<PlannedExpense[]> {
  const cur = currentMonthKey(now)
  return (await d.plannedExpenses.where('month').aboveOrEqual(cur).toArray()).filter(
    (x) => x.templateId === templateId && x.status === 'pending' && !x.transactionId && !x.edited,
  )
}

export async function updatePlanTemplate(id: string, input: PlanItemInput, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', [d.planTemplates, d.plannedExpenses, d.categories, d.paymentMethods], async () => {
    const t = await d.planTemplates.get(id)
    if (!t) throw new MoneyError('這個固定項目已不存在')
    const clean = await checkItem(d, input)
    const stamp = now.toISOString()
    await d.planTemplates.put({ ...t, ...clean, updatedAt: stamp })
    if (!t.isActive) return
    for (const x of await followers(d, id, now)) await d.plannedExpenses.put({ ...x, ...clean, updatedAt: stamp })
  })
}

/**
 * D-140: deleting a fixed item. Its untouched items from this month on go (as 停用 did, D-107); if no item
 * is left (none recorded, skipped, edited or in an earlier month) the template itself is removed for good,
 * else it is 已刪除 and can be restored.
 */
async function templateImpactIn(d: MoneyDB, id: string, now: Date): Promise<DeleteImpact> {
  if (!(await d.planTemplates.get(id))) throw new MoneyError('這個固定項目已不存在')
  const going = new Set((await followers(d, id, now)).map((x) => x.id))
  const uses = await d.plannedExpenses.filter((x) => x.templateId === id && !going.has(x.id)).count()
  return { mode: uses ? 'soft' : 'hard', uses, blocked: '', owed: 0, cascade: [] }
}

export async function planTemplateDeleteImpact(id: string, d: MoneyDB = db, now = new Date()): Promise<DeleteImpact> {
  return d.transaction('r', [d.planTemplates, d.plannedExpenses], () => templateImpactIn(d, id, now))
}

export async function deletePlanTemplate(id: string, d: MoneyDB = db, now = new Date()): Promise<DeleteImpact> {
  return d.transaction('rw', [d.planTemplates, d.plannedExpenses, d.monthlyPlans], async () => {
    const impact = await templateImpactIn(d, id, now)
    await setPlanTemplateActive(id, false, d, now)
    if (impact.mode === 'hard') await d.planTemplates.delete(id)
    return impact
  })
}

/** Stopping removes this month's and later untouched items; starting again adds them back where missing. */
export async function setPlanTemplateActive(id: string, active: boolean, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', [d.planTemplates, d.plannedExpenses, d.monthlyPlans], async () => {
    const t = await d.planTemplates.get(id)
    if (!t) throw new MoneyError('這個固定項目已不存在')
    const stamp = now.toISOString()
    await d.planTemplates.put({ ...t, isActive: active, updatedAt: stamp })
    if (!active) {
      await d.plannedExpenses.bulkDelete((await followers(d, id, now)).map((x) => x.id))
      return
    }
    const months = await startedMonthsFrom(d, currentMonthKey(now))
    for (const m of months) {
      const has = await d.plannedExpenses.where('[month+templateId]').equals([m, id]).count()
      if (!has) await d.plannedExpenses.add(itemFrom(m, t, t, stamp))
    }
  })
}

/* ---------------- one month's items ---------------- */

/** An expense needed only this month (no template). */
export async function addOneOffExpense(month: string, input: PlanItemInput, d: MoneyDB = db, now = new Date()): Promise<PlannedExpense> {
  return d.transaction('rw', [d.plannedExpenses, d.monthlyPlans, d.categories, d.paymentMethods], async () => {
    if (!(await d.monthlyPlans.get(month))) throw new MoneyError('這個月還沒開始規劃')
    const clean = await checkItem(d, input)
    const x = { ...itemFrom(month, null, clean, now.toISOString()), edited: true }
    await d.plannedExpenses.add(x)
    return x
  })
}

/** This month only (D-107: an edited item no longer follows its template). */
export async function editPlannedExpense(id: string, input: PlanItemInput, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', [d.plannedExpenses, d.categories, d.paymentMethods], async () => {
    const x = await d.plannedExpenses.get(id)
    if (!x) throw new MoneyError('這筆必要支出已不存在')
    const clean = await checkItem(d, input)
    await d.plannedExpenses.put({ ...x, ...clean, edited: true, updatedAt: now.toISOString() })
  })
}

/** Removes a one-off item (template items are skipped instead). Never touches a transaction. */
export async function removeOneOffExpense(id: string, d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.plannedExpenses, async () => {
    const x = await d.plannedExpenses.get(id)
    if (!x) return
    if (x.templateId) throw new MoneyError('固定項目請用「本月略過」')
    await d.plannedExpenses.delete(id)
  })
}

/** A link counts only while its transaction is an expense in the item's month (D-108). */
async function validLink(d: MoneyDB, x: PlannedExpense): Promise<Transaction | null> {
  if (!x.transactionId) return null
  const t = await d.transactions.get(x.transactionId)
  return t && t.type === 'expense' && monthOfIso(t.occurredAt) === x.month ? t : null
}

export async function skipPlannedExpense(id: string, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', [d.plannedExpenses, d.transactions], async () => {
    const x = await d.plannedExpenses.get(id)
    if (!x) throw new MoneyError('這筆必要支出已不存在')
    if (await validLink(d, x)) throw new MoneyError('這筆已對應記帳，要略過請先取消對應')
    await d.plannedExpenses.put({ ...x, status: 'skipped', transactionId: null, updatedAt: now.toISOString() })
  })
}

export async function unskipPlannedExpense(id: string, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', d.plannedExpenses, async () => {
    const x = await d.plannedExpenses.get(id)
    if (!x) throw new MoneyError('這筆必要支出已不存在')
    await d.plannedExpenses.put({ ...x, status: 'pending', updatedAt: now.toISOString() })
  })
}

/** Q73: one transaction ↔ one planned expense of its month. */
async function takenBy(d: MoneyDB, txId: string, month: string, exceptId: string): Promise<PlannedExpense | null> {
  const others = await d.plannedExpenses.where('transactionId').equals(txId).toArray()
  return others.find((o) => o.id !== exceptId && o.month === month && o.status !== 'skipped') ?? null
}

/** D-109: link an existing expense; nothing is added. */
export async function linkPlannedExpense(id: string, txId: string, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', [d.plannedExpenses, d.transactions], async () => {
    const x = await d.plannedExpenses.get(id)
    if (!x) throw new MoneyError('這筆必要支出已不存在')
    if (x.status === 'skipped') throw new MoneyError('這筆本月已略過，請先恢復')
    const t = await d.transactions.get(txId)
    if (!t) throw new MoneyError('這筆記帳已不存在')
    if (t.type !== 'expense') throw new MoneyError('只能對應支出')
    if (monthOfIso(t.occurredAt) !== x.month) throw new MoneyError('只能對應同一個月的記帳')
    const other = await takenBy(d, txId, x.month, id)
    if (other) throw new MoneyError(`這筆記帳已經對應「${other.name}」`)
    await d.plannedExpenses.put({ ...x, transactionId: txId, updatedAt: now.toISOString() })
  })
}

/** Keeps the transaction; the item is pending again. */
export async function unlinkPlannedExpense(id: string, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', d.plannedExpenses, async () => {
    const x = await d.plannedExpenses.get(id)
    if (!x) return
    await d.plannedExpenses.put({ ...x, transactionId: null, updatedAt: now.toISOString() })
  })
}

/** D-109: the user's entry from the planned expense, added and linked in one transaction. */
export async function recordPlannedExpense(id: string, input: TxInput, d: MoneyDB = db, now = new Date()): Promise<Transaction> {
  return d.transaction('rw', [d.plannedExpenses, d.transactions, d.settings, d.categories, d.paymentMethods], async () => {
    const x = await d.plannedExpenses.get(id)
    if (!x) throw new MoneyError('這筆必要支出已不存在')
    if (x.status === 'skipped') throw new MoneyError('這筆本月已略過，請先恢復')
    if (await validLink(d, x)) throw new MoneyError('這筆已經記過了')
    if (input.type !== 'expense') throw new MoneyError('必要支出只能記成支出')
    if (input.date.slice(0, 7) !== x.month) {
      const [, m] = x.month.split('-')
      throw new MoneyError(`日期要在 ${Number(m)} 月內，才能對應這個月的必要支出`)
    }
    const t = await addTransaction(input, d, now)
    await d.plannedExpenses.put({ ...x, transactionId: t.id, updatedAt: now.toISOString() })
    return t
  })
}
