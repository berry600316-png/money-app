/*
 * Salary item history (spec §2–§6, D-70..D-72). Pure functions so every rule about
 * "0 vs no data" is unit-tested.
 */
import type { Payslip, SalaryItem } from '../db/types'
import { addMonthKey, currentMonthKey, monthRange } from './months'
import { toYmd } from './dates'

export type Cell =
  | { month: string; state: 'value'; amount: number; name: string | null }
  /** No payslip for this month: a gap, never 0 (spec §6). */
  | { month: string; state: 'gap' }
  /** D-143: the month's payslip does not have this item (left empty), which is not 0. */
  | { month: string; state: 'none' }

export interface SlipIndex {
  byMonth: Map<string, Payslip>
  months: string[]
}

export function indexPayslips(slips: readonly Payslip[]): SlipIndex {
  const byMonth = new Map(slips.map((s) => [s.month, s]))
  return { byMonth, months: [...byMonth.keys()].sort() }
}

/** D-143: a line on the payslip is its amount (0 included); an item not on it is 「—」, never 0. */
export function cellFor(itemId: string, month: string, idx: SlipIndex): Cell {
  const slip = idx.byMonth.get(month)
  if (!slip) return { month, state: 'gap' }
  const line = slip.lines.find((l) => l.itemId === itemId)
  if (line) return { month, state: 'value', amount: line.amount, name: line.name }
  return { month, state: 'none' }
}

type ValueCell = Extract<Cell, { state: 'value' }>

/** Most recent recorded value strictly before `month` (skips gaps, D-70). */
export function previousValue(itemId: string, month: string, idx: SlipIndex): ValueCell | null {
  for (let i = idx.months.length - 1; i >= 0; i--) {
    const m = idx.months[i]
    if (m >= month) continue
    const c = cellFor(itemId, m, idx)
    if (c.state === 'value') return c
  }
  return null
}

export function latestValue(itemId: string, idx: SlipIndex): ValueCell | null {
  for (let i = idx.months.length - 1; i >= 0; i--) {
    const c = cellFor(itemId, idx.months[i], idx)
    if (c.state === 'value') return c
  }
  return null
}

export interface Delta {
  diff: number
  /** Percent change, one decimal; null when the previous value is 0 (spec §6). */
  pct: number | null
  prevMonth: string
}

export function deltaOf(current: number, prev: ValueCell | null): Delta | null {
  if (!prev) return null // no previous record → no growth rate at all
  const diff = current - prev.amount
  return { diff, pct: prev.amount > 0 ? Math.round((diff / prev.amount) * 1000) / 10 : null, prevMonth: prev.month }
}

export type RangeOption = '3' | '6' | '12' | 'custom'

/** Months shown for a range; preset ranges end at the latest payslip month (or this month if none). */
export function periodMonths(option: RangeOption, idx: SlipIndex, custom?: { from: string; to: string }, now = new Date()): string[] {
  const end = idx.months[idx.months.length - 1] ?? currentMonthKey(now)
  if (option === 'custom' && custom) {
    const [a, b] = custom.from <= custom.to ? [custom.from, custom.to] : [custom.to, custom.from]
    return monthRange(a, b)
  }
  const n = option === 'custom' ? 6 : Number(option)
  return monthRange(addMonthKey(end, -(n - 1)), end)
}

export function periodStats(cells: readonly Cell[]) {
  const values = cells.filter((c): c is ValueCell => c.state === 'value')
  const total = values.reduce((s, c) => s + c.amount, 0)
  return {
    total,
    /** Number of months that count: those with this item (0 included); gaps and months without it excluded (D-143). */
    counted: values.length,
    average: values.length ? Math.round(total / values.length) : null,
    gaps: cells.filter((c) => c.state === 'gap').length,
    /** D-143: months whose payslip does not have this item. */
    none: cells.filter((c) => c.state === 'none').length,
    max: values.reduce((m, c) => Math.max(m, c.amount), 0),
  }
}

