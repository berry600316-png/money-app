import type { Transaction, TxType } from '../db/types'
import { addMonths, daysInMonth, isInMonth, toYmd, type YearMonth } from './dates'

/** One function for every screen, so home, list and stats always agree. */
export function sumType(list: readonly Transaction[], type: TxType): number {
  let s = 0
  for (const t of list) if (t.type === type) s += t.amount
  return s
}

export function summarize(list: readonly Transaction[]) {
  const expense = sumType(list, 'expense')
  const income = sumType(list, 'income')
  return { expense, income, balance: income - expense }
}

export function sortDesc(list: readonly Transaction[]): Transaction[] {
  return [...list].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0))
}

export function filterMonth(list: readonly Transaction[], ym: YearMonth): Transaction[] {
  return list.filter((t) => isInMonth(t.occurredAt, ym))
}

export function byCategory(list: readonly Transaction[], type: TxType): { categoryId: string; amount: number }[] {
  const m = new Map<string, number>()
  for (const t of list) if (t.type === type) m.set(t.categoryId, (m.get(t.categoryId) ?? 0) + t.amount)
  return [...m.entries()].map(([categoryId, amount]) => ({ categoryId, amount })).sort((a, b) => b.amount - a.amount)
}

/** Expense per local calendar day of the month; index 0 = day 1. */
export function dailyExpense(list: readonly Transaction[], ym: YearMonth): number[] {
  const out = new Array<number>(daysInMonth(ym)).fill(0)
  for (const t of list) {
    if (t.type !== 'expense') continue
    const d = new Date(t.occurredAt)
    if (d.getFullYear() === ym.y && d.getMonth() === ym.m) out[d.getDate() - 1] += t.amount
  }
  return out
}

/**
 * D-31: compare with last month. For the current month, compare against the same days
 * of last month ("比上月同期") so a half-finished month is not compared to a full one.
 */
export function monthOverMonth(
  current: readonly Transaction[],
  previous: readonly Transaction[],
  ym: YearMonth,
  now = new Date(),
): { pct: number; previous: number; sameRange: boolean } | null {
  const isCurrent = ym.y === now.getFullYear() && ym.m === now.getMonth()
  const prevList = isCurrent ? previous.filter((t) => new Date(t.occurredAt).getDate() <= now.getDate()) : previous
  const prev = sumType(prevList, 'expense')
  const cur = sumType(current, 'expense')
  if (prev <= 0 || cur <= 0) return null
  return { pct: Math.round(((cur - prev) / prev) * 100), previous: prev, sameRange: isCurrent }
}

/** Expense for `count` months ending at `end` (oldest first). */
export function trend(list: readonly Transaction[], end: YearMonth, count = 6): { ym: YearMonth; expense: number }[] {
  const out: { ym: YearMonth; expense: number }[] = []
  for (let k = count - 1; k >= 0; k--) {
    const ym = addMonths(end, -k)
    out.push({ ym, expense: sumType(filterMonth(list, ym), 'expense') })
  }
  return out
}

export interface DayGroup {
  ymd: string
  date: Date
  items: Transaction[]
  expense: number
  income: number
}

/** Groups an already-sorted list by local calendar day. */
export function groupByDay(list: readonly Transaction[]): DayGroup[] {
  const groups: DayGroup[] = []
  let cur: DayGroup | null = null
  for (const t of list) {
    const d = new Date(t.occurredAt)
    const k = toYmd(d)
    if (!cur || cur.ymd !== k) {
      cur = { ymd: k, date: d, items: [], expense: 0, income: 0 }
      groups.push(cur)
    }
    cur.items.push(t)
    if (t.type === 'income') cur.income += t.amount
    else cur.expense += t.amount
  }
  return groups
}

/** D-32: matches merchant, category, payment method, note, or the exact amount. */
export function searchTx(
  list: readonly Transaction[],
  query: string,
  names: { category: (id: string) => string; payment: (id: string) => string },
): Transaction[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...list]
  const asAmount = q.replace(/[,\s]/g, '')
  return list.filter((t) => {
    if (/^\d+$/.test(asAmount) && String(t.amount) === asAmount) return true
    const hay = `${t.merchant} ${t.note} ${names.category(t.categoryId)} ${names.payment(t.paymentMethodId)}`.toLowerCase()
    return hay.includes(q)
  })
}
