import { expect, it } from 'vitest'
import type { PaymentMethod, StatementEntry, Transaction } from '../db/types'
import { searchReconTransactions } from './reconSearch'

const methods = [
  { id: 'card', type: 'credit_card' }, { id: 'other-card', type: 'credit_card' },
  { id: 'bank', type: 'bank' }, { id: 'cash', type: 'cash' }, { id: 'mobile', type: 'mobile' },
].map((p) => ({ ...p, name: p.id, isActive: true, sortOrder: 0 })) as PaymentMethod[]
const entry = { txDate: '2026-08-20', postDate: '2026-10-20', kind: 'purchase', merchant: '午餐', amount: 500 } as StatementEntry
const tx = (id: string, date: string, type: Transaction['type'], paymentMethodId: string, amount = 500): Transaction => ({
  id, type, amount, paymentMethodId, merchant: id, categoryId: type === 'transfer' ? '' : 'other',
  occurredAt: `${date}T12:00:00.000+08:00`, note: '', source: 'manual', externalId: null,
  createdAt: '', updatedAt: '',
})

it('searches the entry month, hides cash, wrong types and paired records, and keeps all eligible records', () => {
  const august = Array.from({ length: 35 }, (_, i) => tx(`商家${i}`, '2026-08-20', 'expense', i % 2 ? 'card' : 'bank'))
  const records = [tx('七月', '2026-07-30', 'expense', 'bank'), ...august,
    tx('已配對', '2026-08-20', 'expense', 'card'), tx('現金', '2026-08-20', 'expense', 'cash'),
    tx('收入', '2026-08-20', 'income', 'bank'), tx('互轉', '2026-08-20', 'transfer', 'bank'),
    tx('九月', '2026-09-01', 'expense', 'other-card'), tx('十月', '2026-10-20', 'expense', 'card')]
  const base = { entry, query: '', paymentMethods: methods, excludedIds: new Set(['已配對']) }
  expect(searchReconTransactions(records, { ...base, adjacentMonths: false })).toHaveLength(35)
  expect(searchReconTransactions(records, { ...base, adjacentMonths: true })).toHaveLength(37)
  expect(searchReconTransactions(records, { ...base, adjacentMonths: false, query: '商家3' }).map((t) => t.id)).toContain('商家3')
  expect(searchReconTransactions(records, { ...base, adjacentMonths: false, query: '2026-08-20' })).toHaveLength(35)
  const cashBacked = { ...tx('行動支付但從現金扣款', '2026-08-20', 'expense', 'mobile'), sourceAccountId: 'cash' }
  expect(searchReconTransactions([cashBacked], { ...base, adjacentMonths: false })).toEqual([])
})

it('uses posting month only when transaction date is absent, and requires a date', () => {
  const records = [tx('八月', '2026-08-20', 'expense', 'card'), tx('十月', '2026-10-20', 'expense', 'card')]
  const base = { query: '', adjacentMonths: false, paymentMethods: methods }
  expect(searchReconTransactions(records, { ...base, entry: { ...entry, txDate: null } }).map((t) => t.id)).toEqual(['十月'])
  expect(searchReconTransactions(records, { ...base, entry: { ...entry, txDate: null, postDate: null } })).toEqual([])
})

it('shows only a bank-to-cash transfer for a withdrawal', () => {
  const records = [
    { ...tx('提款互轉', '2026-08-20', 'transfer', 'bank'), toAccountId: 'cash' },
    tx('現金支出', '2026-08-20', 'expense', 'cash'),
    tx('銀行支出', '2026-08-20', 'expense', 'bank'),
  ]
  expect(searchReconTransactions(records, { entry: { ...entry, kind: 'withdrawal' },
    query: '', adjacentMonths: false, paymentMethods: methods }).map((t) => t.id)).toEqual(['提款互轉'])
})
