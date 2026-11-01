import { describe, expect, it } from 'vitest'
import type { BalanceAdjustment, PaymentMethod, Transaction } from '../db/types'
import { monthlyCashflow } from './monthlyCashflow'
import { localIso } from './dates'

const account = (id: string, type: PaymentMethod['type'] = 'bank'): PaymentMethod => ({ id, name: id, type, isActive: true, sortOrder: 0 })
const tx = (id: string, type: Transaction['type'], amount: number, month: number, paymentMethodId: string, extra: Partial<Transaction> = {}): Transaction => ({
  id, type, amount, paymentMethodId, toAccountId: undefined, merchant: '', categoryId: '',
  occurredAt: localIso(`2026-${String(month).padStart(2, '0')}-12`, '12:00'), note: '', source: 'manual',
  externalId: null, createdAt: '', updatedAt: '', ...extra,
})

describe('monthly cashflow', () => {
  it('keeps historical months independent while showing transfer and spending by account', () => {
    const methods = [account('A'), account('B')]
    const list = [tx('old', 'income', 10000, 10, 'A'), tx('move', 'transfer', 8000, 11, 'A', { toAccountId: 'B' }), tx('spend', 'expense', 3000, 11, 'A')]
    const oct = monthlyCashflow({ y: 2026, m: 9 }, methods, list, [])
    const nov = monthlyCashflow({ y: 2026, m: 10 }, methods, list, [])
    expect(oct.totals.balance).toBe(10000)
    expect(oct.accounts.find((a) => a.id === 'A')?.movement).toBe(10000)
    expect(nov.totals).toEqual({ income: 0, expense: 3000, balance: -3000 })
    expect(nov.accounts.find((a) => a.id === 'A')).toMatchObject({ expense: -3000, transfer: -8000, movement: -11000 })
    expect(nov.accounts.find((a) => a.id === 'B')).toMatchObject({ transfer: 8000, movement: 8000 })
  })

  it('counts card purchases once and card payment only as movement in its month', () => {
    const methods = [account('bank'), account('card', 'credit_card')]
    const list = [tx('buy', 'expense', 3000, 10, 'card'), tx('pay', 'transfer', 3000, 11, 'bank', { toAccountId: 'card' })]
    const oct = monthlyCashflow({ y: 2026, m: 9 }, methods, list, [])
    const nov = monthlyCashflow({ y: 2026, m: 10 }, methods, list, [])
    expect(oct.totals.expense).toBe(3000)
    expect(oct.cards[0]).toMatchObject({ expense: 3000, movement: 3000 })
    expect(oct.accounts).toEqual([])
    expect(nov.totals.expense).toBe(0)
    expect(nov.accounts[0].movement).toBe(-3000)
    expect(nov.cards[0].movement).toBe(-3000)
  })

  it('keeps unassigned spending in totals and adjustments separate', () => {
    const methods = [account('bank'), account('wallet', 'mobile')]
    const list = [tx('unknown', 'expense', 500, 11, 'wallet'), tx('income', 'income', 200, 11, 'wallet')]
    const adjustments: BalanceAdjustment[] = [{ id: 'adj', accountId: 'bank', occurredAt: localIso('2026-11-15', '12:00'), before: 0, after: 100, delta: 100, note: '', createdAt: '' }]
    const nov = monthlyCashflow({ y: 2026, m: 10 }, methods, list, adjustments)
    expect(nov.totals.balance).toBe(-300)
    expect(nov.unassigned).toMatchObject({ income: 200, expense: -500, movement: -300, transactionIds: ['unknown', 'income'] })
    expect(nov.accounts[0]).toMatchObject({ id: 'bank', movement: 0, adjustment: 100 })
  })

  it('recalculates a corrected past record and keeps inactive accounts with activity', () => {
    const methods = [{ ...account('old'), isActive: false }]
    const original = tx('entry', 'expense', 300, 10, 'old')
    const corrected = { ...original, amount: 500 }
    expect(monthlyCashflow({ y: 2026, m: 9 }, methods, [original], []).totals.balance).toBe(-300)
    const report = monthlyCashflow({ y: 2026, m: 9 }, methods, [corrected], [])
    expect(report.totals.balance).toBe(-500)
    expect(report.accounts[0]).toMatchObject({ id: 'old', movement: -500 })
    expect(monthlyCashflow({ y: 2026, m: 10 }, methods, [corrected], []).accounts).toEqual([])
  })

  it('retains activity when opposite transfers cancel out', () => {
    const methods = [account('A'), account('B')]
    const list = [tx('out', 'transfer', 1000, 11, 'A', { toAccountId: 'B' }), tx('back', 'transfer', 1000, 11, 'B', { toAccountId: 'A' })]
    const nov = monthlyCashflow({ y: 2026, m: 10 }, methods, list, [])
    expect(nov.totals.balance).toBe(0)
    expect(nov.accounts.find((a) => a.id === 'A')).toMatchObject({ movement: 0, transactionIds: ['out', 'back'] })
  })
})
