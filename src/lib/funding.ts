import type { FundingAllocation, PaymentMethod, Transaction } from '../db/types'
import { isAsset, isCard, isDebit, isMethod } from './accounts'
import { isInMonth, type YearMonth } from './dates'

export interface FundingBucket { earned: number; opening: number }
export interface FundingIssue {
  transactionId: string
  month: string
  accountId: string
  available: number
  needed: number
}

const monthOf = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const bucketKey = (month: string, accountId: string) => `${month}|${accountId}`
const isValidMonth = (month: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month)

/** Account from which a purchase ultimately draws money. Cards reserve money at their linked bank. */
export function fundingSource(t: Pick<Transaction, 'type' | 'paymentMethodId' | 'sourceAccountId' | 'cardId' | 'toAccountId'>, byId: ReadonlyMap<string, PaymentMethod>): string | null {
  const p = byId.get(t.paymentMethodId)
  if (t.type === 'transfer') return isAsset(p) ? p!.id : null
  if (t.type !== 'expense') return null
  if (t.cardId) {
    const card = byId.get(t.cardId)
    if (isCard(card)) return card!.payFromId ?? null
    if (isDebit(card)) return card!.payFromId ?? null
  }
  if (isCard(p) || isDebit(p)) return p!.payFromId ?? null
  if (isMethod(p)) return t.sourceAccountId ?? null
  return isAsset(p) ? p!.id : null
}

interface Reserve { month: string; accountId: string; amount: number; earned: number }

/** Replays actual operations in time order while carrying each source month's earned and opening funds. */
export function computeFunding(methods: readonly PaymentMethod[], records: readonly Transaction[]) {
  const byId = new Map(methods.map((m) => [m.id, m]))
  const buckets = new Map<string, FundingBucket>()
  const allocations = new Map<string, FundingAllocation[]>()
  const resolved = new Map<string, Transaction>()
  const reserves = new Map<string, Reserve[]>()
  let issue: FundingIssue | null = null
  const get = (month: string, id: string) => {
    const key = bucketKey(month, id)
    let bucket = buckets.get(key)
    if (!bucket) { bucket = { earned: 0, opening: 0 }; buckets.set(key, bucket) }
    return bucket
  }
  const eligible = (id: string, at: string) => {
    const method = byId.get(id)
    return !!method && isAsset(method) && (!method.balanceFrom || at >= method.balanceFrom)
  }
  const events: { at: string; kind: 'opening' | 'transaction'; method?: PaymentMethod; tx?: Transaction }[] = [
    ...methods.filter((m) => isAsset(m) && m.balanceFrom && m.openingBalance !== undefined).map((method) => ({ at: method.balanceFrom!, kind: 'opening' as const, method })),
    ...records.map((tx) => ({ at: tx.occurredAt, kind: 'transaction' as const, tx })),
  ]
  events.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === 'opening' ? -1 : b.kind === 'opening' ? 1 : a.tx?.feeOf === b.tx?.id ? 1 : b.tx?.feeOf === a.tx?.id ? -1 : 0))

  for (const event of events) {
    if (event.kind === 'opening') {
      const m = event.method!
      get(m.openingFundingMonth ?? monthOf(m.balanceFrom!), m.id).opening += m.openingBalance!
      continue
    }
    const t = event.tx!
    const operationMonth = monthOf(t.occurredAt)
    if (t.type === 'income') {
      if (eligible(t.paymentMethodId, t.occurredAt)) get(operationMonth, t.paymentMethodId).earned += t.amount
      resolved.set(t.id, t)
      continue
    }
    const sourceId = fundingSource(t, byId)
    const source = sourceId && eligible(sourceId, t.occurredAt) ? sourceId : null
    const cardId = t.type === 'expense' ? (t.cardId && isCard(byId.get(t.cardId)) ? t.cardId : isCard(byId.get(t.paymentMethodId)) ? t.paymentMethodId : null) : null

    // A card bill settles earlier reserved charges. The unreserved remainder (e.g. a card opening balance)
    // leaves the paying bank this month, but is never a second expense.
    if (t.type === 'transfer' && isCard(byId.get(t.toAccountId ?? ''))) {
      let remaining = t.amount
      const queue = reserves.get(t.toAccountId!) ?? []
      while (remaining > 0 && queue.length) {
        const first = queue[0]
        const used = Math.min(remaining, first.amount)
        const earned = Math.min(first.earned, used)
        if (source && first.accountId !== source) {
          const original = get(first.month, first.accountId)
          const paying = get(first.month, source)
          if (first.month < operationMonth && (paying.earned + paying.opening < used || paying.earned < earned || paying.opening < used - earned)) {
            issue = { transactionId: t.id, month: first.month, accountId: source, available: Math.max(0, paying.earned + paying.opening), needed: used }
            break
          }
          original.earned += earned
          original.opening += used - earned
          paying.earned -= earned
          paying.opening -= used - earned
        }
        first.amount -= used
        first.earned -= earned
        remaining -= used
        if (first.amount === 0) queue.shift()
      }
      if (issue) break
      if (source && remaining) get(operationMonth, source).opening -= remaining
      resolved.set(t.id, t)
      continue
    }

    if (!t.funding?.length) {
      if (source) {
        const from = get(operationMonth, source)
        if (t.type === 'expense') {
          from.earned -= t.amount
          if (cardId) {
            const list = reserves.get(cardId) ?? []
            list.push({ month: operationMonth, accountId: source, amount: t.amount, earned: t.amount })
            reserves.set(cardId, list)
          }
        } else if (t.toAccountId && eligible(t.toAccountId, t.occurredAt)) {
          const earned = Math.min(t.amount, Math.max(0, from.earned))
          from.earned -= earned
          from.opening -= t.amount - earned
          const to = get(operationMonth, t.toAccountId)
          to.earned += earned
          to.opening += t.amount - earned
        }
      }
      resolved.set(t.id, t)
      continue
    }

    const total = t.funding.reduce((sum, a) => sum + a.amount, 0)
    if (t.funding.length === 0 || total !== t.amount || !source || t.funding.some((a) => !isValidMonth(a.month) || a.month > operationMonth || !Number.isSafeInteger(a.amount) || a.amount <= 0) || new Set(t.funding.map((a) => a.month)).size !== t.funding.length) {
      const a = t.funding[0]
      issue = { transactionId: t.id, month: a?.month ?? operationMonth, accountId: source ?? '', available: 0, needed: a?.amount ?? t.amount }
      break
    }
    const normalized: FundingAllocation[] = []
    for (const allocation of t.funding) {
      const from = get(allocation.month, source)
      const old = allocation.month < operationMonth
      const earnedAvailable = Math.max(0, from.earned)
      const available = Math.max(0, from.earned + from.opening)
      // Re-evaluate the provenance when earlier records change. Income added to the old month
      // before this operation must be used before opening funds, even for a saved allocation.
      const earned = old ? Math.min(earnedAvailable, allocation.amount) : allocation.amount
      const opening = allocation.amount - earned
      if (earned < 0 || earned > allocation.amount || !Number.isSafeInteger(earned) || (old && (allocation.amount > available || earned > earnedAvailable || opening > available - earnedAvailable))) {
        issue = { transactionId: t.id, month: allocation.month, accountId: source, available, needed: allocation.amount }
        break
      }
      from.earned -= earned
      from.opening -= opening
      normalized.push({ month: allocation.month, amount: allocation.amount, earnedAmount: earned })
      if (t.type === 'transfer' && t.toAccountId && eligible(t.toAccountId, t.occurredAt)) {
        const to = get(allocation.month, t.toAccountId)
        to.earned += earned
        to.opening += opening
      }
      if (cardId) {
        const list = reserves.get(cardId) ?? []
        list.push({ month: allocation.month, accountId: source, amount: allocation.amount, earned })
        reserves.set(cardId, list)
      }
    }
    if (issue) break
    allocations.set(t.id, normalized)
    resolved.set(t.id, { ...t, funding: normalized })
  }

  return { buckets, allocations, issue, transactions: records.map((t) => resolved.get(t.id) ?? t) }
}

