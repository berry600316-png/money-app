/*
 * Reconciliation engine (spec §7, D-89..D-92). Pure: given a statement, its entries, the card's
 * transactions and the saved decisions, say what is matched, what is missing on which side, and
 * what needs a person. Never writes; never changes a transaction.
 */
import type { CardStatement, Reconciliation, StatementEntry, Transaction } from '../db/types'
import { chargedTo } from '../lib/accounts'
import { toYmd } from '../lib/dates'
import { dayDiff, merchantSimilarity, SIMILAR_MERCHANT } from './text'

/** All matching tolerances in one place (D-89, D-91). Change here, re-run src/card/reconcile.test.ts. */
export const RECONCILE_RULES = {
  /** Max days between the purchase date on the statement and the purchase date in Money. */
  txDateDays: 3,
  /** Same, when the statement only shows a posting date. */
  postDateDays: 7,
  /** Same purchase on the same or next day counts as reliable even if the names differ. */
  sameDayDays: 1,
  /** Amount-mismatch suggestions: at most this share of the statement amount… */
  diffRatio: 0.1,
  /** …and at least this many dollars. */
  diffMinimum: 10,
  /** Unmatched purchases this close to the closing date may simply post next time. */
  nearCloseDays: 5,
}

export type Item =
  | { kind: 'matched'; entry: StatementEntry; tx: Transaction; recon: Reconciliation | null; auto: boolean }
  /** A saved pair whose transaction was edited or deleted afterwards (D-92). */
  | { kind: 'broken'; entry: StatementEntry; recon: Reconciliation; tx: Transaction | null; reason: string }
  | { kind: 'bank_only'; entry: StatementEntry }
  | { kind: 'amount_diff'; entry: StatementEntry; tx: Transaction; diff: number }
  | { kind: 'ambiguous'; entry: StatementEntry; candidates: Transaction[] }
  /** Refund, fee, installment, adjustment…: never auto-matched (D-90). */
  | { kind: 'special'; entry: StatementEntry }
  | { kind: 'explained_entry'; entry: StatementEntry; recon: Reconciliation }
  | { kind: 'book_only'; tx: Transaction }
  | { kind: 'pending_next'; tx: Transaction; why: 'deferred' | 'near_close'; recon: Reconciliation | null }
  | { kind: 'explained_tx'; tx: Transaction; recon: Reconciliation }

export interface ReconcileInput {
  statement: CardStatement
  entries: readonly StatementEntry[]
  /** Expense transactions of this card (any date). */
  transactions: readonly Transaction[]
  /** Decisions from ALL statements: a transaction already paired elsewhere is not available here. */
  recons: readonly Reconciliation[]
}

export interface ReconcileResult {
  items: Item[]
  /** New reliable pairs found this run; the caller saves them as method 'auto'. */
  autoPairs: { entryId: string; transactionId: string }[]
  /** Card payments listed on the statement: shown as statement info, not reconciled. */
  payments: StatementEntry[]
  /** Billing cycle known → "record only" can be judged (D-91). */
  periodKnown: boolean
  summary: {
    /** Basis for the progress figure: statement entries other than payments. */
    entries: number
    matched: number
    bankOnly: number
    /** null when the billing cycle is not known. */
    bookOnly: number | null
    needsReview: number
    pendingNext: number
  }
}

export const txDate = (t: Transaction) => toYmd(new Date(t.occurredAt))

/** Is a saved pair still true to the transaction as it is now? */
export function pairStillValid(recon: Reconciliation, tx: Transaction | undefined): string | null {
  if (!tx) return '這筆記帳已被刪除'
  const s = recon.snapshot
  if (!s) return null
  if (s.amount !== tx.amount) return '記帳金額在核對後被修改'
  if (s.date !== txDate(tx)) return '記帳日期在核對後被修改'
  if (s.paymentMethodId !== chargedTo(tx)) return '記帳的付款方式在核對後被修改'
  return null
}

