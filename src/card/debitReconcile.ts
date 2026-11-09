import type { StatementEntry, Transaction } from '../db/types'
import { chargedTo } from '../lib/accounts'
import { dayDiff } from './text'
import type { ReconcileInput, ReconcileResult, Item } from './reconcile'
import { pairStillValid, txDate } from './reconcileCommon'

export function debitCandidate(entry: StatementEntry, tx: Transaction, cardId: string, accountId: string): boolean {
  if (entry.kind === 'purchase') return tx.type === 'expense' && (
    tx.cardId === cardId || (tx.paymentMethodId === cardId && tx.sourceAccountId === accountId))
  if (entry.kind === 'refund') return tx.type === 'income' && tx.paymentMethodId === accountId
  if (entry.kind === 'deposit') return (tx.type === 'income' && tx.paymentMethodId === accountId)
    || (tx.type === 'transfer' && tx.toAccountId === accountId)
  if (entry.kind === 'transfer_out') return (tx.type === 'transfer' && tx.paymentMethodId === accountId)
    || (tx.type === 'expense' && (tx.paymentMethodId === accountId || tx.sourceAccountId === accountId))
  if (entry.kind === 'fee') return tx.type === 'expense' && (tx.paymentMethodId === accountId || tx.sourceAccountId === accountId)
  return false // Cash withdrawals are never guessed to be a card purchase.
}

function closeEnough(entry: StatementEntry, tx: Transaction): boolean {
  const booked = txDate(tx)
  if (entry.txDate && Math.abs(dayDiff(entry.txDate, booked)) <= 3) return true
  return !!entry.postDate && Math.abs(dayDiff(entry.postDate, booked)) <= 7
}

export function debitRelevant(tx: Transaction, cardId: string, accountId: string): boolean {
  if (tx.type === 'expense') return chargedTo(tx) === cardId || tx.paymentMethodId === accountId || tx.sourceAccountId === accountId
  if (tx.type === 'income') return tx.paymentMethodId === accountId
  return tx.paymentMethodId === accountId || tx.toAccountId === accountId
}

/** Separate from credit-card reconciliation: a debit PDF covers card purchases AND bank flows. */
export function reconcileDebit(input: ReconcileInput): ReconcileResult {
  const { statement, entries, transactions, recons } = input
  const accountId = statement.accountId ?? ''
  const mine = recons.filter((r) => r.statementId === statement.id)
  const txById = new Map(transactions.map((tx) => [tx.id, tx]))
  const used = new Set(recons.filter((r) => r.status === 'matched' && r.transactionId).map((r) => r.transactionId!))
  const explainedTx = new Map(mine.filter((r) => r.status === 'explained' && r.transactionId && !r.entryId)
    .map((r) => [r.transactionId!, r]))
  const items: Item[] = []
  const open: StatementEntry[] = []

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
    else open.push(entry)
  }

  const available = transactions.filter((tx) => debitRelevant(tx, statement.paymentMethodId, accountId) && !used.has(tx.id)
    && !explainedTx.has(tx.id))
  const choices = open.map((entry) => ({ entry, candidates: available.filter((tx) =>
    debitCandidate(entry, tx, statement.paymentMethodId, accountId)
      && tx.amount === Math.abs(entry.amount) && closeEnough(entry, tx)),
  }))
  const picked = new Map<string, number>()
  for (const c of choices) if (c.candidates.length === 1) {
    const id = c.candidates[0].id
    picked.set(id, (picked.get(id) ?? 0) + 1)
  }
  const autoPairs: ReconcileResult['autoPairs'] = []
  const taken = new Set<string>()
  for (const { entry, candidates } of choices) {
    if (candidates.length === 1 && picked.get(candidates[0].id) === 1) {
      const tx = candidates[0]
      autoPairs.push({ entryId: entry.id, transactionId: tx.id })
      items.push({ kind: 'matched', entry, tx, recon: null, auto: true })
      taken.add(tx.id)
    } else if (candidates.length > 0) items.push({ kind: 'ambiguous', entry, candidates })
    else items.push({ kind: 'bank_only', entry })
  }

  const periodKnown = !!(statement.periodStart && statement.periodEnd)
  const reserved = new Set([...used, ...taken])
  for (const item of items) if (item.kind === 'ambiguous') item.candidates.forEach((tx) => reserved.add(tx.id))
  for (const tx of transactions.filter((t) => (debitRelevant(t, statement.paymentMethodId, accountId) || explainedTx.has(t.id)) && !used.has(t.id))) {
    const explained = explainedTx.get(tx.id)
    const invalid = explained ? pairStillValid(explained, tx) : null
    if (explained && invalid) items.push({ kind: 'broken_explanation', tx, recon: explained, reason: invalid })
    else if (explained) items.push({ kind: 'explained_tx', tx, recon: explained })
    else if (periodKnown && txDate(tx) >= statement.periodStart! && txDate(tx) <= statement.periodEnd! && !reserved.has(tx.id))
      items.push({ kind: 'book_only', tx })
  }

  const count = (kind: Item['kind']) => items.filter((item) => item.kind === kind).length
  return {
    items, autoPairs, payments: [], periodKnown,
    summary: { entries: entries.length, matched: count('matched') + count('explained_entry'),
      bankOnly: count('bank_only'), bookOnly: periodKnown ? count('book_only') : null,
      needsReview: count('ambiguous') + count('broken') + count('broken_explanation'), pendingNext: 0 },
  }
}
