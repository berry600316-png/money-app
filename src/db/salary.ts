import { db, type MoneyDB } from './db'
import { PAYSLIP_SOURCE, SALARY_CATEGORY_ID } from './defaults'
import { MoneyError, NAME_MAX } from './repo'
import type { Payslip, PayslipLine, SalaryItem, SalaryKind, SalaryNature, Transaction } from './types'
import { fromYmd, occurredAtFor, toYmd } from '../lib/dates'
import { MAX_AMOUNT } from '../lib/money'
import { currentMonthKey, isMonthKey, monthKeyLabel, monthShort } from '../lib/months'

export const COMPANY_MAX = 30

export interface PayslipInput {
  month: string
  payDate: string
  company: string
  paymentMethodId: string
  lines: { itemId: string; amount: number }[]
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

export function isLineAmount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_AMOUNT
}

/** Net pay = earnings − deductions (D-64). */
export function payslipTotals(lines: readonly { itemId: string; amount: number }[], kindOf: (itemId: string) => SalaryKind | undefined) {
  let earning = 0
  let deduction = 0
  for (const l of lines) {
    if (kindOf(l.itemId) === 'deduction') deduction += l.amount
    else earning += l.amount
  }
  return { earning, deduction, net: earning - deduction }
}

/**
 * Create (id = null) or update a payslip and keep its income transaction in step, all in one
 * database transaction (D-61..D-66). Throws MoneyError with a message the user can act on.
 */
export async function savePayslip(id: string | null, input: PayslipInput, d: MoneyDB = db, now = new Date()): Promise<Payslip> {
  if (!isMonthKey(input.month)) throw new MoneyError('請選擇所屬月份')
  if (input.month > currentMonthKey(now)) throw new MoneyError('所屬月份不能是未來的月份')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.payDate) || toYmd(fromYmd(input.payDate)) !== input.payDate) throw new MoneyError('發薪日不正確')
  if (input.payDate > toYmd(now)) throw new MoneyError('發薪日不能是未來的日期')
  const company = input.company.trim().slice(0, COMPANY_MAX)
  const seen = new Set<string>()
  for (const l of input.lines) {
    if (seen.has(l.itemId)) throw new MoneyError('薪資項目重複')
    seen.add(l.itemId)
    if (!isLineAmount(l.amount)) throw new MoneyError(`金額需為 0 到 ${MAX_AMOUNT.toLocaleString('en-US')} 的整數`)
  }

  return d.transaction('rw', [d.payslips, d.transactions, d.salaryItems, d.paymentMethods, d.categories], async () => {
    const prev = id ? await d.payslips.get(id) : undefined
    if (id && !prev) throw new MoneyError('這張薪資單已不存在')
    const sameMonth = await d.payslips.where('month').equals(input.month).first()
    if (sameMonth && sameMonth.id !== id) throw new MoneyError(`${monthKeyLabel(input.month)}已有薪資單`)
    const pay = await d.paymentMethods.get(input.paymentMethodId)
    if (!pay) throw new MoneyError('請選擇入帳方式')
    const salaryCat = await d.categories.get(SALARY_CATEGORY_ID)
    if (!salaryCat || salaryCat.type !== 'income') throw new MoneyError('找不到「薪資」收入分類')

    const items = new Map((await d.salaryItems.toArray()).map((i) => [i.id, i]))
    const lines: PayslipLine[] = input.lines.map((l) => {
      const it = items.get(l.itemId)
      if (!it) throw new MoneyError('有薪資項目已不存在，請重新開啟薪資單')
      // D-69: a line that was already on this payslip keeps the name it was saved with.
      const old = prev?.lines.find((p) => p.itemId === l.itemId)
      return { itemId: l.itemId, name: old?.name ?? it.name, amount: l.amount }
    })
    lines.sort((a, b) => order(items.get(a.itemId)!) - order(items.get(b.itemId)!))
    const { net } = payslipTotals(lines, (iid) => items.get(iid)?.kind)
    if (net > MAX_AMOUNT) throw new MoneyError(`實領金額超過 ${MAX_AMOUNT.toLocaleString('en-US')}，請檢查金額`)

    const stamp = now.toISOString()
    const slipId = prev?.id ?? newId()
    const oldTx = prev?.transactionId ? await d.transactions.get(prev.transactionId) : undefined
    let transactionId: string | null = null
    if (net > 0) {
      const keepTime = oldTx && toYmd(new Date(oldTx.occurredAt)) === input.payDate
      const tx: Transaction = {
        id: oldTx?.id ?? newId(),
        type: 'income',
        amount: net,
        merchant: company || `${monthShort(input.month).replace(' ', '')}薪資`,
        categoryId: SALARY_CATEGORY_ID,
        paymentMethodId: input.paymentMethodId,
        occurredAt: keepTime ? oldTx!.occurredAt : occurredAtFor(input.payDate, now),
        note: '',
        source: PAYSLIP_SOURCE,
        externalId: slipId,
        createdAt: oldTx?.createdAt ?? stamp,
        updatedAt: stamp,
      }
      await d.transactions.put(tx)
      transactionId = tx.id
    } else if (oldTx) {
      await d.transactions.delete(oldTx.id) // D-64: net ≤ 0 → no income
    }

    const slip: Payslip = {
      id: slipId,
      month: input.month,
      payDate: input.payDate,
      company,
      paymentMethodId: input.paymentMethodId,
      lines,
      transactionId,
      createdAt: prev?.createdAt ?? stamp,
      updatedAt: stamp,
    }
    await d.payslips.put(slip)
    return slip
  })
}

