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
  // expense: a card charge (directly, or through a 行動支付 bound to the card, D-125) waits as its 預扣.
  if (isCard(p)) return [{ accountId: t.paymentMethodId, delta: t.amount }]
  if (t.cardId) return [{ accountId: t.cardId, delta: t.amount }]
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

/**
 * D-125: the payment a card statement would list it under: the card charged through a bound 行動支付,
 * else the record's own payment method (a card used directly).
 */
export const chargedTo = (t: Pick<Transaction, 'paymentMethodId' | 'cardId'>) => t.cardId ?? t.paymentMethodId

/* ---------------- ways to pay, grouped by account (D-125) ---------------- */

/** What an expense records about how it was paid. */
export interface PayChoice {
  paymentMethodId: string
  sourceAccountId?: string
  cardId?: string
}

/** One row of the 付款 picker: a way to pay together with the account it draws on. */
export interface PayOption extends PayChoice {
  key: string
  /** The method's own name ("台新@GoGo", "Apple Pay", "轉帳"), or the account's for cash / stored value. */
  name: string
  /** The card the spending waits on as 預扣; absent = taken from the account at once. */
  card?: PaymentMethod
}

/** The rows under one account; `account` null = ways to pay not tied to any account yet. */
export interface PayGroup {
  account: PaymentMethod | null
  options: PayOption[]
}

export const payKey = (c: PayChoice) => [c.paymentMethodId, c.sourceAccountId ?? '', c.cardId ?? ''].join('|')

/** A 行動支付 / 其他: bound once (in settings) to a card or an account (D-125). */
const isBindable = (p: PaymentMethod) => p.type === 'mobile' || p.type === 'other'

/**
 * D-125: every active way to pay, under the account it draws on. A card sits under its bank, a bound
 * 行動支付 / 其他 under its card or account, a debit card (D-129) under its bank, and 轉帳 under every bank account. Cash and stored value are
 * their own way to pay. Anything not tied to an account goes in a last group (it counts in no balance).
 */
export function payGroups(all: readonly PaymentMethod[]): PayGroup[] {
  const active = all.filter((p) => p.isActive)
  const assets = active.filter(isAsset)
  // A card belongs to a bank only; an older link to cash or stored value counts as not assigned yet.
  const bankIds = new Set(assets.filter((a) => a.type === 'bank').map((a) => a.id))
  const cardHome = (c: PaymentMethod) => (c.payFromId && bankIds.has(c.payFromId) ? c.payFromId : '')
  const activeCard = (id?: string) => active.find((c) => c.id === id && isCard(c))
  const placed = new Set<string>()
  const make = (m: PaymentMethod, links: Omit<PayChoice, 'paymentMethodId'>, card?: PaymentMethod): PayOption => {
    placed.add(m.id)
    const c: PayChoice = { paymentMethodId: m.id, ...links }
    return { ...c, key: payKey(c), name: m.name, ...(card ? { card } : {}) }
  }
  const groups: PayGroup[] = assets.map((a) => {
    const options: PayOption[] = []
    if (a.type !== 'bank') options.push(make(a, {}))
    for (const c of active.filter((x) => isCard(x) && cardHome(x) === a.id)) {
      options.push(make(c, {}, c))
      for (const m of active.filter((x) => isBindable(x) && x.boundTo === c.id)) options.push(make(m, { cardId: c.id }, c))
    }
    for (const m of active.filter((x) => isBindable(x) && x.boundTo === a.id)) options.push(make(m, { sourceAccountId: a.id }))
    // D-129: a debit card takes money from its bank at once.
    if (a.type === 'bank') for (const m of active.filter((x) => x.type === 'debit_card' && x.payFromId === a.id)) options.push(make(m, { sourceAccountId: a.id }))
    if (a.type === 'bank') {
      for (const t of active.filter((x) => x.type === 'transfer')) options.push(make(t, { sourceAccountId: a.id }))
      // Nothing else to pay with from this bank: the account itself (taken at once).
      if (!options.length) options.push(make(a, {}))
    }
    return { account: a, options }
  })
  const loose = active
    .filter((m) => !isAsset(m) && !placed.has(m.id))
    .map((m) => {
      const card = isBindable(m) ? activeCard(m.boundTo) : undefined
      return card ? make(m, { cardId: card.id }, card) : make(m, {}, isCard(m) ? m : undefined)
    })
  return [...groups.filter((g) => g.options.length), ...(loose.length ? [{ account: null, options: loose }] : [])]
}

/**
 * The option to start a new expense with: `methodId` as last used (a 轉帳 under the account last used
 * with it), else the first option. A 行動支付 follows its current binding.
 */
export function defaultPay(groups: readonly PayGroup[], methodId: string, lastSourceId?: string): PayOption | undefined {
  const options = groups.flatMap((g) => g.options)
  const same = options.filter((o) => o.paymentMethodId === methodId)
  return same.find((o) => !o.sourceAccountId || o.sourceAccountId === lastSourceId) ?? same[0] ?? options[0]
}

/**
 * How an expense was paid: the method's name, the account it draws on when that is another one
 * ("台新 Richart" for 信用卡), and whether it waits on a card as 預扣.
 */
export function describePay(
  c: PayChoice,
  byId: (id: string) => PaymentMethod | undefined,
): { name: string; account: string; label: string; pending: boolean } {
  const m = byId(c.paymentMethodId)
  const card = isCard(m) ? m : c.cardId ? byId(c.cardId) : undefined
  const accountId = c.sourceAccountId ?? card?.payFromId
  const account = accountId && accountId !== c.paymentMethodId ? (byId(accountId)?.name ?? '') : ''
  const name = m?.name ?? '已刪除的付款方式'
  return { name, account, label: account ? `${account} · ${name}` : name, pending: !!card }
}

/** One line of an account's history (D-123): newest first, only what counts toward its balance. */
export interface FlowRow {
  kind: 'tx' | 'adjustment'
  at: string
  delta: number
  tx?: Transaction
  adjustment?: BalanceAdjustment
  /** D-125: on a bank's page, a charge to one of its cards: waiting as 預扣, not yet out of the balance. */
  pending?: boolean
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
  // D-125: a bank also lists what its cards were charged (shown as 預扣, out of the balance only when paid).
  for (const card of accounts.filter((c) => isCard(c) && c.payFromId === account.id && isTracked(c))) {
    for (const t of transactions) {
      if (t.type !== 'expense' || t.occurredAt < card.balanceFrom!) continue
      for (const e of effectsOf(t, (id) => byIdMap.get(id))) if (e.accountId === card.id) rows.push({ kind: 'tx', at: t.occurredAt, delta: -e.delta, tx: t, pending: true })
    }
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}
