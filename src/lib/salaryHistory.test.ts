import { describe, expect, it } from 'vitest'
import { DEFAULT_SALARY_ITEMS } from '../db/defaults'
import type { Payslip } from '../db/types'
import {
  cellFor,
  deltaOf,
  draftToLines,
  editPayslipDraft,
  indexPayslips,
  latestValue,
  newPayslipDraft,
  periodMonths,
  periodStats,
  previousValue,
  defaultNewMonth,
  dropOldZeroLines,
} from './salaryHistory'

function slip(month: string, lines: [string, number, string?][], extra: Partial<Payslip> = {}): Payslip {
  return {
    id: 'p' + month,
    month,
    payDate: `${month}-28`,
    company: '星和科技',
    paymentMethodId: 'transfer',
    lines: lines.map(([itemId, amount, name]) => ({ itemId, amount, name: name ?? itemId })),
    transactionId: null,
    createdAt: '',
    updatedAt: '',
    ...extra,
  }
}

// Spec §3 example: performance bonus May–Oct 2026, with no payslip in March.
const perf: Record<string, number> = { '2026-01': 1200, '2026-02': 2500, '2026-04': 1600, '2026-05': 1000, '2026-06': 2000, '2026-07': 0, '2026-08': 2800, '2026-09': 1500, '2026-10': 3200 }
const slips = Object.entries(perf).map(([m, v]) =>
  slip(m, [
    ['BASE_SALARY', 45000],
    ['BONUS_PERFORMANCE', v, m < '2026-09' ? '績效獎金' : '績效考核獎金'],
    ...(m >= '2026-08' ? ([['POSITION_ALLOWANCE', 2000]] as [string, number][]) : []),
  ]),
)
const idx = indexPayslips(slips)

describe('cells: 0 vs no data (spec §6, D-143)', () => {
  it('a month without a payslip is a gap, never 0', () => {
    expect(cellFor('BONUS_PERFORMANCE', '2026-03', idx)).toEqual({ month: '2026-03', state: 'gap' })
  })
  it('a recorded 0 is a value', () => {
    expect(cellFor('BONUS_PERFORMANCE', '2026-07', idx)).toMatchObject({ state: 'value', amount: 0 })
  })
  it('D-143: a month whose payslip does not have the item is "none" (「—」), before or after it first appears; never 0', () => {
    expect(cellFor('POSITION_ALLOWANCE', '2026-07', idx)).toEqual({ month: '2026-07', state: 'none' })
    expect(cellFor('POSITION_ALLOWANCE', '2026-08', idx)).toMatchObject({ state: 'value', amount: 2000 })
    const withMissing = indexPayslips([...slips, slip('2026-11', [['BASE_SALARY', 45000]])])
    expect(cellFor('POSITION_ALLOWANCE', '2026-11', withMissing)).toEqual({ month: '2026-11', state: 'none' })
    // Averages and 較上次 skip it.
    const months = ['2026-08', '2026-09', '2026-10', '2026-11']
    const s = periodStats(months.map((m) => cellFor('POSITION_ALLOWANCE', m, withMissing)))
    expect([s.counted, s.average, s.none, s.gaps]).toEqual([3, 2000, 1, 0])
    expect(previousValue('POSITION_ALLOWANCE', '2026-12', withMissing)).toMatchObject({ month: '2026-10', amount: 2000 })
  })
  it('keeps the name the month was saved with', () => {
    expect(cellFor('BONUS_PERFORMANCE', '2026-05', idx)).toMatchObject({ name: '績效獎金' })
  })
})

describe('deltas (D-70)', () => {
  it('matches the spec example: Oct 3,200 vs Sep 1,500 = +1,700 (+113.3%)', () => {
    const latest = latestValue('BONUS_PERFORMANCE', idx)!
    expect(latest).toMatchObject({ month: '2026-10', amount: 3200 })
    expect(deltaOf(latest.amount, previousValue('BONUS_PERFORMANCE', '2026-10', idx))).toEqual({ diff: 1700, pct: 113.3, prevMonth: '2026-09' })
  })
  it('previous 0 gives the amount only, no percentage', () => {
    expect(deltaOf(2800, previousValue('BONUS_PERFORMANCE', '2026-08', idx))).toEqual({ diff: 2800, pct: null, prevMonth: '2026-07' })
  })
  it('skips gaps and names the month compared with', () => {
    expect(deltaOf(1600, previousValue('BONUS_PERFORMANCE', '2026-04', idx))?.prevMonth).toBe('2026-02')
  })
  it('no previous record → no delta', () => {
    expect(deltaOf(1200, previousValue('BONUS_PERFORMANCE', '2026-01', idx))).toBeNull()
    expect(deltaOf(2000, previousValue('POSITION_ALLOWANCE', '2026-08', idx))).toBeNull()
  })
})

