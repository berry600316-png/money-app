import { describe, expect, it } from 'vitest'
import type { StatementEntry, Transaction } from '../db/types'
import type { Item } from './reconcile'
import { sortReconItems } from './reconSort'

const entry = (id: string, merchant: string, txDate: string | null, postDate: string | null = null): Item => ({
  kind: 'bank_only',
  entry: { id, statementId: 'statement', txDate, postDate, merchant, amount: 100, currency: 'TWD', foreign: null,
    reference: null, kind: 'purchase', raw: '', order: 0 } satisfies StatementEntry,
})

const book = (id: string, merchant: string, day: string): Item => ({
  kind: 'book_only',
  tx: { id, type: 'expense', amount: 100, merchant, categoryId: 'food', paymentMethodId: 'card',
    occurredAt: new Date(`${day}T12:00:00+08:00`).toISOString(), note: '', source: 'manual', externalId: null,
    createdAt: '', updatedAt: '' } satisfies Transaction,
})

const ids = (items: Item[]) => items.map((item) => 'entry' in item ? item.entry.id : item.tx.id)

describe('reconciliation list order', () => {
  it('sorts statement entries oldest first using transaction date, then posting date', () => {
    const items = [entry('new', '乙', '2026-10-04'), entry('posted', '甲', null, '2026-10-02'),
      entry('old', '丙', '2026-10-01', '2026-10-09')]
    expect(ids(sortReconItems(items))).toEqual(['old', 'posted', 'new'])
    expect(ids(items)).toEqual(['new', 'posted', 'old'])
  })

  it('sorts book-only items by book date and same-day merchant name', () => {
    expect(ids(sortReconItems([book('b', 'B', '2026-10-03'), book('c', 'C', '2026-10-01'),
      book('a', 'A', '2026-10-03')]))).toEqual(['c', 'a', 'b'])
  })

  it('keeps same-day same-name order and puts missing dates last', () => {
    expect(ids(sortReconItems([entry('missing', '甲', null), entry('second', '甲', '2026-10-01'),
      entry('first', '甲', '2026-10-01')]))).toEqual(['second', 'first', 'missing'])
  })
})
