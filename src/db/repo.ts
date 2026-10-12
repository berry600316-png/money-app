import { db, type MoneyDB } from './db'
import type { BalanceAdjustment, Category, CategoryType, PaymentMethod, PaymentType, Transaction, TxType } from './types'
import { isValidAmount, MAX_AMOUNT } from '../lib/money'
import { fromYmd, isValidHm, localIso, minuteKey, occurredAtFor, timeLabel, toYmd } from '../lib/dates'
import { computeBalances, isAsset, isCard, isMethod, isTracked, startInstant } from '../lib/accounts'
import { PAYSLIP_SOURCE } from './defaults'

/** An error whose message is safe to show to the user as-is. */
export class MoneyError extends Error {}

export const MERCHANT_MAX = 40
export const NOTE_MAX = 80
export const NAME_MAX = 12

export interface TxInput {
  type: TxType
  amount: number
  merchant: string
  categoryId: string
  paymentMethodId: string
  /** Local calendar date, "YYYY-MM-DD". */
  date: string
  /** Local time "HH:MM" (D-99). Omitted only by callers that predate it: the date-only rule then applies. */
  time?: string
  note: string
  /** Transfers: the destination account (D-117). */
  toAccountId?: string
  /** Expenses paid with 轉帳 / 行動支付 / 其他: the account the money left (D-120). */
  sourceAccountId?: string
  /** Expenses paid with a 行動支付 / 其他 bound to a card: the card charged (D-125). */
  cardId?: string
  /** Transfers: a fee, saved as its own expense from the source account (D-121). 0 / absent = none. */
  fee?: number
}

const TX_TYPES: TxType[] = ['expense', 'income', 'transfer']
/** Recent choices remembered per role, so a new entry starts where the last one did (D-120). */
export const LAST_KEYS = {
  expense: 'lastPaymentMethodId',
  income: 'lastIncomeAccountId',
  source: 'lastSourceAccountId',
  from: 'lastTransferFromId',
  to: 'lastTransferToId',
} as const

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

async function validateTx(d: MoneyDB, input: TxInput, now: Date) {
  if (!isValidAmount(input.amount)) {
    throw new MoneyError(`金額需為 1 到 ${MAX_AMOUNT.toLocaleString('en-US')} 的整數`)
  }
  if (!TX_TYPES.includes(input.type)) throw new MoneyError('類型不正確')
  // Round-trip through a real calendar date so values like 2026-02-31 are rejected, not rolled over.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || toYmd(fromYmd(input.date)) !== input.date) {
    throw new MoneyError('日期不正確')
  }
  if (input.date > toYmd(now)) throw new MoneyError('不能選未來的日期')
  if (input.time !== undefined) {
    if (!isValidHm(input.time)) throw new MoneyError('時間不正確')
    if (`${input.date} ${input.time}` > minuteKey(now)) throw new MoneyError('不能選未來的時間')
  }
  if (input.type === 'transfer') {
    const [from, to] = await Promise.all([d.paymentMethods.get(input.paymentMethodId), input.toAccountId ? d.paymentMethods.get(input.toAccountId) : undefined])
    if (!isAsset(from)) throw new MoneyError('請選擇從哪個帳戶轉出')
    if (!to || !(isAsset(to) || isCard(to))) throw new MoneyError('請選擇轉到哪個帳戶')
    if (from!.id === to.id) throw new MoneyError('轉出和轉入不能是同一個帳戶')
    if (input.fee !== undefined && input.fee !== 0 && !isValidAmount(input.fee)) throw new MoneyError('手續費需為整數')
    return
  }
  const [cat, pay] = await Promise.all([d.categories.get(input.categoryId), d.paymentMethods.get(input.paymentMethodId)])
  if (!cat || cat.type !== input.type) throw new MoneyError('請選擇分類')
  if (!pay) throw new MoneyError('請選擇付款方式')
  if (input.sourceAccountId !== undefined && input.cardId !== undefined) throw new MoneyError('付款方式不正確')
  if (input.sourceAccountId !== undefined) {
    if (input.type !== 'expense' || !isMethod(pay)) throw new MoneyError('付款方式不正確')
    if (!isAsset(await d.paymentMethods.get(input.sourceAccountId))) throw new MoneyError('請選擇從哪個帳戶付')
  }
  // D-125: only a 行動支付 / 其他 can be charged to a card through its binding.
  if (input.cardId !== undefined) {
    if (input.type !== 'expense' || (pay.type !== 'mobile' && pay.type !== 'other')) throw new MoneyError('付款方式不正確')
    if (!isCard(await d.paymentMethods.get(input.cardId))) throw new MoneyError('綁定的信用卡不存在')
  }
}

