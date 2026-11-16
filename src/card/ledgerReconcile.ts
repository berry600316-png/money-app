/** A book-led review of one imported statement. This does not change any transaction. */
import type { CardStatement, Reconciliation, StatementEntry, Transaction } from '../db/types'
import { chargedTo } from '../lib/accounts'
import { dayDiff, merchantSimilarity, SIMILAR_MERCHANT } from './text'
import { debitCandidate, debitRelevant } from './debitReconcile'
import { pairStillValid, txDate } from './reconcileCommon'
import type { Item, ReconcileInput, ReconcileResult } from './reconcile'

export interface LedgerProgress { bookDone: number; bookTotal: number; statementDone: number; statementTotal: number }
export type LedgerResult = ReconcileResult & { progress: LedgerProgress }

const related = (tx: Transaction, st: CardStatement) => st.statementType === 'debit_card'
  ? debitRelevant(tx, st.paymentMethodId, st.accountId ?? '')
  : (tx.type === 'expense' && chargedTo(tx) === st.paymentMethodId)
    || (tx.type === 'income' && tx.paymentMethodId === st.paymentMethodId)

const candidate = (entry: StatementEntry, tx: Transaction, st: CardStatement) => st.statementType === 'debit_card'
  ? debitCandidate(entry, tx, st.paymentMethodId, st.accountId ?? '')
  : (entry.kind === 'purchase' && tx.type === 'expense' && chargedTo(tx) === st.paymentMethodId)
    || (entry.kind === 'refund' && tx.type === 'income' && tx.paymentMethodId === st.paymentMethodId)

const closeDate = (entry: StatementEntry, tx: Transaction): boolean => {
  if (entry.txDate) return Math.abs(dayDiff(entry.txDate, txDate(tx))) <= 3
  return !!entry.postDate && Math.abs(dayDiff(entry.postDate, txDate(tx))) <= 7
}

const matchedOrExplained = (r: Reconciliation, tx: Transaction | undefined) =>
  (r.status === 'matched' || r.status === 'explained') && !pairStillValid(r, tx)

export function reconcileLedger(input: ReconcileInput): LedgerResult {
  const { statement: st, transactions, entries, recons } = input
  const mine = recons.filter((r) => r.statementId === st.id)
  const txById = new Map(transactions.map((t) => [t.id, t]))
  const reserved = new Set(recons.filter((r) => r.status === 'matched' && r.transactionId).map((r) => r.transactionId!))
  const items: Item[] = []
  const pending: StatementEntry[] = []
  for (const entry of [...entries].sort((a, b) => a.order - b.order)) {
    const pair = mine.find((r) => r.entryId === entry.id && r.status === 'matched')
    if (pair) {
      const tx = pair.transactionId ? txById.get(pair.transactionId) : undefined
      const reason = pairStillValid(pair, tx)
      if (reason) items.push({ kind: 'broken', entry, recon: pair, tx: tx ?? null, reason })
      else items.push({ kind: 'matched', entry, tx: tx!, recon: pair, auto: pair.method === 'auto' })
      continue
    }
    const explained = mine.find((r) => r.entryId === entry.id && r.status === 'explained' && !r.transactionId)
    if (explained) items.push({ kind: 'explained_entry', entry, recon: explained })
    else pending.push(entry)
  }

  // Only this statement's month is searched automatically. Adjacent months remain available in manual search.
  const available = transactions.filter((tx) => txDate(tx).slice(0, 7) === st.statementMonth && !reserved.has(tx.id))
  const choices = pending.map((entry) => ({ entry, options: available.filter((tx) =>
    candidate(entry, tx, st) && tx.amount === Math.abs(entry.amount) && closeDate(entry, tx)),
  }))
  const claimed = new Map<string, number>()
  for (const choice of choices) if (choice.options.length === 1) {
    const id = choice.options[0].id
    claimed.set(id, (claimed.get(id) ?? 0) + 1)
  }
  const autoPairs: ReconcileResult['autoPairs'] = []
  const taken = new Set<string>()
  for (const { entry, options } of choices) if (options.length === 1 && claimed.get(options[0].id) === 1) {
    const tx = options[0]
    autoPairs.push({ entryId: entry.id, transactionId: tx.id })
    taken.add(tx.id)
    items.push({ kind: 'matched', entry, tx, recon: null, auto: true })
  }
  for (const { entry, options } of choices) {
    if (autoPairs.some((p) => p.entryId === entry.id)) continue
    const open = options.filter((tx) => !taken.has(tx.id))
    if (open.length) {
      items.push({ kind: 'ambiguous', entry, candidates: open })
      continue
    }
    const near = available.filter((tx) => !taken.has(tx.id) && candidate(entry, tx, st) && closeDate(entry, tx)
      && merchantSimilarity(entry.merchant, tx.merchant) >= SIMILAR_MERCHANT
      && Math.abs(tx.amount - Math.abs(entry.amount)) <= Math.max(10, Math.abs(entry.amount) * 0.1))
    if (near.length === 1) items.push({ kind: 'amount_diff', entry, tx: near[0], diff: Math.abs(entry.amount) - near[0].amount })
    else if (near.length > 1) items.push({ kind: 'ambiguous', entry, candidates: near })
    else if (entry.kind === 'purchase' || st.statementType === 'debit_card') items.push({ kind: 'bank_only', entry })
    else items.push({ kind: 'special', entry })
  }

  const book = transactions.filter((tx) => related(tx, st) && txDate(tx).slice(0, 7) === st.statementMonth)
  const bookDone = book.filter((tx) => taken.has(tx.id) || recons.some((r) => r.transactionId === tx.id && matchedOrExplained(r, tx))).length
  const bookRelevant = book.filter((tx) => !reserved.has(tx.id) && !taken.has(tx.id)
    && !recons.some((r) => r.statementId !== st.id && r.transactionId === tx.id && r.status === 'explained' && !pairStillValid(r, tx)))
  const inDoubt = new Set<string>()
  for (const item of items) {
    if (item.kind === 'ambiguous') item.candidates.forEach((t) => inDoubt.add(t.id))
    else if (item.kind === 'amount_diff' || item.kind === 'broken') if (item.tx) inDoubt.add(item.tx.id)
  }
  for (const tx of bookRelevant) {
    const decision = mine.find((r) => r.transactionId === tx.id && !r.entryId)
    if (decision?.status === 'explained') {
      const reason = pairStillValid(decision, tx)
      if (reason) items.push({ kind: 'broken_explanation', tx, recon: decision, reason })
      else items.push({ kind: 'explained_tx', tx, recon: decision })
    } else if (decision?.status === 'deferred') items.push({ kind: 'pending_next', tx, why: 'deferred', recon: decision })
    else if (!inDoubt.has(tx.id)) items.push({ kind: 'book_only', tx })
  }
  const count = (kind: Item['kind']) => items.filter((item) => item.kind === kind).length
  const statementDone = count('matched') + count('explained_entry')
  return {
    items, autoPairs, payments: [], periodKnown: true,
    progress: { bookDone, bookTotal: book.length, statementDone, statementTotal: entries.length },
    summary: { entries: entries.length, matched: statementDone, bankOnly: count('bank_only'), bookOnly: count('book_only'),
      needsReview: count('ambiguous') + count('amount_diff') + count('special') + count('broken') + count('broken_explanation'), pendingNext: count('pending_next') },
  }
}
