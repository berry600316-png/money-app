import type { PaymentMethod, StatementEntry, Transaction } from '../db/types'
import { effectsOf } from '../lib/accounts'
import { txDate } from './reconcileCommon'

/** The purchase date owns the candidate month; posting date is a fallback, never the statement label. */
export const entryDate = (entry: StatementEntry): string | null => entry.txDate ?? entry.postDate

export const inEntryMonth = (entry: StatementEntry, tx: Transaction): boolean => {
  const date = entryDate(entry)
  return !!date && txDate(tx).slice(0, 7) === date.slice(0, 7)
}

export type MethodLookup = (id: string) => PaymentMethod | undefined

const cashEffect = (tx: Transaction, byId: MethodLookup): boolean =>
  effectsOf(tx, byId).some((effect) => byId(effect.accountId)?.type === 'cash')

/** Manual choices may use another card or bank, but never a cash flow for a card/bank purchase. */
export function candidateForEntry(entry: StatementEntry, tx: Transaction, byId: MethodLookup): boolean {
  if (entry.kind === 'withdrawal') return tx.type === 'transfer'
    && byId(tx.paymentMethodId)?.type === 'bank' && byId(tx.toAccountId ?? '')?.type === 'cash'
  if (cashEffect(tx, byId)) return false
  switch (entry.kind) {
    case 'purchase':
    case 'fee':
    case 'installment': return tx.type === 'expense'
    case 'refund': return tx.type === 'income'
    case 'deposit': return tx.type === 'income' || tx.type === 'transfer'
    case 'transfer_out': return tx.type === 'expense' || tx.type === 'transfer'
    case 'payment': return tx.type === 'transfer'
    case 'adjustment':
    case 'other': return true
  }
}

/** Flows with a clear book type can be matched; unclassified and bill-payment lines stay manual. */
export const autoCandidateForEntry = (entry: StatementEntry, tx: Transaction, byId: MethodLookup): boolean =>
  !['payment', 'adjustment', 'other'].includes(entry.kind)
  && candidateForEntry(entry, tx, byId)
