/* "YYYY-MM" month keys used by payslips. Pure string math, no time zone involved. */

const RE = /^(\d{4})-(0[1-9]|1[0-2])$/

export function isMonthKey(s: unknown): s is string {
  return typeof s === 'string' && RE.test(s)
}

export function monthKey(y: number, m0: number): string {
  const d = new Date(y, m0, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function addMonthKey(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number)
  return monthKey(y, m - 1 + delta)
}

export function currentMonthKey(now = new Date()): string {
  return monthKey(now.getFullYear(), now.getMonth())
}

/** Inclusive list of month keys from `from` to `to` (empty if from > to). */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let k = from; k <= to; k = addMonthKey(k, 1)) out.push(k)
  return out
}

/** "2026-10" → "2026年10月" */
export function monthKeyLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return `${y}年${m}月`
}

/** "2026-10" → "10 月" */
export function monthShort(key: string): string {
  return `${Number(key.slice(5))} 月`
}
