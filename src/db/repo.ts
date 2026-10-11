import { db, type MoneyDB } from './db'
import type { Category, PaymentMethod, PaymentType, Transaction, TxType } from './types'
import { isValidAmount, MAX_AMOUNT } from '../lib/money'
import { fromYmd, occurredAtFor, toYmd } from '../lib/dates'
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
  note: string
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

async function validateTx(d: MoneyDB, input: TxInput, now: Date) {
  if (!isValidAmount(input.amount)) {
    throw new MoneyError(`金額需為 1 到 ${MAX_AMOUNT.toLocaleString('en-US')} 的整數`)
  }
  if (input.type !== 'expense' && input.type !== 'income') throw new MoneyError('類型不正確')
  // Round-trip through a real calendar date so values like 2026-02-31 are rejected, not rolled over.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || toYmd(fromYmd(input.date)) !== input.date) {
    throw new MoneyError('日期不正確')
  }
  if (input.date > toYmd(now)) throw new MoneyError('不能選未來的日期')
  const [cat, pay] = await Promise.all([d.categories.get(input.categoryId), d.paymentMethods.get(input.paymentMethodId)])
  if (!cat || cat.type !== input.type) throw new MoneyError('請選擇分類')
  if (!pay) throw new MoneyError('請選擇付款方式')
}

function clean(input: TxInput) {
  return {
    type: input.type,
    amount: input.amount,
    merchant: input.merchant.trim().slice(0, MERCHANT_MAX),
    categoryId: input.categoryId,
    paymentMethodId: input.paymentMethodId,
    note: input.note.trim().slice(0, NOTE_MAX),
  }
}

/* ---------------- transactions ---------------- */

export async function addTransaction(input: TxInput, d: MoneyDB = db, now = new Date()): Promise<Transaction> {
  await validateTx(d, input, now)
  const stamp = now.toISOString()
  const tx: Transaction = {
    id: newId(),
    ...clean(input),
    occurredAt: occurredAtFor(input.date, now),
    source: 'manual',
    externalId: null,
    createdAt: stamp,
    updatedAt: stamp,
  }
  await d.transaction('rw', d.transactions, d.settings, async () => {
    await d.transactions.add(tx)
    await d.settings.put({ key: 'lastPaymentMethodId', value: tx.paymentMethodId })
  })
  return tx
}

export async function updateTransaction(id: string, input: TxInput, d: MoneyDB = db, now = new Date()): Promise<Transaction> {
  await validateTx(d, input, now)
  return d.transaction('rw', d.transactions, async () => {
    const prev = await d.transactions.get(id)
    if (!prev) throw new MoneyError('這筆紀錄已不存在')
    if (prev.source === PAYSLIP_SOURCE) throw new MoneyError('這筆收入由薪資單產生，請到薪資單修改')
    const keepTime = toYmd(new Date(prev.occurredAt)) === input.date
    const next: Transaction = {
      ...prev,
      ...clean(input),
      occurredAt: keepTime ? prev.occurredAt : occurredAtFor(input.date, now),
      updatedAt: now.toISOString(),
    }
    // D-20 "last used" follows new entries only; correcting an old record doesn't change the default.
    await d.transactions.put(next)
    return next
  })
}

/** Returns the deleted record so the caller can offer undo (D-25). */
export async function deleteTransaction(id: string, d: MoneyDB = db): Promise<Transaction> {
  return d.transaction('rw', d.transactions, async () => {
    const prev = await d.transactions.get(id)
    if (!prev) throw new MoneyError('這筆紀錄已不存在')
    if (prev.source === PAYSLIP_SOURCE) throw new MoneyError('這筆收入由薪資單產生，請到薪資單刪除')
    await d.transactions.delete(id)
    return prev
  })
}

