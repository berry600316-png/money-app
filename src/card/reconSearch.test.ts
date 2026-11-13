import { expect, it } from 'vitest'
import type { StatementEntry, Transaction } from '../db/types'
import { searchReconTransactions } from './reconSearch'

const entry = { txDate: '2026-07-13', postDate: null, merchant: '午餐', amount: 500 } as StatementEntry
const tx = (id: string, date: string, type: Transaction['type'], paymentMethodId: string, amount = 500): Transaction => ({
  id, type, amount, paymentMethodId, merchant: id, categoryId: type === 'transfer' ? '' : 'other',
  occurredAt: `${date}T12:00:00.000+08:00`, note: '', source: 'manual', externalId: null,
  createdAt: '', updatedAt: '',
})

it('searches every record in the statement month across types and payment methods, without a 30-record cap', () => {
  const july = Array.from({ length: 35 }, (_, i) => tx(`商家${i}`, '2026-07-13', i % 3 === 0 ? 'income' : i % 3 === 1 ? 'transfer' : 'expense', 'cash'))
  const records = [tx('六月', '2026-06-30', 'expense', 'card'), ...july, tx('八月', '2026-08-01', 'expense', 'card')]
  const base = { statementMonth: '2026-07', entry, query: '' }
  expect(searchReconTransactions(records, { ...base, adjacentMonths: false })).toHaveLength(35)
  expect(searchReconTransactions(records, { ...base, adjacentMonths: true })).toHaveLength(37)
  expect(searchReconTransactions(records, { ...base, adjacentMonths: false, query: '商家3' }).map((t) => t.id)).toContain('商家3')
  expect(searchReconTransactions(records, { ...base, adjacentMonths: false, query: '2026-07-13' })).toHaveLength(35)
  expect(searchReconTransactions(records, { ...base, adjacentMonths: false, query: '500' })).toHaveLength(35)
})