/** The expense category a transfer fee goes to: 其他 if available (D-121). */
async function feeCategory(d: MoneyDB): Promise<string> {
  const cats = (await d.categories.where('type').equals('expense').toArray()).filter((c) => c.isActive)
  const other = cats.find((c) => c.id === 'other')
  if (other) return other.id
  const first = cats.sort((a, b) => a.sortOrder - b.sortOrder)[0]
  if (!first) throw new MoneyError('沒有可用的支出分類記手續費')
  return first.id
}

/** Keep a transfer's fee expense in step with the transfer (create, change or remove it). */
async function syncFee(d: MoneyDB, transfer: Transaction | null, transferId: string, fee: number, stamp: string) {
  const existing = await d.transactions.where('feeOf').equals(transferId).first()
  if (!transfer || transfer.type !== 'transfer' || !fee) {
    if (existing) await d.transactions.delete(existing.id)
    return
  }
  const next: Transaction = {
    id: existing?.id ?? newId(),
    type: 'expense',
    amount: fee,
    merchant: '互轉手續費',
    categoryId: existing?.categoryId ?? (await feeCategory(d)),
    paymentMethodId: transfer.paymentMethodId,
    occurredAt: transfer.occurredAt,
    note: '',
    source: 'manual',
    externalId: null,
    feeOf: transferId,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  }
  await d.transactions.put(next)
}

/** D-119: the first bill paid for a card without a paying account makes that account its payer. */
async function rememberPayer(d: MoneyDB, t: Transaction) {
  if (t.type !== 'transfer' || !t.toAccountId) return
  const [card, from] = await Promise.all([d.paymentMethods.get(t.toAccountId), d.paymentMethods.get(t.paymentMethodId)])
  // D-125: a card belongs to a bank, so only a bank paying it is remembered.
  if (card && isCard(card) && !card.payFromId && from?.type === 'bank') await d.paymentMethods.put({ ...card, payFromId: t.paymentMethodId })
}

/** The stored instant for a date + time; the current minute keeps the exact current instant (stable order). */
function instantFor(input: TxInput, now: Date): string {
  if (input.time === undefined) return occurredAtFor(input.date, now)
  if (input.date === toYmd(now) && input.time === timeLabel(now)) return now.toISOString()
  return localIso(input.date, input.time)
}

function clean(input: TxInput) {
  const transfer = input.type === 'transfer'
  return {
    type: input.type,
    amount: input.amount,
    merchant: transfer ? '' : input.merchant.trim().slice(0, MERCHANT_MAX),
    categoryId: transfer ? '' : input.categoryId,
    paymentMethodId: input.paymentMethodId,
    note: input.note.trim().slice(0, NOTE_MAX),
  }
}

/** The optional account links: only the one that fits the type is kept (D-117, D-120). */
function links(input: TxInput): Pick<Transaction, 'toAccountId' | 'sourceAccountId' | 'cardId'> {
  if (input.type === 'transfer') return { toAccountId: input.toAccountId }
  if (input.type === 'expense' && input.sourceAccountId) return { sourceAccountId: input.sourceAccountId }
  if (input.type === 'expense' && input.cardId) return { cardId: input.cardId }
  return {}
}

/* ---------------- transactions ---------------- */

const TX_TABLES = (d: MoneyDB) => [d.transactions, d.settings, d.paymentMethods, d.categories]

export async function addTransaction(input: TxInput, d: MoneyDB = db, now = new Date()): Promise<Transaction> {
  await validateTx(d, input, now)
  const stamp = now.toISOString()
  const tx: Transaction = {
    id: newId(),
    ...clean(input),
    ...links(input),
    occurredAt: instantFor(input, now),
    source: 'manual',
    externalId: null,
    createdAt: stamp,
    updatedAt: stamp,
  }
  await d.transaction('rw', TX_TABLES(d), async () => {
    await d.transactions.add(tx)
    await syncFee(d, tx, tx.id, input.fee ?? 0, stamp)
    await rememberPayer(d, tx)
    // D-20 / D-120: the next entry of the same kind starts with the same accounts.
    const last: [string, string][] =
      tx.type === 'transfer'
        ? [[LAST_KEYS.from, tx.paymentMethodId], [LAST_KEYS.to, tx.toAccountId!]]
        : tx.type === 'income'
          ? [[LAST_KEYS.income, tx.paymentMethodId]]
          : [[LAST_KEYS.expense, tx.paymentMethodId], ...(tx.sourceAccountId ? ([[LAST_KEYS.source, tx.sourceAccountId]] as [string, string][]) : [])]
    await d.settings.bulkPut(last.map(([key, value]) => ({ key, value })))
  })
  return tx
}

