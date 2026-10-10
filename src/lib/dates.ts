/*
 * All dates are stored as UTC ISO strings and interpreted in the iPhone's local time zone.
 * Month boundaries are computed from local midnight so a purchase at 23:30 on the 31st
 * never lands in the next month.
 */

const WEEKDAYS = '日一二三四五六'

function pad(n: number) {
  return n < 10 ? '0' + n : String(n)
}

/** Local calendar date as "YYYY-MM-DD". */
export function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "YYYY-MM-DD" → local midnight. */
export function fromYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function todayYmd(now = new Date()): string {
  return toYmd(now)
}

export interface YearMonth {
  y: number
  /** 0-based month, like Date#getMonth */
  m: number
}

export function ymOf(d: Date): YearMonth {
  return { y: d.getFullYear(), m: d.getMonth() }
}

export function addMonths(ym: YearMonth, delta: number): YearMonth {
  const d = new Date(ym.y, ym.m + delta, 1)
  return { y: d.getFullYear(), m: d.getMonth() }
}

export function sameYm(a: YearMonth, b: YearMonth): boolean {
  return a.y === b.y && a.m === b.m
}

export function daysInMonth(ym: YearMonth): number {
  return new Date(ym.y, ym.m + 1, 0).getDate()
}

/** [start, end) of a local month as UTC ISO strings, for IndexedDB range queries. */
export function monthRangeIso(ym: YearMonth): [string, string] {
  return [new Date(ym.y, ym.m, 1).toISOString(), new Date(ym.y, ym.m + 1, 1).toISOString()]
}

export function isInMonth(iso: string, ym: YearMonth): boolean {
  const d = new Date(iso)
  return d.getFullYear() === ym.y && d.getMonth() === ym.m
}

export function sameLocalDay(a: Date, b: Date): boolean {
  return toYmd(a) === toYmd(b)
}

/** D-21: today keeps the current time, other days are stored at local 12:00. */
export function occurredAtFor(ymd: string, now = new Date()): string {
  if (ymd === toYmd(now)) return now.toISOString()
  const d = fromYmd(ymd)
  d.setHours(12, 0, 0, 0)
  return d.toISOString()
}

/** "今天" / "昨天" / "10月8日 週三" (year added when not the current year). */
export function dayLabel(d: Date, opts: { short?: boolean; now?: Date } = {}): string {
  const now = opts.now ?? new Date()
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = Math.round((a.getTime() - b.getTime()) / 864e5)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  let base = `${d.getMonth() + 1}月${d.getDate()}日`
  if (d.getFullYear() !== now.getFullYear()) base = `${d.getFullYear()}年${base}`
  return opts.short ? base : `${base} 週${WEEKDAYS[d.getDay()]}`
}

export function monthLabel(ym: YearMonth): string {
  return `${ym.y}年${ym.m + 1}月`
}

export function timeLabel(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Whole days between two instants, by local calendar date. */
export function daysBetween(fromIso: string, to = new Date()): number {
  const a = new Date(fromIso)
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate())
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.round((end.getTime() - start.getTime()) / 864e5)
}
