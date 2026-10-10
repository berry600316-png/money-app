import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type { Category, PaymentMethod, Payslip, SalaryItem, Transaction } from './types'
import { addMonths, monthRangeIso, type YearMonth } from '../lib/dates'

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

/** Every transaction; only used while searching (D-32). */
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
