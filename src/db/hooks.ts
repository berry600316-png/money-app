import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type { Category, PaymentMethod, Payslip, PlanTemplate, SalaryItem, Transaction } from './types'
import { linkCandidates, summarizePlan, type PlanSummary } from '../lib/plan'
import { addMonths, fromYmd, monthRangeIso, type YearMonth } from '../lib/dates'
import { accountFlow, computeBalances, isMethod, isTracked, type FlowRow } from '../lib/accounts'

/* Live queries re-run automatically after any write, so every screen updates at once. */

export function useMonthTx(ym: YearMonth): Transaction[] | undefined {
  return useLiveQuery(() => {
    const [start, end] = monthRangeIso(ym)
    return db.transactions.where('occurredAt').between(start, end, true, false).toArray()
  }, [ym.y, ym.m])
}

/** Transactions for `count` months ending at `end` (inclusive). */
export function useMonthsTx(end: YearMonth, count: number): Transaction[] | undefined {
  return useLiveQuery(() => {
    const [start] = monthRangeIso(addMonths(end, -(count - 1)))
    const [, stop] = monthRangeIso(end)
    return db.transactions.where('occurredAt').between(start, stop, true, false).toArray()
  }, [end.y, end.m, count])
}

export function useRecentTx(limit: number): Transaction[] | undefined {
  return useLiveQuery(() => db.transactions.orderBy('occurredAt').reverse().limit(limit).toArray(), [limit])
}

/** Inclusive local dates "YYYY-MM-DD" (D-103). */
export function useRangeTx(from: string, to: string, enabled = true): Transaction[] | undefined {
  return useLiveQuery(() => {
    if (!enabled || !from || !to || from > to) return Promise.resolve([] as Transaction[])
    const start = fromYmd(from).toISOString()
    const end = fromYmd(to)
    end.setDate(end.getDate() + 1)
    return db.transactions.where('occurredAt').between(start, end.toISOString(), true, false).toArray()
  }, [from, to, enabled])
}

/** Every transaction (searching all dates, "全部日期", yearly stats). */
export function useAllTx(enabled: boolean): Transaction[] | undefined {
  return useLiveQuery(() => (enabled ? db.transactions.toArray() : Promise.resolve([] as Transaction[])), [enabled])
}

export function useTxCount(): number | undefined {
  return useLiveQuery(() => db.transactions.count(), [])
}

function byOrder<T extends { sortOrder: number }>(a: T, b: T) {
  return a.sortOrder - b.sortOrder
}

export function useCategories(): Category[] | undefined {
  return useLiveQuery(async () => (await db.categories.toArray()).sort(byOrder), [])
}

export function usePaymentMethods(): PaymentMethod[] | undefined {
  return useLiveQuery(async () => (await db.paymentMethods.toArray()).sort(byOrder), [])
}

/** All payslips, oldest month first. */
export function usePayslips(): Payslip[] | undefined {
  return useLiveQuery(() => db.payslips.orderBy('month').toArray(), [])
}

/** Salary items in display order: earnings first, then deductions. */
export function useSalaryItems(): SalaryItem[] | undefined {
  return useLiveQuery(
    async () => (await db.salaryItems.toArray()).sort((a, b) => (a.kind === b.kind ? a.sortOrder - b.sortOrder : a.kind === 'earning' ? -1 : 1)),
    [],
  )
}

export function useSetting<T>(key: string, fallback: T): T {
  const row = useLiveQuery(() => db.settings.get(key), [key])
  return row === undefined ? fallback : (row.value as T)
}

/* ---------------- monthly planning (D-105..D-113) ---------------- */

export interface PlanState {
  started: boolean
  /** From the latest earlier plan, to say what starting a month will copy (D-106). */
  previousIncome: number | null
  previousSaving: number
  activeTemplates: number
  summary: PlanSummary
  /** itemId → "可能已記：…" when one clear candidate exists (D-109). */
  hints: Map<string, string>
  /** Transactions validly linked to an item of this month. */
  taken: Set<string>
}

