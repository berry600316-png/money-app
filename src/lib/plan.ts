/*
 * Monthly planning, pure part (D-105..D-112). Plans never touch transactions; whether a planned expense
 * is "recorded" is worked out here from its link and the real transactions, every time (D-108).
 */
import type { MonthlyPlan, PlannedExpense, Transaction } from '../db/types'
import { daysInMonth } from './dates'
import { merchantSimilarity } from '../card/text'

export type PlanItemState = 'pending' | 'linked' | 'skipped'
/** Why a stored link no longer counts (D-108). */
export type BrokenLink = { kind: 'deleted' } | { kind: 'not_expense' } | { kind: 'moved'; month: string }

export interface PlanItemView {
  item: PlannedExpense
  state: PlanItemState
  /** The linked transaction when the link is valid. */
  tx: Transaction | null
  broken: BrokenLink | null
  /** What this item adds to B: estimate when pending, the real amount when linked, 0 when skipped (D-112). */
  value: number
  /** Real − estimate, when linked. */
  diff: number | null
  /** The day this month it is due (clamped to the month's last day, D-111). */
  dueDay: number
}

export interface PlanSummary {
  month: string
  /** A: null until the user sets it (D-110). */
  income: number | null
  /** Income actually recorded this month (shown next to A, never added to it). */
  actualIncome: number
  /** B */
  necessary: number
  /** Part of B already recorded. */
  recorded: number
  pendingCount: number
  /** C: this month's real expenses not counted in B. */
  otherSpending: number
  /** D */
  saving: number
  /** A − B − C (null without A). */
  keep: number | null
  /** A − B − C − D (null without A). */
  spendable: number | null
  items: PlanItemView[]
}

export const monthOfIso = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function dueDayIn(month: string, day: number): number {
  const [y, m] = month.split('-').map(Number)
  return Math.min(day, daysInMonth({ y, m: m - 1 }))
}

/**
 * @param monthTx  every transaction of `month`
 * @param linkedTx the transactions the items point at, wherever they are now (missing = deleted)
 */
export function summarizePlan(
  month: string,
  plan: MonthlyPlan | null,
  items: readonly PlannedExpense[],
  monthTx: readonly Transaction[],
  linkedTx: ReadonlyMap<string, Transaction>,
): PlanSummary {
  const views: PlanItemView[] = items.map((item) => {
    const dueDay = dueDayIn(month, item.day)
    if (item.status === 'skipped') return { item, state: 'skipped', tx: null, broken: null, value: 0, diff: null, dueDay }
    if (item.transactionId) {
      const t = linkedTx.get(item.transactionId)
      let broken: BrokenLink | null = null
      if (!t) broken = { kind: 'deleted' }
      else if (t.type !== 'expense') broken = { kind: 'not_expense' }
      else if (monthOfIso(t.occurredAt) !== month) broken = { kind: 'moved', month: monthOfIso(t.occurredAt) }
      if (!broken && t) return { item, state: 'linked', tx: t, broken: null, value: t.amount, diff: t.amount - item.amount, dueDay }
      return { item, state: 'pending', tx: null, broken, value: item.amount, diff: null, dueDay }
    }
    return { item, state: 'pending', tx: null, broken: null, value: item.amount, diff: null, dueDay }
  })
  // A transaction counts once: inside B when validly linked, otherwise in C (D-112, D-108).
  const inB = new Set(views.filter((v) => v.state === 'linked').map((v) => v.tx!.id))
  let otherSpending = 0
  let actualIncome = 0
  for (const t of monthTx) {
    if (monthOfIso(t.occurredAt) !== month) continue
    if (t.type === 'income') actualIncome += t.amount
    else if (!inB.has(t.id)) otherSpending += t.amount
  }
  const necessary = views.reduce((s, v) => s + v.value, 0)
  const recorded = views.filter((v) => v.state === 'linked').reduce((s, v) => s + v.value, 0)
  const income = plan?.income ?? null
  const saving = plan?.saving ?? 0
  const keep = income === null ? null : income - necessary - otherSpending
  return {
    month,
    income,
    actualIncome,
    necessary,
    recorded,
    pendingCount: views.filter((v) => v.state === 'pending').length,
    otherSpending,
    saving,
    keep,
    spendable: keep === null ? null : keep - saving,
    items: views.sort(byStateThenDay),
  }
}

function byStateThenDay(a: PlanItemView, b: PlanItemView): number {
  const o = { pending: 0, linked: 1, skipped: 2 }
  return o[a.state] - o[b.state] || a.dueDay - b.dueDay || a.item.name.localeCompare(b.item.name)
}

/**
 * D-109: transactions that may be this planned expense. Only this month's expenses not validly linked to
 * another item. `best` is set only when one candidate clearly stands out.
 */
export function linkCandidates(
  item: PlannedExpense,
  monthTx: readonly Transaction[],
  takenTxIds: ReadonlySet<string>,
): { candidates: { tx: Transaction; score: number }[]; best: Transaction | null } {
  const scored = monthTx
    .filter((t) => t.type === 'expense' && !takenTxIds.has(t.id) && monthOfIso(t.occurredAt) === item.month)
    .map((t) => {
      let score = 0
      if (t.categoryId === item.categoryId) score += 2
      if (t.paymentMethodId === item.paymentMethodId) score += 1
      if (t.amount === item.amount) score += 4
      else if (Math.abs(t.amount - item.amount) <= Math.max(10, item.amount * 0.1)) score += 3
      if (t.merchant && merchantSimilarity(t.merchant, item.name) >= 0.5) score += 3
      return { tx: t, score }
    })
    .filter((c) => c.score >= 3)
    .sort((a, b) => b.score - a.score || (a.tx.occurredAt < b.tx.occurredAt ? 1 : -1))
    .slice(0, 8)
  const top = scored[0]
  const second = scored[1]
  // Strong (category + close amount at least) and clearly ahead of the next one.
  const best = top && top.score >= 6 && (!second || second.score <= top.score - 2) ? top.tx : null
  return { candidates: scored, best }
}

/** D-111: a reminder, not a block. */
export function looksLikeCardBill(name: string): boolean {
  return /卡費|信用卡/.test(name)
}