describe('periods and stats (D-71, D-72)', () => {
  it('6 months ending at the latest payslip, 0 counted', () => {
    const months = periodMonths('6', idx)
    expect(months).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
    const s = periodStats(months.map((m) => cellFor('BONUS_PERFORMANCE', m, idx)))
    expect(s).toMatchObject({ total: 10500, counted: 6, average: 1750, gaps: 0 })
  })
  it('gaps are excluded from the average denominator', () => {
    const months = periodMonths('12', idx)
    expect(months[0]).toBe('2025-11')
    const s = periodStats(months.map((m) => cellFor('BONUS_PERFORMANCE', m, idx)))
    // Nov, Dec 2025 have no payslip at all; Mar 2026 is a gap → 9 counted
    expect(s).toMatchObject({ counted: 9, gaps: 3, total: 15800 })
    expect(s.average).toBe(Math.round(15800 / 9))
  })
  it('"before" months are not counted either', () => {
    const s = periodStats(periodMonths('6', idx).map((m) => cellFor('POSITION_ALLOWANCE', m, idx)))
    expect(s).toMatchObject({ counted: 3, total: 6000, average: 2000 })
  })
  it('custom range works in either order', () => {
    expect(periodMonths('custom', idx, { from: '2026-09', to: '2026-07' })).toEqual(['2026-07', '2026-08', '2026-09'])
  })
})

describe('new payslip defaults (D-62, D-63)', () => {
  const items = DEFAULT_SALARY_ITEMS
  const prev = slip('2026-09', [['BASE_SALARY', 45000], ['BONUS_PERFORMANCE', 1500], ['LABOR_INSURANCE', 1145]], { payDate: '2026-10-05', company: '星和科技', paymentMethodId: 'transfer' })

  it('month defaults to the one after the latest payslip, or this month', () => {
    expect(defaultNewMonth([prev])).toBe('2026-10')
    expect(defaultNewMonth([], new Date(2026, 9, 10))).toBe('2026-10')
  })
  it('fixed items copy the previous payslip, variable items start empty', () => {
    const d = newPayslipDraft('2026-10', [prev], items, 'cash', new Date(2026, 10, 20))
    expect(d.lines.find((l) => l.itemId === 'BASE_SALARY')?.amount).toBe('45000')
    expect(d.lines.find((l) => l.itemId === 'BONUS_PERFORMANCE')?.amount).toBe('')
    expect(d.lines.find((l) => l.itemId === 'LABOR_INSURANCE')?.amount).toBe('1145')
    expect(d.lines.find((l) => l.itemId === 'HEALTH_INSURANCE')?.amount).toBe('') // fixed, but not on the previous slip
    expect(d).toMatchObject({ payDate: '2026-11-05', company: '星和科技', paymentMethodId: 'transfer' })
  })
  it('keeps the previous payslip\'s pay pattern (same month vs next month)', () => {
    const sameMonth = { ...prev, month: '2026-08', payDate: '2026-08-25' }
    expect(newPayslipDraft('2026-09', [sameMonth], items, 'cash', new Date(2026, 9, 10)).payDate).toBe('2026-09-25')
    expect(newPayslipDraft('2026-10', [prev], items, 'cash', new Date(2026, 10, 20)).payDate).toBe('2026-11-05')
  })
  it('pay date never defaults to the future and clamps to the month length', () => {
    expect(newPayslipDraft('2026-10', [prev], items, 'cash', new Date(2026, 10, 2)).payDate).toBe('2026-11-02')
    const end31 = { ...prev, payDate: '2026-10-31' }
    expect(newPayslipDraft('2026-10', [end31], items, 'cash', new Date(2026, 11, 20)).payDate).toBe('2026-11-30')
  })
  it('D-143: empty = the month does not have the item (new or edited); 0 typed = the item with 0', () => {
    const draft = editPayslipDraft(prev, items)
    expect(draft.lines.filter((l) => l.onSlip)).toHaveLength(3)
    expect(draftToLines(draft).map((l) => l.itemId)).toEqual(['BASE_SALARY', 'BONUS_PERFORMANCE', 'LABOR_INSURANCE'])
    draft.lines.find((l) => l.itemId === 'OVERTIME_PAY')!.amount = '0'
    expect(draftToLines(draft).find((l) => l.itemId === 'OVERTIME_PAY')).toEqual({ itemId: 'OVERTIME_PAY', amount: 0 })
    // An item that was on the payslip, emptied: taken off.
    draft.lines.find((l) => l.itemId === 'BONUS_PERFORMANCE')!.amount = ''
    expect(draftToLines(draft).map((l) => l.itemId)).not.toContain('BONUS_PERFORMANCE')
    // A new payslip keeps only what is filled in: fixed items copied from the last one, variable ones empty.
    const fresh = newPayslipDraft('2026-10', [prev], items, 'cash', new Date(2026, 10, 20))
    const filled = fresh.lines.filter((l) => l.amount !== '').map((l) => l.itemId)
    expect(draftToLines(fresh).map((l) => l.itemId)).toEqual(filled)
    expect(draftToLines(fresh).every((l) => items.find((i) => i.id === l.itemId)!.nature === 'fixed')).toBe(true)
  })
  it('D-143: an old payslip\'s 0 meant "left empty"; a 0 with a note stays', () => {
    expect(dropOldZeroLines([{ amount: 0 }, { amount: 5 }, { amount: 0, note: '這月沒加班' }, { amount: 0, note: '' }])).toEqual([{ amount: 5 }, { amount: 0, note: '這月沒加班' }])
  })
})
