/*
 * D-115: the home screen's month calendar (weeks start on Sunday). Pure: one month's cells, daily
 * totals and the colour scale, from the same transactions every other screen uses.
 */
import type { Transaction } from '../db/types'
import { daysInMonth, toYmd, type YearMonth } from './dates'

export interface CalDay {
  ymd: string
  day: number
  expense: number
  income: number
  count: number
  today: boolean
  /** A day that has not come yet: shown, not selectable. */
  future: boolean
  /** 0–1 against the month's scale (0 = nothing spent). */
  heat: number
}

export interface CalMonth {
  /** Blank cells before day 1. */
  lead: number
  days: CalDay[]
  /** Expense per day passed so far (whole month for past months; 0 for future months). */
  avg: number
}

export function calendarMonth(list: readonly Transaction[], ym: YearMonth, now = new Date(), weekStart = 0): CalMonth {
  const n = daysInMonth(ym)
  const expense = new Array<number>(n).fill(0)
  const income = new Array<number>(n).fill(0)
  const count = new Array<number>(n).fill(0)
  for (const t of list) {
    const d = new Date(t.occurredAt)
    if (d.getFullYear() !== ym.y || d.getMonth() !== ym.m) continue
    const i = d.getDate() - 1
    count[i]++
    if (t.type === 'income') income[i] += t.amount
    else expense[i] += t.amount
  }
  const todayYmd = toYmd(now)
  const isCurrent = now.getFullYear() === ym.y && now.getMonth() === ym.m
  const isFuture = ym.y > now.getFullYear() || (ym.y === now.getFullYear() && ym.m > now.getMonth())
  const elapsed = isFuture ? 0 : isCurrent ? now.getDate() : n
  // Scale: the 85th percentile of the days so far, so one big payment doesn't wash out the month.
  const past = expense.slice(0, elapsed).sort((a, b) => a - b)
  const cap = Math.max(300, (past[Math.floor((past.length - 1) * 0.85)] ?? 0) * 1.15)
  const days: CalDay[] = expense.map((e, i) => {
    const ymd = toYmd(new Date(ym.y, ym.m, i + 1))
    return {
      ymd,
      day: i + 1,
      expense: e,
      income: income[i],
      count: count[i],
      today: ymd === todayYmd,
      future: ymd > todayYmd,
      heat: e > 0 ? Math.min(1, e / cap) : 0,
    }
  })
  const lead = (new Date(ym.y, ym.m, 1).getDay() - weekStart + 7) % 7
  const spent = expense.slice(0, elapsed).reduce((s, v) => s + v, 0)
  return { lead, days, avg: elapsed ? Math.round(spent / elapsed) : 0 }
}
