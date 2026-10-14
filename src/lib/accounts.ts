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
/** D-129: a debit card (takes money from its bank at once). */
export const isDebit = (p: Pick<PaymentMethod, 'type'> | undefined) => !!p && p.type === 'debit_card'
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
  // expense: a credit card charge (directly, or through a 行動支付 holding it, D-125 / D-132) waits as its
  // 預扣; a debit card (directly or through a 行動支付, D-129 / D-132) takes the money from its bank at once.
  if (isCard(p)) return [{ accountId: t.paymentMethodId, delta: t.amount }]
  if (t.cardId) {
    const used = byId(t.cardId)
    if (isCard(used)) return [{ accountId: t.cardId, delta: t.amount }]
    if (isDebit(used) && used!.payFromId) return [{ accountId: used!.payFromId, delta: -t.amount }]
    return []
  }
  if (isMethod(p)) {
    if (t.sourceAccountId) return [{ accountId: t.sourceAccountId, delta: -t.amount }]
    if (isDebit(p) && p!.payFromId) return [{ accountId: p!.payFromId, delta: -t.amount }]
    return []
  }
  return [{ accountId: t.paymentMethodId, delta: -t.amount }]
}

/**
 * D-139: the money left in 現金 accounts in use that count a balance (the same figure as 我的帳戶); an
 * account without a start balance is left out. `ids` empty = nothing to show.
 */
export function cashOnHand(methods: readonly PaymentMethod[], balances: ReadonlyMap<string, number> | undefined): { ids: string[]; total: number } {
  const ids = methods.filter((p) => p.type === 'cash' && p.isActive && balances?.has(p.id)).map((p) => p.id)
  return { ids, total: ids.reduce((sum, id) => sum + balances!.get(id)!, 0) }
}

/**
 * D-138: the expenses that took money out of a 現金 account (not 儲值, cards, debit cards or transfers),
 * shown on the home page under the month's spending.
 */
export function cashSpent(list: readonly Transaction[], methods: readonly PaymentMethod[]): number {
  const byId = (id: string) => methods.find((p) => p.id === id)
  let sum = 0
  for (const t of list) {
    if (t.type !== 'expense') continue
    for (const e of effectsOf(t, byId)) if (e.delta < 0 && byId(e.accountId)?.type === 'cash') sum -= e.delta
  }
  return sum
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
  /** As shown: the name, or "Apple Pay · 台新信用卡" for a card held by a 行動支付 (D-132). */
  label: string
  /** The card used (credit: waits as 預扣; debit: taken from its bank at once); absent = no card. */
  card?: PaymentMethod
}

/**
 * The rows under one account (`account` set), the cards held by 行動支付 (D-132), or ways to pay not tied
 * to any account yet (they count in no balance).
 */
export interface PayGroup {
  account: PaymentMethod | null
  title: string
  options: PayOption[]
}

export const payKey = (c: PayChoice) => [c.paymentMethodId, c.sourceAccountId ?? '', c.cardId ?? ''].join('|')

/** A 行動支付 / 其他: holds cards (D-132). */
export const isWallet = (p: Pick<PaymentMethod, 'type'> | undefined) => !!p && (p.type === 'mobile' || p.type === 'other')
/** A card a 行動支付 can hold: credit or debit (D-132, Q110 B: never an account itself). */
export const isPlastic = (p: Pick<PaymentMethod, 'type'> | undefined) => isCard(p) || isDebit(p)

/**
 * D-125 / D-132: every active way to pay. Under each bank: its credit cards (預扣), its debit cards and
 * 轉帳 (taken at once); cash and stored value are their own way to pay. Then each 行動支付 / 其他 once for
 * every card it holds ("Apple Pay · 台新信用卡", "Apple Pay · 台新金融卡"). Anything not tied to an account
 * goes in a last group (it counts in no balance).
 */
export function payGroups(all: readonly PaymentMethod[]): PayGroup[] {
  // In the user's order (設定 › 調整順序), whatever order the caller passes them in.
  const active = all.filter((p) => p.isActive).sort((a, b) => a.sortOrder - b.sortOrder)
  const assets = active.filter(isAsset)
  // A card belongs to a bank only; an older link to cash or stored value counts as not assigned yet.
  const bankIds = new Set(assets.filter((a) => a.type === 'bank').map((a) => a.id))
  const home = (c: PaymentMethod) => (c.payFromId && bankIds.has(c.payFromId) ? c.payFromId : '')
  const placed = new Set<string>()
  const make = (m: PaymentMethod, links: Omit<PayChoice, 'paymentMethodId'>, card?: PaymentMethod, label = m.name): PayOption => {
    placed.add(m.id)
    const c: PayChoice = { paymentMethodId: m.id, ...links }
    return { ...c, key: payKey(c), name: m.name, label, ...(card ? { card } : {}) }
  }
  const groups: PayGroup[] = assets.map((a) => {
    const options: PayOption[] = []
    if (a.type !== 'bank') options.push(make(a, {}))
    else {
      for (const c of active.filter((x) => isCard(x) && home(x) === a.id)) options.push(make(c, {}, c))
      for (const c of active.filter((x) => isDebit(x) && home(x) === a.id)) options.push(make(c, { sourceAccountId: a.id }, c))
      for (const t of active.filter((x) => x.type === 'transfer')) options.push(make(t, { sourceAccountId: a.id }))
      // Nothing else to pay with from this bank: the account itself (taken at once).
      if (!options.length) options.push(make(a, {}))
    }
    return { account: a, title: a.name, options }
  })
  const wallets: PayOption[] = []
  for (const m of active.filter(isWallet)) {
    for (const id of m.cards ?? []) {
      const c = active.find((x) => x.id === id && isPlastic(x))
      if (c) wallets.push(make(m, { cardId: c.id }, c, `${m.name} · ${c.name}`))
    }
  }
  const loose = active.filter((m) => !isAsset(m) && !placed.has(m.id)).map((m) => make(m, {}, isCard(m) ? m : undefined))
  return [
    ...groups.filter((g) => g.options.length),
    ...(wallets.length ? [{ account: null, title: '行動支付', options: wallets }] : []),
    ...(loose.length ? [{ account: null, title: '還沒指定帳戶', options: loose }] : []),
  ]
}

