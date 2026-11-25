import { describe, expect, it } from 'vitest'
import type { CardStatement, PaymentMethod, Reconciliation, StatementEntry, Transaction } from '../db/types'
import { reconcileLedger } from './ledgerReconcile'

const month = '2026-10'
const st: CardStatement = { id: 'st', paymentMethodId: 'card', statementMonth: month, periodStart: '2026-09-16', periodEnd: '2026-10-15',
  bank: '銀行', dueDate: null, fileHash: 'hash', fileName: 'bill.pdf', parseStatus: 'needs_review', adapter: 'test', batchId: 'batch', createdAt: '', updatedAt: '' }
const tx = (id: string, day: string, amount = 100, paymentMethodId = 'card'): Transaction => ({
  id, type: 'expense', amount, merchant: id, categoryId: 'food', paymentMethodId, occurredAt: new Date(`${day}T12:00:00+08:00`).toISOString(),
  note: '', source: 'manual', externalId: null, createdAt: '', updatedAt: '',
})
const entry = (id: string, day: string, amount = 100, kind: StatementEntry['kind'] = 'purchase'): StatementEntry => ({
  id, statementId: st.id, txDate: day, postDate: null, merchant: id, amount, currency: 'TWD', foreign: null, reference: null, kind, raw: '', order: Number(id.slice(1)) || 0,
})
const methods = [
  { id: 'card', type: 'credit_card' }, { id: 'other', type: 'credit_card' }, { id: 'bank', type: 'bank' }, { id: 'cash', type: 'cash' },
  { id: 'mobile', type: 'mobile' },
].map((p) => ({ ...p, name: p.id, isActive: true, sortOrder: 0 })) as PaymentMethod[]
const run = (entries: StatementEntry[], transactions: Transaction[], recons: Reconciliation[] = []) => reconcileLedger({ statement: st, entries, transactions, recons, paymentMethods: methods })

describe('book-led statement review', () => {
  it('counts all statement flows, while only related transactions in the labelled month form the book denominator', () => {
    const result = run([entry('e0', '2026-10-05'), entry('e1', '2026-10-07', -100, 'payment')],
      [tx('book', '2026-10-05'), tx('other-card', '2026-10-05', 200, 'other'), tx('old', '2026-09-20')])
    expect(result.autoPairs).toEqual([{ entryId: 'e0', transactionId: 'book' }])
    expect(result.items.find((i) => 'entry' in i && i.entry.id === 'e1')?.kind).toBe('special')
    expect(result.progress).toEqual({ bookDone: 1, bookTotal: 1, statementDone: 1, statementTotal: 2 })
  })

  it('a manual cross-month pair resolves the statement side without increasing this month book progress', () => {
    const old = tx('old', '2026-09-20')
    const recon: Reconciliation = { id: 'r', statementId: st.id, entryId: 'e0', transactionId: old.id, status: 'matched', method: 'manual',
      snapshot: { amount: 100, date: '2026-09-20', paymentMethodId: 'card' }, note: '', createdAt: '' }
    const result = run([entry('e0', '2026-10-01')], [old], [recon])
    expect(result.items[0].kind).toBe('matched')
    expect(result.progress).toEqual({ bookDone: 0, bookTotal: 0, statementDone: 1, statementTotal: 1 })
  })

  it('manual confirmation counts the book but leaves the statement unresolved; editing the book revokes its mark', () => {
    const book = tx('book', '2026-10-05')
    const recon: Reconciliation = { id: 'r', statementId: st.id, entryId: null, transactionId: book.id, status: 'explained', method: 'manual',
      snapshot: { amount: 100, date: '2026-10-05', paymentMethodId: 'card', merchant: 'book' }, note: '', createdAt: '' }
    expect(run([], [book], [recon]).progress.bookDone).toBe(1)
    const changed = run([], [{ ...book, merchant: 'changed' }], [recon])
    expect(changed.progress.bookDone).toBe(0)
    expect(changed.items[0].kind).toBe('broken_explanation')
  })

  it('does not list a transaction already confirmed against another statement as missing again', () => {
    const book = tx('book', '2026-10-05')
    const recon: Reconciliation = { id: 'other-decision', statementId: 'other-statement', entryId: null, transactionId: book.id,
      status: 'explained', method: 'manual', snapshot: { amount: 100, date: '2026-10-05', paymentMethodId: 'card', merchant: 'book' }, note: '', createdAt: '' }
    const result = run([], [book], [recon])
    expect(result.progress).toEqual({ bookDone: 1, bookTotal: 1, statementDone: 0, statementTotal: 0 })
    expect(result.items).toEqual([])
  })

  it('automatically matches a unique card refund to income on the same card', () => {
    const refund = { ...tx('refund', '2026-10-05'), type: 'income' as const }
    const result = run([entry('e0', '2026-10-05', -100, 'refund')], [refund])
    expect(result.autoPairs).toEqual([{ entryId: 'e0', transactionId: refund.id }])
    expect(result.progress).toEqual({ bookDone: 1, bookTotal: 1, statementDone: 1, statementTotal: 1 })
  })

  it('matches an August purchase imported in an October statement to an August non-cash record', () => {
    const result = run([entry('e0', '2026-08-20')], [tx('august-bank', '2026-08-23', 100, 'bank'), tx('october', '2026-10-20')])
    expect(result.autoPairs).toEqual([{ entryId: 'e0', transactionId: 'august-bank' }])
    expect(result.progress.bookDone).toBe(0)
  })

  it('does not match cash, a different month or a shared candidate automatically', () => {
    expect(run([entry('e0', '2026-08-20')], [tx('cash', '2026-08-20', 100, 'cash')]).autoPairs).toEqual([])
    expect(run([entry('e0', '2026-08-20')], [{ ...tx('cash-backed-mobile', '2026-08-20', 100, 'mobile'), sourceAccountId: 'cash' }]).autoPairs).toEqual([])
    expect(run([entry('e0', '2026-08-31')], [tx('september', '2026-09-01')]).autoPairs).toEqual([])
    expect(run([entry('e0', '2026-08-20'), entry('e1', '2026-08-20')], [tx('shared', '2026-08-20', 100, 'bank')]).autoPairs).toEqual([])
    const oneOfTwo = run([entry('e0', '2026-08-20'), entry('e1', '2026-08-23')],
      [tx('shared', '2026-08-20', 100, 'bank'), tx('another', '2026-08-17', 100, 'other')])
    expect(oneOfTwo.autoPairs).toEqual([])
  })

  it('uses posting date only if there is no transaction date, with a three-day limit', () => {
    const posted = { ...entry('e0', '2026-08-20'), txDate: null, postDate: '2026-08-23' }
    expect(run([posted], [tx('near', '2026-08-20', 100, 'other')]).autoPairs).toHaveLength(1)
    expect(run([posted], [tx('far', '2026-08-19', 100, 'other')]).autoPairs).toEqual([])
  })

  it('can match a unique withdrawal to a bank-to-cash transfer and an installment to an expense', () => {
    const withdrawal = { ...tx('bank-to-cash', '2026-08-20', 100, 'bank'), type: 'transfer' as const, toAccountId: 'cash' }
    expect(run([entry('e0', '2026-08-20', 100, 'withdrawal')], [withdrawal]).autoPairs)
      .toEqual([{ entryId: 'e0', transactionId: withdrawal.id }])
    expect(run([entry('e0', '2026-08-20', 100, 'installment')], [tx('installment', '2026-08-20', 100, 'other')]).autoPairs)
      .toEqual([{ entryId: 'e0', transactionId: 'installment' }])
  })
})