function entryDays(entry: StatementEntry, tx: Transaction): number | null {
  if (entry.txDate) {
    const d = Math.abs(dayDiff(entry.txDate, txDate(tx)))
    return d <= RECONCILE_RULES.txDateDays ? d : null
  }
  if (entry.postDate) {
    const d = dayDiff(txDate(tx), entry.postDate) // posting happens on/after the purchase
    return d >= -1 && d <= RECONCILE_RULES.postDateDays ? Math.abs(d) : null
  }
  return null
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { statement, entries } = input
  const txById = new Map(input.transactions.map((t) => [t.id, t]))
  const mine = input.recons.filter((r) => r.statementId === statement.id)
  const items: Item[] = []
  const payments: StatementEntry[] = []

  // Transactions already paired with a still-valid statement entry anywhere are unavailable.
  // A broken pair still holds its record until the user decides, so it is never offered elsewhere.
  const used = new Set<string>()
  for (const r of input.recons) if (r.status === 'matched' && r.transactionId && r.entryId) used.add(r.transactionId)

  const pending: StatementEntry[] = []
  for (const e of [...entries].sort((a, b) => a.order - b.order)) {
    if (e.kind === 'payment') {
      payments.push(e)
      continue
    }
    const pair = mine.find((r) => r.entryId === e.id && r.status === 'matched')
    if (pair) {
      const tx = pair.transactionId ? txById.get(pair.transactionId) : undefined
      const broken = pairStillValid(pair, tx)
      if (broken) items.push({ kind: 'broken', entry: e, recon: pair, tx: tx ?? null, reason: broken })
      else items.push({ kind: 'matched', entry: e, tx: tx!, recon: pair, auto: pair.method === 'auto' })
      continue
    }
    const note = mine.find((r) => r.entryId === e.id && r.status === 'explained' && !r.transactionId)
    if (note) {
      items.push({ kind: 'explained_entry', entry: e, recon: note })
      continue
    }
    if (e.kind !== 'purchase') {
      items.push({ kind: 'special', entry: e })
      continue
    }
    pending.push(e)
  }

  // Candidates per entry: same card (a 行動支付 charged to it counts too, D-125), exact amount, date within tolerance.
  const available = input.transactions.filter((t) => t.type === 'expense' && chargedTo(t) === statement.paymentMethodId && !used.has(t.id))
  type Choice = { entry: StatementEntry; candidates: Transaction[]; pick: Transaction | null }
  const choices: Choice[] = pending.map((entry) => {
    const candidates = available.filter((t) => t.amount === entry.amount && entryDays(entry, t) !== null)
    let pick: Transaction | null = null
    if (candidates.length === 1) {
      const t = candidates[0]
      if (merchantSimilarity(t.merchant, entry.merchant) >= SIMILAR_MERCHANT || (entryDays(entry, t) ?? 99) <= RECONCILE_RULES.sameDayDays) pick = t
    } else if (candidates.length > 1) {
      const strong = candidates.filter((t) => merchantSimilarity(t.merchant, entry.merchant) >= SIMILAR_MERCHANT)
      if (strong.length === 1) pick = strong[0]
    }
    return { entry, candidates, pick }
  })
  // A transaction picked by two entries is not reliable for either (D-90: never choose at random).
  const pickedBy = new Map<string, number>()
  for (const c of choices) if (c.pick) pickedBy.set(c.pick.id, (pickedBy.get(c.pick.id) ?? 0) + 1)
  const autoPairs: { entryId: string; transactionId: string }[] = []
  const taken = new Set<string>()
  for (const c of choices) {
    if (c.pick && pickedBy.get(c.pick.id) === 1) {
      autoPairs.push({ entryId: c.entry.id, transactionId: c.pick.id })
      taken.add(c.pick.id)
      items.push({ kind: 'matched', entry: c.entry, tx: c.pick, recon: null, auto: true })
    }
  }
  for (const c of choices) {
    if (c.pick && pickedBy.get(c.pick.id) === 1) continue
    const open = c.candidates.filter((t) => !taken.has(t.id))
    if (open.length) {
      items.push({ kind: 'ambiguous', entry: c.entry, candidates: open })
      continue
    }
    // No exact amount: a same-card, near-date, similar-name purchase with a small difference?
    const near = available.filter(
      (t) =>
        !taken.has(t.id) &&
        entryDays(c.entry, t) !== null &&
        merchantSimilarity(t.merchant, c.entry.merchant) >= SIMILAR_MERCHANT &&
        Math.abs(t.amount - c.entry.amount) <= Math.max(RECONCILE_RULES.diffMinimum, Math.abs(c.entry.amount) * RECONCILE_RULES.diffRatio),
    )
    if (near.length === 1) items.push({ kind: 'amount_diff', entry: c.entry, tx: near[0], diff: c.entry.amount - near[0].amount })
    else if (near.length > 1) items.push({ kind: 'ambiguous', entry: c.entry, candidates: near })
    else items.push({ kind: 'bank_only', entry: c.entry })
  }

  // Record side: purchases dated within the billing cycle that nothing on any statement accounts for.
  const periodKnown = !!(statement.periodStart && statement.periodEnd)
  if (periodKnown) {
    const inUse = new Set<string>([...used, ...taken])
    for (const it of items) if ((it.kind === 'amount_diff' || it.kind === 'broken') && it.tx) inUse.add(it.tx.id)
    for (const it of items) if (it.kind === 'ambiguous') it.candidates.forEach((t) => inUse.add(t.id))
    for (const t of available) {
      const d = txDate(t)
      if (d < statement.periodStart! || d > statement.periodEnd! || inUse.has(t.id)) continue
      const deferred = input.recons.find((r) => r.transactionId === t.id && r.status === 'deferred')
      const explained = mine.find((r) => r.transactionId === t.id && r.status === 'explained' && !r.entryId)
      if (explained) items.push({ kind: 'explained_tx', tx: t, recon: explained })
      else if (deferred) items.push({ kind: 'pending_next', tx: t, why: 'deferred', recon: deferred })
      else if (dayDiff(d, statement.periodEnd!) < RECONCILE_RULES.nearCloseDays) items.push({ kind: 'pending_next', tx: t, why: 'near_close', recon: null })
      else items.push({ kind: 'book_only', tx: t })
    }
  }

  const count = (k: Item['kind']) => items.filter((i) => i.kind === k).length
  return {
    items,
    autoPairs,
    payments,
    periodKnown,
    summary: {
      entries: entries.filter((e) => e.kind !== 'payment').length,
      matched: count('matched') + count('explained_entry'),
      bankOnly: count('bank_only'),
      bookOnly: periodKnown ? count('book_only') : null,
      needsReview: count('ambiguous') + count('amount_diff') + count('special') + count('broken'),
      pendingNext: count('pending_next'),
    },
  }
}
