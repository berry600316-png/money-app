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
const run = (entries: StatementEntry[], transactions: Transaction[], recons: Reconciliation[] = []) => reconcileLedger({ statement: st, statements: [st], entries, transactions, recons, paymentMethods: methods })

const deferred = (statementId: string, transactionId: string): Reconciliation => ({
  id: 'deferred', statementId, entryId: null, transactionId, status: 'deferred', method: 'manual', snapshot: null,
  note: '等待下期帳單', createdAt: '',
})

describe('book-led statement review', () => {
  it('keeps a deferred October record outside October completion, then automatically pairs the November posting', () => {
    const october = { ...st, statementMonth: '2026-10', periodStart: '2026-10-01', periodEnd: '2026-10-31' }
    const november = { ...st, id: 'next', statementMonth: '2026-11', periodStart: '2026-11-01', periodEnd: '2026-11-30' }
    const book = tx('purchase', '2026-10-25')
    const waiting = deferred(october.id, book.id)
    const oldResult = reconcileLedger({ statement: october, statements: [october, november], entries: [], transactions: [book], recons: [waiting], paymentMethods: methods })
    expect(oldResult.items.map((item) => item.kind)).toEqual(['pending_next'])
    expect(oldResult.progress).toEqual({ bookDone: 0, bookTotal: 0, statementDone: 0, statementTotal: 0 })
    const posted = { ...entry('e0', '2026-10-25'), statementId: november.id, postDate: '2026-11-01' }
    const nextResult = reconcileLedger({ statement: november, statements: [october, november], entries: [posted], transactions: [book], recons: [waiting], paymentMethods: methods })
    expect(nextResult.autoPairs).toEqual([{ entryId: posted.id, transactionId: book.id }])
    expect(nextResult.progress).toEqual({ bookDone: 0, bookTotal: 0, statementDone: 1, statementTotal: 1 })
  })

  it('shows a deferred record as missing in the next statement if it is still absent', () => {
    const november = { ...st, id: 'next', statementMonth: '2026-11' }
    const book = tx('purchase', '2026-10-25')
    const result = reconcileLedger({ statement: november, statements: [st, november], entries: [], transactions: [book], recons: [deferred(st.id, book.id)], paymentMethods: methods })
    expect(result.items.map((item) => item.kind)).toEqual(['book_only'])
    expect(result.progress).toEqual({ bookDone: 0, bookTotal: 0, statementDone: 0, statementTotal: 0 })
  })

  it('carries a debit-card purchase only to its own linked account statement', () => {
    const debit = { ...st, paymentMethodId: 'debit', statementType: 'debit_card' as const, accountId: 'bank' }
    const november = { ...debit, id: 'next', statementMonth: '2026-11' }
    const book = { ...tx('purchase', '2026-10-31', 100, 'debit'), sourceAccountId: 'bank' }
    const posted = { ...entry('e0', '2026-10-31'), statementId: november.id, txDate: null, postDate: '2026-11-01' }
    const result = reconcileLedger({ statement: november, statements: [debit, november], entries: [posted], transactions: [book],
      recons: [deferred(debit.id, book.id)], paymentMethods: [...methods, { id: 'debit', name: 'debit', type: 'debit_card', isActive: true, sortOrder: 0 }] })
    expect(result.autoPairs).toEqual([{ entryId: posted.id, transactionId: book.id }])
    const otherAccount = reconcileLedger({ statement: { ...november, accountId: 'other' }, statements: [debit, { ...november, accountId: 'other' }],
      entries: [posted], transactions: [book], recons: [deferred(debit.id, book.id)], paymentMethods: methods })
    expect(otherAccount.autoPairs).toEqual([])
  })
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

  it('pairs same-day purchases before nearby purchases of the same amount', () => {
    const entries = [
      { ...entry('e0', '2026-10-06', 35), merchant: '連加*統一超商' },
      { ...entry('e1', '2026-10-08', 35), merchant: '連加*統一超商' },
      { ...entry('e2', '2026-10-18', 179), merchant: '刷卡消費' },
      { ...entry('e3', '2026-10-19', 179), merchant: '連加*屈臣氏' },
    ]
    const books = [
      { ...tx('a', '2026-10-06', 35), merchant: '7-11' },
      { ...tx('b', '2026-10-08', 35), merchant: '7-11' },
      { ...tx('c', '2026-10-18', 179), merchant: '蝦皮' },
      { ...tx('d', '2026-10-19', 179), merchant: '屈臣氏' },
    ]
    expect(run(entries, books).autoPairs).toEqual([
      { entryId: 'e0', transactionId: 'a' }, { entryId: 'e1', transactionId: 'b' },
      { entryId: 'e2', transactionId: 'c' }, { entryId: 'e3', transactionId: 'd' },
    ])
  })

  it('uses a single clear same-day merchant match but leaves shared matches for review', () => {
    const named = { ...entry('e0', '2026-10-19', 179), merchant: '連加*屈臣氏' }
    const books = [{ ...tx('a', '2026-10-19', 179), merchant: '屈臣氏' }, { ...tx('b', '2026-10-19', 179), merchant: '蝦皮' }]
    expect(run([named], books).autoPairs).toEqual([{ entryId: 'e0', transactionId: 'a' }])
    expect(run([named, { ...named, id: 'e1' }], books).autoPairs).toEqual([])
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