/** Monthly income and spending by funding month. Actual-day lists still use `summarize`. */
export function fundingMonthReport(records: readonly Transaction[], month: YearMonth) {
  const key = `${month.y}-${String(month.m + 1).padStart(2, '0')}`
  let income = 0
  let expense = 0
  let openingUsed = 0
  for (const t of records) {
    if (t.type === 'income') {
      if (isInMonth(t.occurredAt, month)) income += t.amount
    } else if (t.type === 'expense') {
      if (t.funding?.length) {
        for (const a of t.funding) if (a.month === key) {
          if (key === monthOf(t.occurredAt)) expense += a.amount
          else { expense += a.earnedAmount ?? a.amount; openingUsed += a.amount - (a.earnedAmount ?? a.amount) }
        }
      } else if (isInMonth(t.occurredAt, month)) expense += t.amount
    }
  }
  return { income, expense, balance: income - expense, openingUsed }
}

/** Income/expense slices for the selected funding month, for existing category and chart helpers. */
export function fundingMonthEntries(records: readonly Transaction[], month: YearMonth): Transaction[] {
  const key = fundingMonthKey(month)
  const entries: Transaction[] = []
  for (const t of records) {
    if (t.type === 'income') {
      if (isInMonth(t.occurredAt, month)) entries.push(t)
    } else if (t.type === 'expense') {
      if (!t.funding?.length) {
        if (isInMonth(t.occurredAt, month)) entries.push(t)
      } else {
        const slice = t.funding.find((a) => a.month === key)
        const amount = slice ? (key === monthOf(t.occurredAt) ? slice.amount : slice.earnedAmount ?? slice.amount) : 0
        if (amount > 0) entries.push({ ...t, amount, occurredAt: key === monthOf(t.occurredAt) ? t.occurredAt : new Date(month.y, month.m, Math.min(new Date(t.occurredAt).getDate(), new Date(month.y, month.m + 1, 0).getDate()), 12).toISOString() })
      }
    }
  }
  return entries
}

export function fundingAvailable(bucket: FundingBucket | undefined): number {
  return bucket ? bucket.earned + bucket.opening : 0
}

export function fundingMonthKey(ym: YearMonth): string {
  return `${ym.y}-${String(ym.m + 1).padStart(2, '0')}`
}