export async function updateTransaction(id: string, input: TxInput, d: MoneyDB = db, now = new Date()): Promise<Transaction> {
  await validateTx(d, input, now)
  return d.transaction('rw', TX_TABLES(d), async () => {
    const prev = await d.transactions.get(id)
    if (!prev) throw new MoneyError('這筆紀錄已不存在')
    if (prev.source === PAYSLIP_SOURCE) throw new MoneyError('這筆收入由薪資單產生，請到薪資單修改')
    if (prev.feeOf && input.type !== 'expense') throw new MoneyError('手續費只能是支出，請到那筆互轉修改')
    // Unchanged date (and time, when given) keeps the stored instant and its time source (D-99, D-100);
    // a changed time is the user's own, so the "approximate" marker goes away.
    const prevAt = new Date(prev.occurredAt)
    const keepTime = input.time === undefined ? toYmd(prevAt) === input.date : minuteKey(prevAt) === `${input.date} ${input.time}`
    // D-121: a fee is always dated with its transfer (a range restore moves them together).
    if (prev.feeOf && !keepTime) throw new MoneyError('手續費的日期跟著那筆互轉，請到那筆互轉修改')
    const next: Transaction = {
      ...prev,
      ...clean(input),
      occurredAt: keepTime ? prev.occurredAt : instantFor(input, now),
      updatedAt: now.toISOString(),
    }
    delete next.toAccountId
    delete next.sourceAccountId
    delete next.cardId
    Object.assign(next, links(input))
    if (!keepTime) delete next.timeSource
    // D-20 "last used" follows new entries only; correcting an old record doesn't change the default.
    await d.transactions.put(next)
    // A transfer's fee follows it; a fee record itself is edited like any expense.
    if (!prev.feeOf) await syncFee(d, next, id, next.type === 'transfer' ? (input.fee ?? 0) : 0, next.updatedAt)
    await rememberPayer(d, next)
    return next
  })
}

/** Deletes a record (and a transfer's fee with it); returns everything removed so it can be undone (D-25). */
export async function deleteEntry(id: string, d: MoneyDB = db): Promise<Transaction[]> {
  return d.transaction('rw', d.transactions, async () => {
    const prev = await d.transactions.get(id)
    if (!prev) throw new MoneyError('這筆紀錄已不存在')
    if (prev.source === PAYSLIP_SOURCE) throw new MoneyError('這筆收入由薪資單產生，請到薪資單刪除')
    const fees = prev.type === 'transfer' ? await d.transactions.where('feeOf').equals(id).toArray() : []
    await d.transactions.bulkDelete([id, ...fees.map((f) => f.id)])
    return [prev, ...fees]
  })
}

/** Returns the deleted record so the caller can offer undo (D-25). */
export async function deleteTransaction(id: string, d: MoneyDB = db): Promise<Transaction> {
  return (await deleteEntry(id, d))[0]
}

export async function restoreTransaction(tx: Transaction | Transaction[], d: MoneyDB = db): Promise<void> {
  await d.transactions.bulkPut(Array.isArray(tx) ? tx : [tx])
}

/** The fee recorded for a transfer, 0 if none (D-121). */
export async function transferFee(id: string, d: MoneyDB = db): Promise<number> {
  return (await d.transactions.where('feeOf').equals(id).first())?.amount ?? 0
}

/** D-23: up to `limit` distinct recent merchants containing `query`, with the category last used. */
export async function recentMerchants(
  query: string,
  type: TxType,
  limit = 4,
  d: MoneyDB = db,
): Promise<{ merchant: string; categoryId: string }[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const recent = await d.transactions.orderBy('occurredAt').reverse().limit(600).toArray()
  const seen = new Set<string>()
  const out: { merchant: string; categoryId: string }[] = []
  for (const t of recent) {
    if (t.type !== type || !t.merchant) continue
    const key = t.merchant.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (key === q || !key.includes(q)) continue
    out.push({ merchant: t.merchant, categoryId: t.categoryId })
    if (out.length >= limit) break
  }
  return out
}

