/*
 * D-117..D-121: account balances. Pure functions over the same transactions every other screen uses,
 * so a balance can always be re-derived (nothing is stored but the opening balance and corrections).
 *
 *  - bank / cash / stored value: money in the account.
 *  - credit card: 預扣 (spent with the card, bill not paid yet). Paying the bill is a transfer to the card.
 *  - 轉帳 / 行動支付 / 其他: not accounts; an expense paid with them names the account the money left.
 *
 * Only what happens on or after an account's start date counts, so older records (made before the
 * user had accounts) never distort a balance (D-118).
 */
import type { BalanceAdjustment, PaymentMethod, Transaction } from '../db/types'
import { isAssetType, isMethodType } from '../db/types'
import { fromYmd, toYmd } from './dates'

export const isAsset = (p: Pick<PaymentMethod, 'type'> | undefined) => !!p && isAssetType(p.type)
export const isCard = (p: Pick<PaymentMethod, 'type'> | undefined) => !!p && p.type === 'credit_card'
export const isMethod = (p: Pick<PaymentMethod, 'type'> | undefined) => !!p && isMethodType(p.type)
/** An account whose balance is being counted. */
export const isTracked = (p: Pick<PaymentMethod, 'balanceFrom' | 'openingBalance'> | undefined) =>
  !!p && typeof p.balanceFrom === 'string' && typeof p.openingBalance === 'number'

/**
 * D-118: where counting starts for a balance entered for `ymd`: today = this very moment (the amount is
 * what the account holds now), an earlier day = that day's local midnight.
 */
export function startInstant(ymd: string, now = new Date()): string {
  // +1 ms: the amount typed now already includes everything recorded up to this very moment.
  return ymd === toYmd(now) ? new Date(now.getTime() + 1).toISOString() : fromYmd(ymd).toISOString()
}

/** One change to one account caused by a record. Assets: money (+in / −out). Cards: 預扣 (+more owed). */
export interface Effect {
  accountId: string
  delta: number
}

/** What a transaction does to each account it touches (before start dates are applied). */
export function effectsOf(t: Transaction, byId: (id: string) => PaymentMethod | undefined): Effect[] {
  const p = byId(t.paymentMethodId)
  if (t.type === 'transfer') {
    const out: Effect[] = [{ accountId: t.paymentMethodId, delta: -t.amount }]
    if (t.toAccountId) {
      const to = byId(t.toAccountId)
      out.push({ accountId: t.toAccountId, delta: isCard(to) ? -t.amount : t.amount })
    }
    return out
  }
  // Income goes into accounts that hold money. Income filed under a card or a way to pay (older records
  // kept 信用卡 as their default) moves no balance at all, instead of making 預扣 go negative.
  if (t.type === 'income') return isAsset(p) ? [{ accountId: t.paymentMethodId, delta: t.amount }] : []
  // expense
  if (isCard(p)) return [{ accountId: t.paymentMethodId, delta: t.amount }]
  if (isMethod(p)) return t.sourceAccountId ? [{ accountId: t.sourceAccountId, delta: -t.amount }] : []
  return [{ accountId: t.paymentMethodId, delta: -t.amount }]
}

/**
 * Current balance of every tracked account (cards: their 預扣). Accounts without a start date are
 * absent from the map: "尚未設定餘額".
 */
export function computeBalances(
  accounts: readonly PaymentMethod[],
  transactions: readonly Transaction[],
  adjustments: readonly BalanceAdjustment[],
): Map<string, number> {
  const byIdMap = new Map(accounts.map((a) => [a.id, a]))
  const byId = (id: string) => byIdMap.get(id)
  const start = new Map<string, string>()
  const bal = new Map<string, number>()
  for (const a of accounts) {
    if (!isTracked(a) || isMethod(a)) continue
    start.set(a.id, a.balanceFrom!)
    bal.set(a.id, a.openingBalance!)
  }
  const apply = (accountId: string, delta: number, at: string) => {
    const s = start.get(accountId)
    if (s === undefined || at < s) return
    bal.set(accountId, bal.get(accountId)! + delta)
  }
  for (const t of transactions) for (const e of effectsOf(t, byId)) apply(e.accountId, e.delta, t.occurredAt)
  for (const a of adjustments) apply(a.accountId, a.delta, a.occurredAt)
  return bal
}

export interface AccountsOverview {
  /** Sum of tracked bank / cash / stored-value balances. */
  total: number
  /** Sum of tracked cards' 預扣. */
  pending: number
  /** Active accounts and cards still without a start balance. */
  unset: PaymentMethod[]
}

export function overview(accounts: readonly PaymentMethod[], balances: ReadonlyMap<string, number>): AccountsOverview {
  let total = 0
  let pending = 0
  const unset: PaymentMethod[] = []
  for (const a of accounts) {
    if (isMethod(a)) continue
    const b = balances.get(a.id)
    if (b === undefined) {
      if (a.isActive) unset.push(a)
      continue
    }
    if (isCard(a)) pending += b
    else total += b
  }
  return { total, pending, unset }
}

/** Cards paid from `accountId`, and their 預扣 together (D-119). */
export function cardsPaidFrom(accountId: string, accounts: readonly PaymentMethod[], balances: ReadonlyMap<string, number>) {
  const cards = accounts.filter((a) => isCard(a) && a.payFromId === accountId)
  return { cards, pending: cards.reduce((s, c) => s + (balances.get(c.id) ?? 0), 0) }
}

/** One line of an account's history (D-123): newest first, only what counts toward its balance. */
export interface FlowRow {
  kind: 'tx' | 'adjustment'
  at: string
  delta: number
  tx?: Transaction
  adjustment?: BalanceAdjustment
}

export function accountFlow(
  account: PaymentMethod,
  accounts: readonly PaymentMethod[],
  transactions: readonly Transaction[],
  adjustments: readonly BalanceAdjustment[],
): FlowRow[] {
  if (!isTracked(account)) return []
  const s = account.balanceFrom!
  const byIdMap = new Map(accounts.map((a) => [a.id, a]))
  const rows: FlowRow[] = []
  for (const t of transactions) {
    if (t.occurredAt < s) continue
    for (const e of effectsOf(t, (id) => byIdMap.get(id))) if (e.accountId === account.id) rows.push({ kind: 'tx', at: t.occurredAt, delta: e.delta, tx: t })
  }
  for (const a of adjustments) if (a.accountId === account.id && a.occurredAt >= s) rows.push({ kind: 'adjustment', at: a.occurredAt, delta: a.delta, adjustment: a })
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}
