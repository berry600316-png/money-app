import { describe, expect, it } from 'vitest'
import type { Transaction } from '../db/types'
import { calendarMonth } from './calendar'

function tx(at: Date, amount: number, type: 'expense' | 'income' = 'expense'): Transaction {
  const iso = at.toISOString()
  return { id: Math.random().toString(36).slice(2), type, amount, merchant: '', categoryId: 'food', paymentMethodId: 'card', occurredAt: iso, note: '', source: 'manual', externalId: null, createdAt: iso, updatedAt: iso }
}

describe('home calendar (D-115)', () => {
  const now = new Date(2026, 9, 11, 16, 12)
  it('weeks start on Sunday: blank cells before day 1', () => {
    expect(calendarMonth([], { y: 2026, m: 9 }, now).lead).toBe(4) // 2026-10-01 is a Thursday
    expect(calendarMonth([], { y: 2026, m: 1 }, now).lead).toBe(0) // 2026-02-01 is a Sunday
    expect(calendarMonth([], { y: 2026, m: 1 }, now).days).toHaveLength(28)
    expect(calendarMonth([], { y: 2028, m: 1 }, now).days).toHaveLength(29)
  })
  it('daily totals by local day, edges included; other months ignored', () => {
    const list = [
      tx(new Date(2026, 9, 1, 0, 0), 100),
      tx(new Date(2026, 9, 1, 23, 59), 50),
      tx(new Date(2026, 9, 5, 9), 53000, 'income'),
      tx(new Date(2026, 9, 5, 9, 5), 15000),
      tx(new Date(2026, 8, 30, 23, 59), 999),
      tx(new Date(2026, 10, 1, 0, 0), 888),
    ]
    const c = calendarMonth(list, { y: 2026, m: 9 }, now)
    expect([c.days[0].expense, c.days[0].count]).toEqual([150, 2])
    expect([c.days[4].expense, c.days[4].income, c.days[4].count]).toEqual([15000, 53000, 2])
    expect(c.days.reduce((s, d) => s + d.expense, 0)).toBe(15150)
  })
  it('today, future days and the daily average', () => {
    const c = calendarMonth([tx(new Date(2026, 9, 2, 12), 1100)], { y: 2026, m: 9 }, now)
    expect(c.days[10].today).toBe(true)
    expect(c.days[10].future).toBe(false)
    expect(c.days[11].future).toBe(true)
    expect(c.avg).toBe(100) // 1,100 over 11 days
    const sep = calendarMonth([tx(new Date(2026, 8, 2, 12), 3000)], { y: 2026, m: 8 }, now)
    expect([sep.avg, sep.days.some((d) => d.future)]).toEqual([100, false])
    expect(calendarMonth([], { y: 2026, m: 10 }, now).days.every((d) => d.future)).toBe(true)
  })
  it('shade: 0 when nothing spent; one big payment does not wash out the month', () => {
    const list = [tx(new Date(2026, 9, 5, 9), 15000), ...[1, 2, 3, 4, 6, 7, 8, 9, 10, 11].map((d) => tx(new Date(2026, 9, d, 12), 200 + d * 10))]
    const c = calendarMonth(list, { y: 2026, m: 9 }, now)
    expect(c.days[4].heat).toBe(1)
    expect(c.days[0].heat).toBeGreaterThan(0.3)
    expect(calendarMonth([], { y: 2026, m: 9 }, now).days[0].heat).toBe(0)
  })
})
