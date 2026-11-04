import { describe, expect, it } from 'vitest'
import type { PaymentMethod, Transaction } from '../db/types'
import { localIso } from './dates'
import { computeFunding, fundingMonthReport } from './funding'

const account = (id: string, type: PaymentMethod['type'] = 'cash', extra: Partial<PaymentMethod> = {}): PaymentMethod => ({ id, name: id, type, isActive: true, sortOrder: 0, ...extra })
const tx = (id: string, type: Transaction['type'], amount: number, month: number, paymentMethodId: string, extra: Partial<Transaction> = {}): Transaction => ({
  id, type, amount, paymentMethodId, merchant: '', categoryId: '', occurredAt: localIso(`2026-${String(month).padStart(2, '0')}-12`, '12:00'),
  note: '', source: 'manual', externalId: null, createdAt: '', updatedAt: '', ...extra,
})
const bank = account('bank', 'bank')
const oct = { y: 2026, m: 9 }
const nov = { y: 2026, m: 10 }

describe('funding month ledger', () => {
  it('moves only explicitly assigned spending into an earlier month', () => {
    const list = [tx('income', 'income', 1000, 10, 'bank'), tx('spend', 'expense', 500, 11, 'bank', { funding: [{ month: '2026-10', amount: 300 }, { month: '2026-11', amount: 200 }] })]
    const result = computeFunding([bank], list)
    expect(result.issue).toBeNull()
    expect(result.buckets.get('2026-10|bank')).toMatchObject({ earned: 700, opening: 0 })
    expect(result.allocations.get('spend')).toEqual([{ month: '2026-10', amount: 300, earnedAmount: 300 }, { month: '2026-11', amount: 200, earnedAmount: 200 }])
    expect(fundingMonthReport(result.transactions, oct)).toEqual({ income: 1000, expense: 300, balance: 700, openingUsed: 0 })
    expect(fundingMonthReport(result.transactions, nov)).toEqual({ income: 0, expense: 200, balance: -200, openingUsed: 0 })
  })

  it('uses earned money before opening money, without counting opening money as income', () => {
    const cash = account('cash', 'cash', { balanceFrom: localIso('2026-10-01', '00:00'), openingBalance: 400, openingFundingMonth: '2026-10' })
    const list = [tx('income', 'income', 600, 10, 'cash'), tx('spend', 'expense', 800, 11, 'cash', { funding: [{ month: '2026-10', amount: 800 }] })]
    const result = computeFunding([cash], list)
    expect(result.issue).toBeNull()
    expect(result.allocations.get('spend')).toEqual([{ month: '2026-10', amount: 800, earnedAmount: 600 }])
    expect(fundingMonthReport(result.transactions, oct)).toEqual({ income: 600, expense: 600, balance: 0, openingUsed: 200 })
    expect(result.buckets.get('2026-10|cash')).toMatchObject({ earned: 0, opening: 200 })
  })

  it('keeps transfer in its source month and charges the fee to the earliest month', () => {
    const cash = account('cash')
    const list = [tx('oct-income', 'income', 1000, 10, 'cash'), tx('nov-income', 'income', 200, 11, 'cash'),
      tx('move', 'transfer', 500, 11, 'cash', { toAccountId: 'bank', funding: [{ month: '2026-10', amount: 300 }, { month: '2026-11', amount: 200 }] }),
      tx('fee', 'expense', 15, 11, 'cash', { feeOf: 'move', funding: [{ month: '2026-10', amount: 15 }] })]
    const result = computeFunding([cash, bank], list)
    expect(result.issue).toBeNull()
    expect(result.buckets.get('2026-10|cash')?.earned).toBe(685)
    expect(result.buckets.get('2026-10|bank')?.earned).toBe(300)
    expect(fundingMonthReport(result.transactions, oct).balance).toBe(985)
  })

  it('blocks an old-month source-account overdraft but permits ordinary current-month negatives', () => {
    const list = [tx('income', 'income', 200, 10, 'bank'), tx('ordinary', 'expense', 300, 11, 'bank'), tx('cross', 'expense', 300, 11, 'bank', { funding: [{ month: '2026-10', amount: 300 }] })]
    const result = computeFunding([bank], list)
    expect(result.issue).toMatchObject({ transactionId: 'cross', month: '2026-10', accountId: 'bank', available: 200, needed: 300 })
    expect(computeFunding([bank], list.slice(0, 2)).issue).toBeNull()
  })

  it('reserves linked-bank funds when swiping a card and does not spend them again on payment', () => {
    const card = account('card', 'credit_card', { payFromId: 'bank' })
    const list = [tx('income', 'income', 1000, 10, 'bank'), tx('buy', 'expense', 300, 11, 'card', { funding: [{ month: '2026-10', amount: 300 }] }), tx('pay', 'transfer', 300, 11, 'bank', { toAccountId: 'card' })]
    const result = computeFunding([bank, card], list)
    expect(result.issue).toBeNull()
    expect(result.buckets.get('2026-10|bank')?.earned).toBe(700)
    expect(fundingMonthReport(result.transactions, oct).expense).toBe(300)
    expect(fundingMonthReport(result.transactions, nov).expense).toBe(0)
  })
})