export async function restoreTransaction(tx: Transaction, d: MoneyDB = db): Promise<void> {
  await d.transactions.put(tx)
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

export async function addCategory(input: { name: string; type: TxType; icon: string }, d: MoneyDB = db): Promise<Category> {
  const name = cleanName(input.name)
  return d.transaction('rw', d.categories, async () => {
    const same = await d.categories.where('type').equals(input.type).toArray()
    if (same.some((c) => c.name === name)) throw new MoneyError(`已經有「${name}」這個分類`)
    const cat: Category = {
      id: newId(),
      name,
      type: input.type,
      icon: input.icon,
      isActive: true,
      sortOrder: same.reduce((m, c) => Math.max(m, c.sortOrder), -1) + 1,
    }
    await d.categories.add(cat)
    return cat
  })
}

export async function updateCategory(id: string, patch: { name?: string; isActive?: boolean }, d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.categories, async () => {
    const cat = await d.categories.get(id)
    if (!cat) throw new MoneyError('找不到這個分類')
    const same = await d.categories.where('type').equals(cat.type).toArray()
    const next = { ...cat }
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

/** D-80: bank name and last four digits, credit cards only. */
function cardFields(type: PaymentType, bank?: string, last4?: string): Pick<PaymentMethod, 'bank' | 'cardLast4'> {
  if (type !== 'credit_card') return {}
  const b = (bank ?? '').trim().slice(0, 20)
  const l = (last4 ?? '').trim()
  if (l && !/^\d{4}$/.test(l)) throw new MoneyError('末四碼需為 4 位數字')
  return { ...(b ? { bank: b } : {}), ...(l ? { cardLast4: l } : {}) }
}

export async function addPaymentMethod(input: { name: string; type: PaymentType; bank?: string; cardLast4?: string }, d: MoneyDB = db): Promise<PaymentMethod> {
  const name = cleanName(input.name)
  const card = cardFields(input.type, input.bank, input.cardLast4)
  return d.transaction('rw', d.paymentMethods, async () => {
    const all = await d.paymentMethods.toArray()
    if (all.some((p) => p.name === name)) throw new MoneyError(`已經有「${name}」這個付款方式`)
    const pm: PaymentMethod = {
      id: newId(),
      name,
      type: input.type,
      isActive: true,
      sortOrder: all.reduce((m, p) => Math.max(m, p.sortOrder), -1) + 1,
      ...card,
    }
    await d.paymentMethods.add(pm)
    return pm
  })
}

export async function updatePaymentMethod(
  id: string,
  patch: { name?: string; isActive?: boolean; type?: PaymentType; bank?: string; cardLast4?: string },
  d: MoneyDB = db,
): Promise<void> {
  await d.transaction('rw', d.paymentMethods, async () => {
    const pm = await d.paymentMethods.get(id)
    if (!pm) throw new MoneyError('找不到這個付款方式')
    const all = await d.paymentMethods.toArray()
    const next = { ...pm }
    if (patch.name !== undefined) {
      next.name = cleanName(patch.name)
      if (all.some((p) => p.id !== id && p.name === next.name)) throw new MoneyError(`已經有「${next.name}」這個付款方式`)
    }
    if (patch.type !== undefined) next.type = patch.type
    if (patch.isActive === false && pm.isActive && all.filter((p) => p.id !== id && p.isActive).length === 0) {
      throw new MoneyError('至少要保留一個付款方式')
    }
    if (patch.isActive !== undefined) next.isActive = patch.isActive
    if (patch.type !== undefined || patch.bank !== undefined || patch.cardLast4 !== undefined) {
      const card = cardFields(next.type, patch.bank ?? next.bank, patch.cardLast4 ?? next.cardLast4)
      next.bank = card.bank
      next.cardLast4 = card.cardLast4
      if (next.bank === undefined) delete next.bank
      if (next.cardLast4 === undefined) delete next.cardLast4
    }
    await d.paymentMethods.put(next)
  })
}

/* ---------------- settings ---------------- */

export async function getSetting<T>(key: string, fallback: T, d: MoneyDB = db): Promise<T> {
  const row = await d.settings.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function setSetting(key: string, value: unknown, d: MoneyDB = db): Promise<void> {
  await d.settings.put({ key, value })
}
