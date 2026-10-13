/*
 * Import planning for notification captures (D-83..D-85, D-128..D-131): parse, find where the money came
 * from, find duplicates, suggest a category. Pure: the UI shows the plan; card/cardRepo commits the
 * user's choices.
 */
import type { Category, PaymentMethod, TimeSource, Transaction } from '../db/types'
import { isAsset, isCard } from '../lib/accounts'
import { toYmd } from '../lib/dates'
import { isValidAmount } from '../lib/money'
import { suggestCategory, type MerchantHistory } from './categorize'
import type { NotificationCapture } from './notificationFile'
import type { NotificationAdapter } from './notificationAdapters'
import { parseNotification } from './notificationParser'

export type RowStatus = 'new' | 'suspect' | 'duplicate' | 'not_spending' | 'unparsed'

/** D-130: where a purchase through a 行動支付 took the money from: a card (預扣) or an account (直接扣). */
export interface PaySource {
  cardId?: string
  sourceAccountId?: string
  /** Display only: the debit card picked for an account source (D-129); not stored on the record. */
  via?: string
}

export interface PlanRow {
  capture: NotificationCapture
  status: RowStatus
  /** Why it is not a plain "new" row, in words the user understands. */
  reason: string
  amount: number
  merchant: string
  /** ISO purchase time (D-100). */
  occurredAt: string
  /** D-100: absent = exact. */
  timeSource?: TimeSource
  cardLast4: string | null
  /**
   * A card notice: the card from last4, the adapter's bank or the card remembered for this app; null = the
   * user must choose (D-84). A 行動支付 notice (D-130): the user's payment method of that name; null =
   * created when imported.
   */
  paymentMethodId: string | null
  categoryId: string
  /** Pre-selected for import: new rows yes, rows to check no (D-83). */
  include: boolean
  /** D-130: the 行動支付 the notice is about ("LINE Pay"); null for card notices. */
  channel: string | null
  /** D-130: where the money came from; its binding by default, changeable per row. null = not chosen yet. */
  source: PaySource | null
  /** True while `source` is still the payment method's binding (a preference, not proof). */
  sourceIsDefault: boolean
  /** No source yet: the user must pick one before this row can be imported. */
  needsSource: boolean
  /** Looks like a purchase already recorded (D-83, Q97). */
  duplicate: boolean
}

/**
 * D-83 / Q97 (2026-10-13): the same amount on the same local day is shown as a possible duplicate, whatever
 * the card or shop. It is only a hint: nothing is merged or dropped.
 */
export const DUP_RULES = {
  sameDay: true,
}

