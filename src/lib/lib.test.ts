import { describe, expect, it } from 'vitest'
import type { Transaction } from '../db/types'
import { addMonths, dayLabel, monthRangeIso, occurredAtFor, toYmd } from './dates'
import { applyKey, compact, fmt, isValidAmount, MAX_AMOUNT } from './money'
import { byCategory, dailyExpense, filterMonth, groupByDay, monthOverMonth, searchTx, sortDesc, summarize, trend } from './stats'

function tx(p: Partial<Transaction> & { at: Date }): Transaction {
  const iso = p.at.toISOString()
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    type: p.type ?? 'expense',
    amount: p.amount ?? 100,
    merchant: p.merchant ?? '',
    categoryId: p.categoryId ?? 'food',
    paymentMethodId: p.paymentMethodId ?? 'card',
    occurredAt: iso,
    note: p.note ?? '',
    source: 'manual',
    externalId: null,
    createdAt: iso,
    updatedAt: iso,
  }
}

describe('money', () => {
  it('formats with thousands separators and a real minus sign', () => {
    expect(fmt(18420)).toBe('18,420')
    expect(fmt(-1200)).toBe('−1,200')
    expect(compact(18420)).toBe('1.8萬')
    expect(compact(20000)).toBe('2萬')
    expect(compact(9200)).toBe('9,200')
  })
  it('validates integer amounts only', () => {
    expect(isValidAmount(1)).toBe(true)
    expect(isValidAmount(MAX_AMOUNT)).toBe(true)
    expect(isValidAmount(0)).toBe(false)
    expect(isValidAmount(10.5)).toBe(false)
    expect(isValidAmount(MAX_AMOUNT + 1)).toBe(false)
    expect(isValidAmount('100')).toBe(false)
  })
  it('keypad ignores leading zeros and caps the amount', () => {
    expect(applyKey('', '0')).toBeUndefined()
    expect(applyKey('', '00')).toBeUndefined()
    expect(applyKey('1', '00')).toBe('100')
    expect(applyKey('12', 'back')).toBe('1')
    expect(applyKey('12', 'clear')).toBe('')
    expect(applyKey('99999999', '1')).toBeUndefined()
    expect(applyKey('9999999', '00')).toBeUndefined()
  })
})

describe('dates (local time zone)', () => {
  it('month range starts and ends at local midnight', () => {
    const [start, end] = monthRangeIso({ y: 2026, m: 9 })
    expect(new Date(start).getTime()).toBe(new Date(2026, 9, 1).getTime())
    expect(new Date(end).getTime()).toBe(new Date(2026, 10, 1).getTime())
  })
  it('a late-night purchase on the last day stays in that month', () => {
    const late = tx({ at: new Date(2026, 9, 31, 23, 50) })
    expect(filterMonth([late], { y: 2026, m: 9 })).toHaveLength(1)
    expect(filterMonth([late], { y: 2026, m: 10 })).toHaveLength(0)
  })
  it('stores past days at 12:00 and today at the current time', () => {
    const now = new Date(2026, 9, 10, 8, 30)
    expect(new Date(occurredAtFor('2026-10-03', now)).getHours()).toBe(12)
    expect(occurredAtFor('2026-10-10', now)).toBe(now.toISOString())
    expect(toYmd(new Date(occurredAtFor('2026-10-03', now)))).toBe('2026-10-03')
  })
  it('wraps months across years', () => {
    expect(addMonths({ y: 2026, m: 0 }, -1)).toEqual({ y: 2025, m: 11 })
    expect(addMonths({ y: 2026, m: 11 }, 1)).toEqual({ y: 2027, m: 0 })
  })
  it('labels days relative to today', () => {
    const now = new Date(2026, 9, 10, 9)
    expect(dayLabel(new Date(2026, 9, 10, 1), { now })).toBe('今天')
    expect(dayLabel(new Date(2026, 9, 9, 23), { now })).toBe('昨天')
    expect(dayLabel(new Date(2026, 9, 7, 12), { now })).toBe('10月7日 週三')
    expect(dayLabel(new Date(2025, 11, 31, 12), { now, short: true })).toBe('2025年12月31日')
  })
})

describe('stats', () => {
  const oct = { y: 2026, m: 9 }
  const list = [
    tx({ at: new Date(2026, 9, 1, 9), amount: 120, categoryId: 'food' }),
    tx({ at: new Date(2026, 9, 1, 19), amount: 80, categoryId: 'transport' }),
    tx({ at: new Date(2026, 9, 5, 9), amount: 52000, type: 'income', categoryId: 'salary' }),
    tx({ at: new Date(2026, 9, 9, 12), amount: 300, categoryId: 'food', merchant: '路易莎咖啡' }),
    tx({ at: new Date(2026, 8, 3, 12), amount: 250, categoryId: 'food' }),
    tx({ at: new Date(2026, 8, 20, 12), amount: 5000, categoryId: 'shopping' }),
  ]

  it('summary, daily bars and category totals agree', () => {
    const month = filterMonth(list, oct)
    const s = summarize(month)
    expect(s).toEqual({ expense: 500, income: 52000, balance: 51500 })
    const daily = dailyExpense(month, oct)
    expect(daily).toHaveLength(31)
    expect(daily.reduce((a, b) => a + b, 0)).toBe(s.expense)
    const cats = byCategory(month, 'expense')
    expect(cats).toEqual([
      { categoryId: 'food', amount: 420 },
      { categoryId: 'transport', amount: 80 },
    ])
    expect(cats.reduce((a, c) => a + c.amount, 0)).toBe(s.expense)
  })

  it('compares the current month with the same days of last month', () => {
    const now = new Date(2026, 9, 10, 12)
    const mom = monthOverMonth(filterMonth(list, oct), filterMonth(list, { y: 2026, m: 8 }), oct, now)
    // Sep 1–10 spent 250; Oct 1–10 spent 500 → +100%
    expect(mom).toEqual({ pct: 100, previous: 250, sameRange: true })
    const past = monthOverMonth(filterMonth(list, oct), filterMonth(list, { y: 2026, m: 8 }), oct, new Date(2026, 11, 1))
    expect(past?.previous).toBe(5250)
    expect(past?.sameRange).toBe(false)
  })

  it('trend lists six months oldest first', () => {
    const t = trend(list, oct, 6)
    expect(t.map((x) => x.ym.m)).toEqual([4, 5, 6, 7, 8, 9])
    expect(t[4].expense).toBe(5250)
    expect(t[5].expense).toBe(500)
  })

  it('groups by local day, newest first', () => {
    const g = groupByDay(sortDesc(filterMonth(list, oct)))
    expect(g.map((x) => x.ymd)).toEqual(['2026-10-09', '2026-10-05', '2026-10-01'])
    expect(g[2].expense).toBe(200)
  })

  it('search matches text fields and exact amounts', () => {
    const names = { category: (id: string) => (id === 'food' ? '餐飲' : id), payment: () => '信用卡' }
    expect(searchTx(list, '路易莎', names)).toHaveLength(1)
    expect(searchTx(list, '餐飲', names)).toHaveLength(3)
    expect(searchTx(list, '52,000', names)).toHaveLength(1)
    expect(searchTx(list, '5', names).length).toBeGreaterThanOrEqual(0)
  })
})