function order(it: SalaryItem) {
  return (it.kind === 'earning' ? 0 : 10_000) + it.sortOrder
}

/** D-75: delete a payslip and its income; returns both so the caller can offer undo. */
export async function deletePayslip(id: string, d: MoneyDB = db): Promise<{ payslip: Payslip; tx: Transaction | null }> {
  return d.transaction('rw', d.payslips, d.transactions, async () => {
    const payslip = await d.payslips.get(id)
    if (!payslip) throw new MoneyError('這張薪資單已不存在')
    const tx = payslip.transactionId ? ((await d.transactions.get(payslip.transactionId)) ?? null) : null
    if (tx) await d.transactions.delete(tx.id)
    await d.payslips.delete(id)
    return { payslip, tx }
  })
}

export async function restorePayslip(saved: { payslip: Payslip; tx: Transaction | null }, d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.payslips, d.transactions, async () => {
    const clash = await d.payslips.where('month').equals(saved.payslip.month).first()
    if (clash && clash.id !== saved.payslip.id) throw new MoneyError('這個月已經有另一張薪資單')
    await d.payslips.put(saved.payslip)
    if (saved.tx) await d.transactions.put(saved.tx)
  })
}

/* ---------------- salary items (D-68) ---------------- */

function cleanName(name: string): string {
  const n = name.trim().slice(0, NAME_MAX)
  if (!n) throw new MoneyError('請輸入名稱')
  return n
}

export async function addSalaryItem(input: { name: string; kind: SalaryKind; nature: SalaryNature }, d: MoneyDB = db): Promise<SalaryItem> {
  const name = cleanName(input.name)
  return d.transaction('rw', d.salaryItems, async () => {
    const same = await d.salaryItems.where('kind').equals(input.kind).toArray()
    if (same.some((i) => i.name === name)) throw new MoneyError(`已經有「${name}」這個項目`)
    const item: SalaryItem = {
      id: newId(),
      name,
      kind: input.kind,
      nature: input.nature,
      isActive: true,
      sortOrder: same.reduce((m, i) => Math.max(m, i.sortOrder), -1) + 1,
    }
    await d.salaryItems.add(item)
    return item
  })
}

/** Kind (earning/deduction) is fixed after creation (D-68). */
export async function updateSalaryItem(
  id: string,
  patch: { name?: string; nature?: SalaryNature; isActive?: boolean },
  d: MoneyDB = db,
): Promise<void> {
  await d.transaction('rw', d.salaryItems, async () => {
    const it = await d.salaryItems.get(id)
    if (!it) throw new MoneyError('找不到這個項目')
    const next = { ...it }
    if (patch.name !== undefined) {
      next.name = cleanName(patch.name)
      const same = await d.salaryItems.where('kind').equals(it.kind).toArray()
      if (same.some((i) => i.id !== id && i.name === next.name)) throw new MoneyError(`已經有「${next.name}」這個項目`)
    }
    if (patch.nature !== undefined) next.nature = patch.nature
    if (patch.isActive !== undefined) next.isActive = patch.isActive
    await d.salaryItems.put(next)
  })
}
