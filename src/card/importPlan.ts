/*
 * Import planning for notification captures (D-83..D-85): parse, map to a card, find duplicates,
 * suggest a category. Pure: the UI shows the plan; db/cardRepo commits the user's choices.
 */
import type { Category, PaymentMethod, Transaction } from '../db/types'
import { toYmd } from '../lib/dates'
import { suggestCategory, type MerchantHistory } from './categorize'
import type { NotificationCapture } from './notificationFile'
import type { NotificationAdapter } from './notificationAdapters'
import { parseNotification } from './notificationParser'
import { merchantSimilarity, SIMILAR_MERCHANT } from './text'

export type RowStatus = 'new' | 'suspect' | 'duplicate' | 'not_spending' | 'unparsed'

export interface PlanRow {
  capture: NotificationCapture
  status: RowStatus
  /** Why it is not a plain "new" row, in words the user understands. */
  reason: string
  amount: number
  merchant: string
  /** ISO purchase time (falls back to notification / capture time, then now). */
  occurredAt: string
  cardLast4: string | null
  /** Card from last4, the adapter's bank, or the card remembered for this app; null = the user must choose (D-84). */
  paymentMethodId: string | null
  categoryId: string
  /** Pre-selected for import: new rows yes, suspected duplicates no (D-83). */
  include: boolean
}

export const DUP_RULES = {
  /** Same card + same amount with notification times this close = same purchase. */
  minutes: 10,
}

export interface PlanInput {
  captures: readonly NotificationCapture[]
  /** captureIds already imported (any status). */
  knownCaptureIds: ReadonlySet<string>
  /** Recent transactions to check for duplicates (any source). */
  transactions: readonly Transaction[]
  paymentMethods: readonly PaymentMethod[]
  categories: readonly Category[]
  history: readonly MerchantHistory[]
  /** Card remembered per source app (D-84): { "Richart Life": cardId }. */
  defaultCards: Readonly<Record<string, string>>
  /** Bank adapters; production uses the registry (tests pass their own). */
  adapters?: readonly NotificationAdapter[]
  now?: Date
}

function cardFor(last4: string | null, bank: string | null, sourceApp: string, input: PlanInput): string | null {
  const cards = input.paymentMethods.filter((p) => p.type === 'credit_card' && p.isActive)
  if (last4) {
    const hit = cards.filter((p) => p.cardLast4 === last4)
    if (hit.length === 1) return hit[0].id
  }
  if (bank) {
    // The only active card of the adapter's bank.
    const hit = cards.filter((p) => p.bank && (p.bank.includes(bank) || bank.includes(p.bank)))
    if (hit.length === 1) return hit[0].id
  }
  const remembered = input.defaultCards[sourceApp]
  if (remembered && cards.some((p) => p.id === remembered)) return remembered
  return null
}

function sameSpend(a: { amount: number; occurredAt: string; merchant: string; card: string | null }, b: { amount: number; occurredAt: string; merchant: string; card: string | null }) {
  if (a.amount !== b.amount) return false
  if (a.card && b.card && a.card !== b.card) return false
  const minutes = Math.abs(Date.parse(a.occurredAt) - Date.parse(b.occurredAt)) / 60000
  if (minutes <= DUP_RULES.minutes) return true
  return toYmd(new Date(a.occurredAt)) === toYmd(new Date(b.occurredAt)) && !!a.merchant && !!b.merchant && merchantSimilarity(a.merchant, b.merchant) >= SIMILAR_MERCHANT
}

export function planImport(input: PlanInput): PlanRow[] {
  const now = input.now ?? new Date()
  const rows: PlanRow[] = []
  const seen = new Set<string>()
  for (const c of input.captures) {
    const fallbackTime = c.notificationTime ?? c.capturedAt ?? now.toISOString()
    const base = { capture: c, amount: 0, merchant: '', occurredAt: fallbackTime, cardLast4: null, paymentMethodId: null, categoryId: 'other', include: false }
    if (input.knownCaptureIds.has(c.captureId) || seen.has(c.captureId)) {
      rows.push({ ...base, status: 'duplicate', reason: '這則通知已經匯入過' })
      continue
    }
    seen.add(c.captureId)
    const r = parseNotification(c, input.adapters)
    if (r.kind === 'not_spending') {
      rows.push({ ...base, status: 'not_spending', reason: r.reason })
      continue
    }
    if (r.kind === 'unparsed') {
      rows.push({ ...base, status: 'unparsed', reason: r.reason })
      continue
    }
    let occurredAt = r.spend.occurredAt ?? fallbackTime
    if (Date.parse(occurredAt) > now.getTime()) occurredAt = now.toISOString()
    const card = cardFor(r.spend.cardLast4, r.bank, c.sourceApp, input)
    const row: PlanRow = {
      ...base,
      status: 'new',
      reason: '',
      amount: r.spend.amount,
      merchant: r.spend.merchant,
      occurredAt,
      cardLast4: r.spend.cardLast4,
      paymentMethodId: card,
      categoryId: suggestCategory(r.spend.merchant, input.history, input.categories),
      include: true,
    }
    const me = { amount: row.amount, occurredAt, merchant: row.merchant, card }
    const dupTx = input.transactions.find(
      (t) => t.type === 'expense' && sameSpend(me, { amount: t.amount, occurredAt: t.occurredAt, merchant: t.merchant, card: t.paymentMethodId }),
    )
    const dupRow = rows.find((p) => (p.status === 'new' || p.status === 'suspect') && sameSpend(me, { amount: p.amount, occurredAt: p.occurredAt, merchant: p.merchant, card: p.paymentMethodId }))
    if (r.doubt) {
      row.status = 'suspect'
      row.reason = r.doubt
      row.include = false
    } else if (dupTx) {
      row.status = 'suspect'
      row.reason = `可能和已記的「${dupTx.merchant || '一筆支出'}」是同一筆`
      row.include = false
    } else if (dupRow) {
      row.status = 'suspect'
      row.reason = '和這次另一則通知金額、時間相同'
      row.include = false
    }
    rows.push(row)
  }
  return rows
}