/* ---------------- new payslip defaults (D-62, D-63) ---------------- */

/** Next month after the latest payslip; this month when there is none. */
export function defaultNewMonth(slips: readonly Payslip[], now = new Date()): string {
  const latest = [...slips].sort((a, b) => (a.month < b.month ? 1 : -1))[0]
  return latest ? addMonthKey(latest.month, 1) : currentMonthKey(now)
}

export interface PayslipDraft {
  month: string
  payDate: string
  company: string
  paymentMethodId: string
  /** Amount as typed ('' = left empty). `onSlip` marks lines already saved on this payslip. */
  lines: { itemId: string; amount: string; onSlip: boolean }[]
}

function clampDay(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`
}

/** How many months after the salary month the money arrives (0 = same month, 1 = next month). */
export function payMonthOffset(month: string, payDate: string): number {
  const [y1, m1] = month.split('-').map(Number)
  const [y2, m2] = payDate.slice(0, 7).split('-').map(Number)
  return (y2 - y1) * 12 + (m2 - m1)
}

/** Pay date for `month`, keeping the same month offset and day as a reference payslip; never in the future. */
export function payDateFor(month: string, offset: number, day: number, now = new Date()): string {
  const d = clampDay(addMonthKey(month, offset), day)
  const today = toYmd(now)
  return d > today ? today : d
}

/**
 * Draft for a new payslip: fixed items copy the most recent earlier payslip, variable items start
 * empty (left off unless filled in, D-143); pay day, company and account follow that payslip too.
 */
export function newPayslipDraft(
  month: string,
  slips: readonly Payslip[],
  items: readonly SalaryItem[],
  fallbackPaymentId: string,
  now = new Date(),
): PayslipDraft {
  const sorted = [...slips].sort((a, b) => (a.month < b.month ? 1 : -1))
  const base = sorted.find((s) => s.month < month) ?? sorted[0]
  // Same pattern as the reference payslip: e.g. paid on the 25th of the same month, or the 5th of the next.
  const day = base ? Number(base.payDate.slice(8)) : 5
  const offset = base ? payMonthOffset(base.month, base.payDate) : 1
  return {
    month,
    payDate: payDateFor(month, offset, day, now),
    company: base?.company ?? '',
    paymentMethodId: base?.paymentMethodId ?? fallbackPaymentId,
    lines: items
      .filter((i) => i.isActive)
      .map((i) => {
        const prev = base?.lines.find((l) => l.itemId === i.id)
        return { itemId: i.id, amount: i.nature === 'fixed' && prev ? String(prev.amount) : '', onSlip: false }
      }),
  }
}

/** Draft for editing: the payslip's own lines plus active items it doesn't have (D-68). */
export function editPayslipDraft(slip: Payslip, items: readonly SalaryItem[]): PayslipDraft {
  const lines = slip.lines.map((l) => ({ itemId: l.itemId, amount: String(l.amount), onSlip: true }))
  for (const i of items) if (i.isActive && !lines.some((l) => l.itemId === i.id)) lines.push({ itemId: i.id, amount: '', onSlip: false })
  return { month: slip.month, payDate: slip.payDate, company: slip.company, paymentMethodId: slip.paymentMethodId, lines }
}

/**
 * D-143: lines to save. Empty = this month does not have the item (left off, or taken off an existing
 * payslip); 0 typed = the item with 0.
 */
export function draftToLines(draft: PayslipDraft): { itemId: string; amount: number }[] {
  return draft.lines.filter((l) => l.amount !== '').map((l) => ({ itemId: l.itemId, amount: Number(l.amount) }))
}

/** D-143: what a payslip saved before held as 0 meant "left empty": those lines go (a line with a note stays). */
export function dropOldZeroLines<L extends { amount: number; note?: string }>(lines: readonly L[]): L[] {
  return lines.filter((l) => l.amount !== 0 || !!l.note)
}