/* ---------------- categories & payment methods ---------------- */

function cleanName(name: string): string {
  const n = name.trim().slice(0, NAME_MAX)
  if (!n) throw new MoneyError('請輸入名稱')
  return n
}

/** D-127: an icon name is a short word of letters (the drawing itself lives in the UI). */
function checkIcon(icon: string): string {
  if (!/^[A-Za-z]{1,32}$/.test(icon)) throw new MoneyError('圖示不正確')
  return icon
}

export async function addCategory(input: { name: string; type: CategoryType; icon?: string }, d: MoneyDB = db): Promise<Category> {
  const name = cleanName(input.name)
  const icon = input.icon === undefined ? (input.type === 'income' ? 'plusCircle' : 'other') : checkIcon(input.icon)
  return d.transaction('rw', d.categories, async () => {
    const same = await d.categories.where('type').equals(input.type).toArray()
    if (same.some((c) => c.name === name)) throw new MoneyError(`已經有「${name}」這個分類`)
    const cat: Category = {
      id: newId(),
      name,
      type: input.type,
      icon,
      isActive: true,
      sortOrder: same.reduce((m, c) => Math.max(m, c.sortOrder), -1) + 1,
    }
    await d.categories.add(cat)
    return cat
  })
}

export async function updateCategory(id: string, patch: { name?: string; isActive?: boolean; icon?: string }, d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.categories, async () => {
    const cat = await d.categories.get(id)
    if (!cat) throw new MoneyError('找不到這個分類')
    const same = await d.categories.where('type').equals(cat.type).toArray()
    const next = { ...cat }
    // D-127: the icon can be changed after the category is created.
    if (patch.icon !== undefined) next.icon = checkIcon(patch.icon)
    if (patch.name !== undefined) {
      next.name = cleanName(patch.name)
      if (same.some((c) => c.id !== id && c.name === next.name)) throw new MoneyError(`已經有「${next.name}」這個分類`)
    }
    if (patch.isActive === false && cat.isActive) {
      const othersActive = same.filter((c) => c.id !== id && c.isActive).length
      if (othersActive === 0) throw new MoneyError(`至少要保留一個${cat.type === 'expense' ? '支出' : '收入'}分類`)
    }
    if (patch.isActive !== undefined) next.isActive = patch.isActive
    await d.categories.put(next)
  })
}

/** D-122: move a category one place up (-1) or down (+1) among its type. */
export async function moveCategory(id: string, dir: -1 | 1, d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.categories, async () => {
    const cat = await d.categories.get(id)
    if (!cat) return
    const list = (await d.categories.where('type').equals(cat.type).toArray()).sort((a, b) => a.sortOrder - b.sortOrder)
    await d.categories.bulkPut(reorder(list, id, dir))
  })
}

/** Swap with the neighbour and renumber 0..n-1, so equal or gapped orders can never get stuck. */
function reorder<T extends { id: string; sortOrder: number }>(list: T[], id: string, dir: -1 | 1): T[] {
  const i = list.findIndex((x) => x.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= list.length) return []
  const next = [...list]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next.map((x, k) => ({ ...x, sortOrder: k }))
}

/** D-80: bank name and last four digits, credit cards only. */
function cardFields(type: PaymentType, bank?: string, last4?: string): Pick<PaymentMethod, 'bank' | 'cardLast4'> {
  if (type !== 'credit_card') return {}
  const b = (bank ?? '').trim().slice(0, 20)
  const l = (last4 ?? '').trim()
  if (l && !/^\d{4}$/.test(l)) throw new MoneyError('末四碼需為 4 位數字')
  return { ...(b ? { bank: b } : {}), ...(l ? { cardLast4: l } : {}) }
}

/** D-118: a start date (not in the future) and the balance (or a card's unpaid 預扣) on that day. */
function checkStart(ymd: string, amount: number, now: Date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || toYmd(fromYmd(ymd)) !== ymd) throw new MoneyError('起算日期不正確')
  if (ymd > toYmd(now)) throw new MoneyError('起算日期不能是未來')
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_AMOUNT) throw new MoneyError(`金額需為 0 到 ${MAX_AMOUNT.toLocaleString('en-US')} 的整數`)
}

/** D-119 / D-125: a card belongs to a bank account; its 預扣 shows there and its bill is paid from it. */
async function checkPayer(d: MoneyDB, type: PaymentType, payFromId: string | undefined) {
  if (type !== 'credit_card' || !payFromId) return
  if ((await d.paymentMethods.get(payFromId))?.type !== 'bank') throw new MoneyError('信用卡要屬於一個銀行帳戶')
}

