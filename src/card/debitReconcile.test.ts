import { describe, expect, it } from 'vitest'
import type { CardStatement, StatementEntry, Transaction } from '../db/types'
import { reconcile } from './reconcile'

const statement: CardStatement = {
  id: 'statement', paymentMethodId: 'debit', statementType: 'debit_card', accountId: 'bank', bank: '台新',
  statementMonth: '2026-10', periodStart: '2026-10-01', periodEnd: '2026-10-31', dueDate: null,
  fileHash: 'hash', fileName: 'sample.pdf', parseStatus: 'confirmed', adapter: 'taishin-debit-v1',
  batchId: 'batch', createdAt: '', updatedAt: '',
}

const entry = (id: string, kind: StatementEntry['kind'], amount: number, date: string): StatementEntry => ({
  id, statementId: statement.id, txDate: date, postDate: date, merchant: id, amount, kind,
  currency: 'TWD', foreign: null, reference: null, evidence: kind === 'purchase' ? 'both' : 'account', raw: id, order: 0,
})
const tx = (id: string, type: Transaction['type'], amount: number, date: string, paymentMethodId: string,
  rest: Partial<Transaction> = {}): Transaction => ({
  id, type, amount, merchant: id, categoryId: type === 'transfer' ? '' : 'other', paymentMethodId,
  occurredAt: `${date}T12:00:00.000+08:00`, note: '', source: 'manual', externalId: null,
  createdAt: '', updatedAt: '', ...rest,
})

describe('debit statement reconciliation', () => {
  it('matches unique card purchase, refund income, bank inflow and transfer without treating a withdrawal as a purchase', () => {
    const entries = [
      entry('buy', 'purchase', 220, '2026-10-01'),
      entry('refund', 'refund', -160, '2026-10-07'),
      entry('deposit', 'deposit', -500, '2026-10-09'),
      entry('out', 'transfer_out', 414, '2026-10-10'),
      entry('cash', 'withdrawal', 1000, '2026-10-12'),
    ]
    const transactions = [
      tx('buy-tx', 'expense', 220, '2026-10-01', 'debit', { sourceAccountId: 'bank' }),
      tx('refund-tx', 'income', 160, '2026-10-07', 'bank'),
      tx('deposit-tx', 'income', 500, '2026-10-09', 'bank'),
      tx('out-tx', 'transfer', 414, '2026-10-10', 'bank', { toAccountId: 'cash-account' }),
      tx('cash-tx', 'expense', 1000, '2026-10-12', 'debit', { sourceAccountId: 'bank' }),
    ]
    const result = reconcile({ statement, entries, transactions, recons: [] })
    expect(result.autoPairs.map((pair) => pair.transactionId).sort()).toEqual(['buy-tx', 'deposit-tx', 'out-tx', 'refund-tx'])
    expect(result.items.find((item) => 'entry' in item && item.entry.id === 'cash')?.kind).toBe('bank_only')
  })

  it('leaves repeated identical records for manual review', () => {
    const result = reconcile({ statement, entries: [entry('buy', 'purchase', 35, '2026-10-13')],
      transactions: [tx('a', 'expense', 35, '2026-10-13', 'debit', { sourceAccountId: 'bank' }), tx('b', 'expense', 35, '2026-10-13', 'debit', { sourceAccountId: 'bank' })], recons: [] })
    expect(result.autoPairs).toEqual([])
    expect(result.items[0]?.kind).toBe('ambiguous')
  })
  it('matches mobile payment charged to the selected debit card', () => {
    const result = reconcile({ statement, entries: [entry('mobile', 'purchase', 90, '2026-10-14')],
      transactions: [tx('apple', 'expense', 90, '2026-10-14', 'apple-pay', { cardId: 'debit' })], recons: [] })
    expect(result.autoPairs).toEqual([{ entryId: 'mobile', transactionId: 'apple' }])
  })
  it('does not automatically rematch an edited manually confirmed book record', () => {
    const changed = tx('book', 'income', 100, '2026-10-15', 'bank')
    const result = reconcile({ statement, entries: [entry('in', 'deposit', -100, '2026-10-14')],
      transactions: [changed], recons: [{ id: 'decision', statementId: statement.id, entryId: null,
        transactionId: changed.id, status: 'explained', method: 'manual',
        snapshot: { amount: 100, date: '2026-10-14', paymentMethodId: 'bank' },
        note: '人工確認', createdAt: '' }] })
    expect(result.autoPairs).toEqual([])
    expect(result.items.some((item) => item.kind === 'broken_explanation')).toBe(true)
  })
})
