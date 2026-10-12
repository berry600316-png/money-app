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
    // Transfers are listed but are neither income nor expense (D-117).
    if (t.type === 'income') cur.income += t.amount
    else if (t.type === 'expense') cur.expense += t.amount
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
    const accounts = [t.paymentMethodId, t.toAccountId, t.sourceAccountId, t.cardId].filter((x): x is string => !!x).map(names.payment)
    const hay = `${t.merchant} ${t.note} ${t.type === 'transfer' ? '互轉' : names.category(t.categoryId)} ${accounts.join(' ')}`.toLowerCase()
    return hay.includes(q)
  })
}

/* ---------------- list filters (D-103) ---------------- */

export type DateMode = 'month' | 'range' | 'all'
/** Payment filter value meaning "every payment method whose type is credit card". */
export const ALL_CARDS = '__cards__'

export interface TxFilter {
  q: string
  type: 'all' | TxType
  /** Empty = every category. */
  categoryIds: string[]
  /** null = any; ALL_CARDS; or a payment method id. */
  payment: string | null
  dateMode: DateMode
  /** Inclusive local dates for 'range'. */
  from: string
  to: string
}

/**
 * D-103 / Q63: the dates actually searched. A custom range always holds; in month mode, typing a search
 * looks at every date (shown to the user), and clearing it returns to the month.
 */
export function effectiveDateMode(f: Pick<TxFilter, 'q' | 'dateMode'>): DateMode {
  return f.dateMode === 'month' && f.q.trim() ? 'all' : f.dateMode
}

/** True when anything narrows the list beyond "this month, everything". */
export function isFiltered(f: TxFilter): boolean {
  return f.q.trim() !== '' || f.type !== 'all' || f.categoryIds.length > 0 || f.payment !== null || f.dateMode !== 'month'
}

/**
 * Every condition at once, on whatever rows the caller loaded for the date mode; dates are checked
 * again here so a wider source never leaks rows. Totals must come from this full result (not the
 * rows shown on screen).
 */
export function filterTx(
  list: readonly Transaction[],
  f: TxFilter,
  ctx: {
    month: YearMonth
    isCard: (paymentId: string) => boolean
    /** D-125: the account a card belongs to, so filtering by a bank also shows its cards' spending. */
    homeOf?: (paymentId: string) => string | undefined
    names: { category: (id: string) => string; payment: (id: string) => string }
  },
): Transaction[] {
  const mode = effectiveDateMode(f)
  let l = list.filter((t) => {
    if (mode === 'month' && !isInMonth(t.occurredAt, ctx.month)) return false
    if (mode === 'range') {
      const d = toYmd(new Date(t.occurredAt))
      if (d < f.from || d > f.to) return false
    }
    if (f.type !== 'all' && t.type !== f.type) return false
    if (f.categoryIds.length && !f.categoryIds.includes(t.categoryId)) return false
    if (f.payment !== null && !touches(t, f.payment === ALL_CARDS ? ctx.isCard : (id) => id === f.payment, ctx.homeOf)) return false
    return true
  })
  if (f.q.trim()) l = searchTx(l, f.q, ctx.names)
  return sortDesc(l)
}

/**
 * D-123 / D-125: an account filter shows everything that moved money in that account, including transfers
 * to it, cards charged through a 行動支付, and (for a bank) the spending on its cards.
 */
function touches(t: Transaction, match: (id: string) => boolean, homeOf?: (id: string) => string | undefined): boolean {
  return [t.paymentMethodId, t.toAccountId, t.sourceAccountId, t.cardId].some((id) => {
    if (!id) return false
    if (match(id)) return true
    const home = homeOf?.(id)
    return !!home && match(home)
  })
}

/* ---------------- yearly overview (D-104) ---------------- */

export interface MonthTotals {
  ym: YearMonth
  income: number
  expense: number
  balance: number
  /** A month that has not started yet: no numbers are shown for it. */
  future: boolean
}

/**
 * The 12 months of `year` from real transactions only (no plans, no estimates), using the same
 * summarize() as the monthly view so the two can never disagree.
 */
export function yearByMonth(list: readonly Transaction[], year: number, now = new Date()): MonthTotals[] {
  const out: MonthTotals[] = []
  for (let m = 0; m < 12; m++) {
    const ym = { y: year, m }
    const future = year > now.getFullYear() || (year === now.getFullYear() && m > now.getMonth())
    const s = future ? { income: 0, expense: 0, balance: 0 } : summarize(filterMonth(list, ym))
    out.push({ ym, ...s, future })
  }
  return out
}

/** Year totals = the sum of its months. */
export function yearTotals(months: readonly MonthTotals[]) {
  let income = 0
  let expense = 0
  for (const m of months) {
    income += m.income
    expense += m.expense
  }
  return { income, expense, balance: income - expense }
}