/** D-125: a 行動支付 / 其他 is bound to a card or to an account that holds money. */
async function checkBinding(d: MoneyDB, type: PaymentType, boundTo: string | undefined, selfId?: string) {
  if ((type !== 'mobile' && type !== 'other') || !boundTo) return
  const target = await d.paymentMethods.get(boundTo)
  if (boundTo === selfId || !(isCard(target) || isAsset(target))) throw new MoneyError('綁定的卡或帳戶不正確')
}

export interface AccountInput {
  name: string
  type: PaymentType
  bank?: string
  cardLast4?: string
  /** Cards: the bank account it belongs to (D-119, D-125). */
  payFromId?: string
  /** 行動支付 / 其他: the card or account it is bound to (D-125). */
  boundTo?: string
  /** Accounts and cards: start counting from `start.date` with `start.amount` (D-118). */
  start?: { date: string; amount: number }
}

export async function addPaymentMethod(input: AccountInput, d: MoneyDB = db, now = new Date()): Promise<PaymentMethod> {
  const name = cleanName(input.name)
  const card = cardFields(input.type, input.bank, input.cardLast4)
  if (input.start) checkStart(input.start.date, input.start.amount, now)
  return d.transaction('rw', d.paymentMethods, async () => {
    const all = await d.paymentMethods.toArray()
    if (all.some((p) => p.name === name)) throw new MoneyError(`已經有「${name}」這個名稱`)
    await checkPayer(d, input.type, input.payFromId)
    await checkBinding(d, input.type, input.boundTo)
    const pm: PaymentMethod = {
      id: newId(),
      name,
      type: input.type,
      isActive: true,
      sortOrder: all.reduce((m, p) => Math.max(m, p.sortOrder), -1) + 1,
      ...card,
      ...(input.type === 'credit_card' && input.payFromId ? { payFromId: input.payFromId } : {}),
      ...((input.type === 'mobile' || input.type === 'other') && input.boundTo ? { boundTo: input.boundTo } : {}),
      ...(input.start && !isMethod({ type: input.type }) ? { balanceFrom: startInstant(input.start.date, now), openingBalance: input.start.amount } : {}),
    }
    await d.paymentMethods.add(pm)
    return pm
  })
}

export async function updatePaymentMethod(
  id: string,
  patch: {
    name?: string
    isActive?: boolean
    type?: PaymentType
    bank?: string
    cardLast4?: string
    /** '' clears it. */
    payFromId?: string
    /** '' clears it (D-125). */
    boundTo?: string
    /** null = stop counting ("尚未設定餘額"). */
    start?: { date: string; amount: number } | null
  },
  d: MoneyDB = db,
  now = new Date(),
): Promise<void> {
  if (patch.start) checkStart(patch.start.date, patch.start.amount, now)
  await d.transaction('rw', d.paymentMethods, async () => {
    const pm = await d.paymentMethods.get(id)
    if (!pm) throw new MoneyError('找不到這個帳戶')
    const all = await d.paymentMethods.toArray()
    const next = { ...pm }
    if (patch.name !== undefined) {
      next.name = cleanName(patch.name)
      if (all.some((p) => p.id !== id && p.name === next.name)) throw new MoneyError(`已經有「${next.name}」這個名稱`)
    }
    if (patch.type !== undefined) next.type = patch.type
    if (patch.isActive === false && pm.isActive && all.filter((p) => p.id !== id && p.isActive).length === 0) {
      throw new MoneyError('至少要保留一個帳戶或付款方式')
    }
    if (patch.isActive !== undefined) next.isActive = patch.isActive
    if (patch.type !== undefined || patch.bank !== undefined || patch.cardLast4 !== undefined) {
      const card = cardFields(next.type, patch.bank ?? next.bank, patch.cardLast4 ?? next.cardLast4)
      next.bank = card.bank
      next.cardLast4 = card.cardLast4
      if (next.bank === undefined) delete next.bank
      if (next.cardLast4 === undefined) delete next.cardLast4
    }
    if (patch.payFromId !== undefined) {
      if (patch.payFromId === id) throw new MoneyError('繳卡費的帳戶不正確')
      await checkPayer(d, next.type, patch.payFromId)
      if (patch.payFromId) next.payFromId = patch.payFromId
      else delete next.payFromId
    }
    if (next.type !== 'credit_card') delete next.payFromId
    if (patch.boundTo !== undefined) {
      await checkBinding(d, next.type, patch.boundTo, id)
      if (patch.boundTo) next.boundTo = patch.boundTo
      else delete next.boundTo
    }
    if (next.type !== 'mobile' && next.type !== 'other') delete next.boundTo
    if (patch.start !== undefined) {
      if (patch.start) {
        // The same date and amount keep the stored instant; a change starts counting afresh (D-118).
        const same = pm.balanceFrom !== undefined && toYmd(new Date(pm.balanceFrom)) === patch.start.date && pm.openingBalance === patch.start.amount
        if (!same) {
          next.balanceFrom = startInstant(patch.start.date, now)
          next.openingBalance = patch.start.amount
        }
      } else {
        delete next.balanceFrom
        delete next.openingBalance
      }
    }
    // Ways to pay are not accounts: they never hold a balance (D-120).
    if (isMethod(next)) {
      delete next.balanceFrom
      delete next.openingBalance
    }
    await d.paymentMethods.put(next)
  })
}