export function usePlanSummary(month: string): PlanState | undefined {
  return useLiveQuery(async () => {
    const [y, m] = month.split('-').map(Number)
    const [start, end] = monthRangeIso({ y, m: m - 1 })
    const [plan, items, templates, prev, monthTx] = await Promise.all([
      db.monthlyPlans.get(month),
      db.plannedExpenses.where('month').equals(month).toArray(),
      db.planTemplates.toArray(),
      db.monthlyPlans.where('month').below(month).last(),
      db.transactions.where('occurredAt').between(start, end, true, false).toArray(),
    ])
    const ids = items.map((i) => i.transactionId).filter((x): x is string => !!x)
    const linked = new Map((await db.transactions.bulkGet(ids)).filter((t): t is Transaction => !!t).map((t) => [t.id, t]))
    const summary = summarizePlan(month, plan ?? null, items, monthTx, linked)
    const taken = new Set(summary.items.filter((v) => v.state === 'linked').map((v) => v.tx!.id))
    const hints = new Map<string, string>()
    for (const v of summary.items) {
      if (v.state !== 'pending' || v.broken) continue
      const { best } = linkCandidates(v.item, monthTx, taken)
      if (best) {
        const d = new Date(best.occurredAt)
        hints.set(v.item.id, `可能已記：${d.getMonth() + 1}/${d.getDate()} ${best.merchant || '一筆支出'}，點一下確認`)
      }
    }
    return {
      started: !!plan,
      previousIncome: prev?.income ?? null,
      previousSaving: prev?.saving ?? 0,
      activeTemplates: templates.filter((t) => t.isActive).length,
      summary,
      hints,
      taken,
    }
  }, [month])
}

/* ---------------- accounts (D-117..D-123) ---------------- */

/** Balance of every tracked account (cards: 預扣), re-derived from the records on every change. */
export function useBalances(): Map<string, number> | undefined {
  return useLiveQuery(async () => {
    const accounts = await db.paymentMethods.toArray()
    const starts = accounts.filter((a) => isTracked(a) && !isMethod(a)).map((a) => a.balanceFrom!)
    if (!starts.length) return new Map<string, number>()
    const since = starts.sort()[0]
    const [txs, adjs] = await Promise.all([db.transactions.where('occurredAt').aboveOrEqual(since).toArray(), db.adjustments.toArray()])
    return computeBalances(accounts, txs, adjs)
  }, [])
}

/** One account's history since its start date, newest first (D-123). */
export function useAccountFlow(id: string): FlowRow[] | undefined {
  return useLiveQuery(async () => {
    const accounts = await db.paymentMethods.toArray()
    const acc = accounts.find((a) => a.id === id)
    if (!acc || !isTracked(acc)) return []
    // A bank's page also lists its cards' charges (D-125), each counted from its card's own start.
    const cardStarts = accounts.filter((c) => c.type === 'credit_card' && c.payFromId === id && isTracked(c)).map((c) => c.balanceFrom!)
    const since = [acc.balanceFrom!, ...cardStarts].sort()[0]
    const [txs, adjs] = await Promise.all([
      db.transactions.where('occurredAt').aboveOrEqual(since).toArray(),
      db.adjustments.where('accountId').equals(id).toArray(),
    ])
    return accountFlow(acc, accounts, txs, adjs)
  }, [id])
}

export function usePlanTemplates(): PlanTemplate[] | undefined {
  return useLiveQuery(async () => (await db.planTemplates.toArray()).sort((a, b) => a.day - b.day || a.name.localeCompare(b.name)), [])
}

/** D-110: the latest payslip's net pay (its income record), offered as a first estimate. */
export function useLatestPayslipNet(): number | null {
  const v = useLiveQuery(async () => {
    const slips = await db.payslips.orderBy('month').reverse().toArray()
    for (const s of slips) {
      if (!s.transactionId) continue
      const t = await db.transactions.get(s.transactionId)
      if (t) return t.amount
    }
    return null
  }, [])
  return v ?? null
}