export interface PlanInput {
  captures: readonly NotificationCapture[]
  /**
   * captureIds already imported (any status). As a map, each with its content fingerprint: the same id with
   * a different fingerprint is a conflict (D-131), not a duplicate.
   */
  knownCaptureIds: ReadonlySet<string> | ReadonlyMap<string, string | undefined>
  /** Recent transactions to check for duplicates (any source). */
  transactions: readonly Transaction[]
  paymentMethods: readonly PaymentMethod[]
  categories: readonly Category[]
  history: readonly MerchantHistory[]
  /** Card remembered per source app (D-84): { "Richart Life": cardId }. */
  defaultCards: Readonly<Record<string, string>>
  /** Bank adapters; production uses the registry (tests pass their own). */
  adapters?: readonly NotificationAdapter[]
  /** D-128: guess from unknown wording (off in production). */
  generic?: boolean
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

function sameSpend(a: { amount: number; occurredAt: string }, b: { amount: number; occurredAt: string }) {
  return a.amount === b.amount && toYmd(new Date(a.occurredAt)) === toYmd(new Date(b.occurredAt))
}

const md = (iso: string) => {
  const t = new Date(iso)
  return `${t.getMonth() + 1}/${t.getDate()}`
}

/** D-130: the user's payment method for a 行動支付 (an active one first). */
export function channelMethod(name: RegExp, methods: readonly PaymentMethod[]): PaymentMethod | undefined {
  const all = methods.filter((p) => (p.type === 'mobile' || p.type === 'other') && name.test(p.name.trim()))
  return all.find((p) => p.isActive) ?? all[0]
}

/** D-130: its binding as a source: a card (預扣) or an account (直接扣); none if unbound or no longer usable. */
export function defaultSource(method: PaymentMethod | undefined, methods: readonly PaymentMethod[]): PaySource | null {
  const target = method?.boundTo ? methods.find((p) => p.id === method.boundTo && p.isActive) : undefined
  if (isCard(target)) return { cardId: target!.id }
  if (isAsset(target)) return { sourceAccountId: target!.id }
  return null
}

export function planImport(input: PlanInput): PlanRow[] {
  const now = input.now ?? new Date()
  const rows: PlanRow[] = []
  const seen = new Map<string, string>()
  for (const c of input.captures) {
    const fallbackTime = c.notificationTime ?? c.capturedAt ?? now.toISOString()
    const base = {
      capture: c,
      amount: 0,
      merchant: '',
      occurredAt: fallbackTime,
      cardLast4: null,
      paymentMethodId: null,
      categoryId: 'other',
      include: false,
      channel: null,
      source: null,
      sourceIsDefault: false,
      needsSource: false,
      duplicate: false,
    }
    const known = input.knownCaptureIds
    const prior = known instanceof Map ? known.get(c.captureId) : undefined
    const priorSeen = seen.get(c.captureId)
    if (known.has(c.captureId) || priorSeen !== undefined) {
      // D-131: the same id for different content is a broken shortcut, not the same notification.
      const other = priorSeen ?? prior
      if (other && other !== c.fingerprint) {
        rows.push({ ...base, status: 'unparsed', reason: '這則通知的編號和另一則已處理的通知相同，但內容不同，請檢查捷徑設定（每則通知要有自己的編號）' })
        continue
      }
      rows.push({ ...base, status: 'duplicate', reason: '這則通知已經匯入或處理過' })
      continue
    }
    seen.set(c.captureId, c.fingerprint)
    const r = parseNotification(c, input.adapters, { generic: input.generic })
    if (r.kind === 'not_spending') {
      rows.push({ ...base, status: 'not_spending', reason: r.reason })
      continue
    }
    if (r.kind === 'unparsed') {
      rows.push({ ...base, status: 'unparsed', reason: r.reason })
      continue
    }
    if (!isValidAmount(r.spend.amount)) {
      rows.push({ ...base, status: 'unparsed', reason: `金額 ${(r.spend.amount as number).toLocaleString('en-US')} 超出可以記錄的範圍，不會匯入` })
      continue
    }
    let occurredAt = r.spend.occurredAt ?? now.toISOString()
    const timeSource: TimeSource | undefined = r.spend.occurredAt ? r.spend.timeSource : 'date'
    if (Date.parse(occurredAt) > now.getTime()) occurredAt = now.toISOString()
    // D-130: a 行動支付 notice takes its source from the payment method's binding; a card notice is its card.
    const method = r.channel ? channelMethod(r.channel.name, input.paymentMethods) : undefined
    const source = r.channel ? defaultSource(method, input.paymentMethods) : null
    const card = r.channel ? null : cardFor(r.spend.cardLast4, r.bank, c.sourceApp, input)
    const row: PlanRow = {
      ...base,
      status: 'new',
      reason: '',
      amount: r.spend.amount,
      merchant: r.spend.merchant,
      occurredAt,
      ...(timeSource ? { timeSource } : {}),
      cardLast4: r.spend.cardLast4,
      paymentMethodId: r.channel ? (method?.id ?? null) : card,
      categoryId: suggestCategory(r.spend.merchant, input.history, input.categories),
      include: true,
      channel: r.channel?.label ?? null,
      source,
      sourceIsDefault: !!source,
      needsSource: !!r.channel && !source,
    }
    const me = { amount: row.amount, occurredAt }
    const dupTx = input.transactions.find((t) => t.type === 'expense' && sameSpend(me, t))
    const dupRow = rows.find((p) => (p.status === 'new' || p.status === 'suspect') && sameSpend(me, p))
    const reasons: string[] = []
    if (r.doubt) reasons.push(r.doubt)
    if (dupTx) reasons.push(`可能與 ${md(dupTx.occurredAt)} 的既有交易「${dupTx.merchant || '一筆支出'}」重複`)
    else if (dupRow) reasons.push(`和這次另一則通知同一天、同金額（「${dupRow.merchant || '一筆支出'}」），可能是同一筆`)
    if (row.needsSource) reasons.push(`還沒設定 ${row.channel} 的付款來源，請選一張卡或一個帳戶`)
    row.duplicate = !!dupTx || !!dupRow
    if (reasons.length) {
      row.status = 'suspect'
      row.reason = reasons.join('；')
      row.include = false
    }
    rows.push(row)
  }
  return rows
}