/** D-118: set several start balances at once (the one-time setup after the upgrade). */
export async function setStartBalances(items: { id: string; amount: number }[], date: string, d: MoneyDB = db, now = new Date()): Promise<void> {
  for (const it of items) checkStart(date, it.amount, now)
  await d.transaction('rw', d.paymentMethods, async () => {
    for (const it of items) {
      const pm = await d.paymentMethods.get(it.id)
      if (!pm || isMethod(pm)) continue
      await d.paymentMethods.put({ ...pm, balanceFrom: startInstant(date, now), openingBalance: it.amount })
    }
  })
}

export async function movePaymentMethod(id: string, dir: -1 | 1, d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.paymentMethods, async () => {
    const list = (await d.paymentMethods.toArray()).sort((a, b) => a.sortOrder - b.sortOrder)
    await d.paymentMethods.bulkPut(reorder(list, id, dir))
  })
}

/* ---------------- balances (D-118) ---------------- */

/** Current balance of one account (a card: its 預扣); null when it is not being counted. */
export async function balanceOf(id: string, d: MoneyDB = db): Promise<number | null> {
  const acc = await d.paymentMethods.get(id)
  if (!acc || !isTracked(acc) || isMethod(acc)) return null
  const all = await d.paymentMethods.toArray()
  const since = acc.balanceFrom!
  const [txs, adjs] = await Promise.all([
    d.transactions.where('occurredAt').aboveOrEqual(since).toArray(),
    d.adjustments.where('accountId').equals(id).toArray(),
  ])
  return computeBalances(all, txs, adjs).get(id) ?? null
}

/**
 * D-118: correct an account to its real balance. Stored as before / after / difference; it is not
 * income, expense or a transfer, and only shows in that account's history.
 */
export async function adjustBalance(id: string, actual: number, note: string, d: MoneyDB = db, now = new Date()): Promise<BalanceAdjustment> {
  if (!Number.isSafeInteger(actual) || Math.abs(actual) > MAX_AMOUNT) throw new MoneyError('金額不正確')
  return d.transaction('rw', [d.paymentMethods, d.transactions, d.adjustments], async () => {
    const before = await balanceOf(id, d)
    if (before === null) throw new MoneyError('這個帳戶還沒設定餘額')
    if (before === actual) throw new MoneyError('和目前的金額一樣，不需要調整')
    const stamp = now.toISOString()
    const adj: BalanceAdjustment = {
      id: newId(),
      accountId: id,
      occurredAt: stamp,
      before,
      after: actual,
      delta: actual - before,
      note: note.trim().slice(0, NOTE_MAX),
      createdAt: stamp,
    }
    await d.adjustments.add(adj)
    return adj
  })
}

export async function deleteAdjustment(id: string, d: MoneyDB = db): Promise<BalanceAdjustment | undefined> {
  return d.transaction('rw', d.adjustments, async () => {
    const a = await d.adjustments.get(id)
    if (a) await d.adjustments.delete(id)
    return a
  })
}

export async function restoreAdjustment(a: BalanceAdjustment, d: MoneyDB = db): Promise<void> {
  await d.adjustments.put(a)
}

/* ---------------- settings ---------------- */

export async function getSetting<T>(key: string, fallback: T, d: MoneyDB = db): Promise<T> {
  const row = await d.settings.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function setSetting(key: string, value: unknown, d: MoneyDB = db): Promise<void> {
  await d.settings.put({ key, value })
}