/**
 * The option to start a new expense with: `methodId` as last used; a 行動支付 with the card it used last
 * time (Q109 B), a 轉帳 under the account last used with it; else the first option.
 */
export function defaultPay(groups: readonly PayGroup[], methodId: string, lastSourceId?: string, lastCardId?: string): PayOption | undefined {
  const options = groups.flatMap((g) => g.options)
  const same = options.filter((o) => o.paymentMethodId === methodId)
  return (
    (lastCardId ? same.find((o) => o.cardId === lastCardId) : undefined) ??
    same.find((o) => !o.cardId && (!o.sourceAccountId || o.sourceAccountId === lastSourceId)) ??
    same[0] ??
    options[0]
  )
}

/**
 * How an expense was paid: the method's name, then what it drew on — the card used through a 行動支付
 * ("Apple Pay · 台新信用卡"), or the account for a card or 轉帳 ("台新 Richart · 台新信用卡") — and whether
 * it waits on a credit card as 預扣.
 */
export function describePay(
  c: PayChoice,
  byId: (id: string) => PaymentMethod | undefined,
): { name: string; account: string; label: string; pending: boolean } {
  const m = byId(c.paymentMethodId)
  const name = m?.name ?? '已刪除的付款方式'
  const used = c.cardId ? byId(c.cardId) : undefined
  if (used) return { name, account: used.name, label: `${name} · ${used.name}`, pending: isCard(used) }
  const card = isCard(m) ? m : undefined
  const accountId = c.sourceAccountId ?? card?.payFromId ?? (isDebit(m) ? m!.payFromId : undefined)
  const account = accountId && accountId !== c.paymentMethodId ? (byId(accountId)?.name ?? '') : ''
  return { name, account, label: account ? `${account} · ${name}` : name, pending: !!card }
}

/* ---------------- older data (D-132, Q107 A) ---------------- */

/**
 * A payment method as stored before D-132 (a 行動支付 bound to one card or one account) or before D-136
 * (one card chosen for its notices, `notifyCardId`, now keyword rules).
 */
export type LegacyPaymentMethod = PaymentMethod & { boundTo?: string; notifyCardId?: string }

/**
 * Brings data from before D-132 to the new rules (database v7, older backups):
 *  - a 行動支付 / 其他 bound to one card now holds that card; bound to a bank account, it holds that bank's
 *    debit card when there is exactly one, else nothing (Q110 B: a wallet never holds an account);
 *  - the single card chosen for notices (`notifyCardId`, D-133) is dropped: D-136 routes notices by the
 *    user's keyword rules (one card held needs none);
 *  - an expense through a 行動支付 that recorded only the account now records that account's debit card,
 *    when there is exactly one (else it keeps the account, still counted the same).
 * Returns only what changed.
 */
export function migrateWalletLinks(
  methods: readonly LegacyPaymentMethod[],
  transactions: readonly Transaction[],
): { methods: PaymentMethod[]; transactions: Transaction[] } {
  const byId = new Map(methods.map((p) => [p.id, p]))
  const debitsOf = (bankId: string) => methods.filter((p) => isDebit(p) && p.payFromId === bankId)
  const changedMethods: PaymentMethod[] = []
  for (const p of methods) {
    if (p.boundTo === undefined && p.notifyCardId === undefined) continue
    const { boundTo, notifyCardId: _old, ...rest } = p
    void _old
    const next: PaymentMethod = { ...rest }
    if (isWallet(p) && boundTo !== undefined) {
      const target = byId.get(boundTo)
      const debits = target?.type === 'bank' ? debitsOf(target.id) : []
      const card = isPlastic(target) ? target! : debits.length === 1 ? debits[0] : undefined
      if (card && !(next.cards ?? []).includes(card.id)) next.cards = [...(next.cards ?? []), card.id]
    }
    changedMethods.push(next)
  }
  const changedTx: Transaction[] = []
  for (const t of transactions) {
    if (t.type !== 'expense' || t.cardId || !t.sourceAccountId || !isWallet(byId.get(t.paymentMethodId))) continue
    const debits = debitsOf(t.sourceAccountId)
    if (debits.length !== 1) continue
    const { sourceAccountId: _gone, ...rest } = t
    void _gone
    changedTx.push({ ...rest, cardId: debits[0].id })
  }
  return { methods: changedMethods, transactions: changedTx }
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
