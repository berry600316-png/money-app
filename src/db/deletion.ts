/*
 * D-140: deleting settings items: categories, accounts and ways to pay, salary items (fixed plan items are
 * in planRepo). Never used = removed for good (Q130 A). Used = moved to 已刪除 (isActive false, the same
 * state 停用 used to be, Q131 A): every record keeps it, it shows under 已刪除 and can be restored.
 */
import { db, type MoneyDB } from './db'
import { LAST_KEYS, MoneyError } from './repo'
import type { PaymentMethod } from './types'
import { computeBalances, isCard } from '../lib/accounts'
import { DEFAULT_CARDS_SETTING, NOTICE_METHODS_SETTING } from '../card/cardRepo'

export interface DeleteImpact {
  /** 'hard' = nothing uses it: removed for good; 'soft' = moved to 已刪除, records kept. */
  mode: 'hard' | 'soft'
  /** Records using it (transactions, payslips, statements, plans, balance corrections). */
  uses: number
  /** Why it cannot be deleted ('' = it can). */
  blocked: string
  /** A credit card's unpaid 預扣 or an account's balance; 0 = nothing to mention (Q134 A, Q135 A). */
  owed: number
  /** Q136 B: the cards deleted together with a bank, each with its unpaid 預扣. */
  cascade: { id: string; name: string; owed: number }[]
}

/** Q133: categories the app itself uses. */
export const PROTECTED_CATEGORIES: Readonly<Record<string, string>> = {
  salary: '薪資單需要這個分類，不能刪除',
  other: '手續費和匯入的消費會用到這個分類，不能刪除',
}

const PAY_TABLES = (d: MoneyDB) => [d.paymentMethods, d.settings, d.transactions, d.payslips, d.adjustments, d.cardStatements, d.planTemplates, d.plannedExpenses]

/* ---------------- accounts and ways to pay ---------------- */

async function paymentImpactIn(d: MoneyDB, id: string) {
  const all = await d.paymentMethods.toArray()
  const p = all.find((x) => x.id === id)
  if (!p) throw new MoneyError('找不到這個帳戶或付款方式')
  const [txs, slips, adjs, stmts, tpls, planned] = await Promise.all([
    d.transactions.toArray(),
    d.payslips.toArray(),
    d.adjustments.toArray(),
    d.cardStatements.toArray(),
    d.planTemplates.toArray(),
    d.plannedExpenses.toArray(),
  ])
  const uses =
    txs.filter((t) => t.paymentMethodId === id || t.toAccountId === id || t.sourceAccountId === id || t.cardId === id).length +
    slips.filter((s) => s.paymentMethodId === id).length +
    adjs.filter((a) => a.accountId === id).length +
    stmts.filter((s) => s.paymentMethodId === id).length +
    tpls.filter((t) => t.paymentMethodId === id).length +
    planned.filter((x) => x.paymentMethodId === id).length
  const balances = computeBalances(all, txs, adjs)
  const owedOf = (x: PaymentMethod) => {
    const b = balances.get(x.id) ?? 0
    return isCard(x) ? Math.max(b, 0) : b
  }
  // Q136 B: a bank goes with the cards still in use under it.
  const cards = p.type === 'bank' ? all.filter((c) => (isCard(c) || c.type === 'debit_card') && c.payFromId === id && c.isActive) : []
  const leaving = new Set([id, ...cards.map((c) => c.id)])
  const owed = owedOf(p)
  const impact: DeleteImpact = {
    // Kept as 已刪除 when anything uses it, a card of a bank (even one deleted before) still points at it,
    // or money is in it (an opening balance alone, Q135 A): what is removed for good never held money.
    mode: uses === 0 && owed === 0 && !all.some((c) => c.payFromId === id) ? 'hard' : 'soft',
    uses,
    blocked: all.some((x) => x.isActive && !leaving.has(x.id)) ? '' : '至少要保留一個帳戶或付款方式',
    owed,
    cascade: cards.map((c) => ({ id: c.id, name: c.name, owed: owedOf(c) })),
  }
  return { p, all, impact }
}

export async function paymentDeleteImpact(id: string, d: MoneyDB = db): Promise<DeleteImpact> {
  return d.transaction('r', PAY_TABLES(d), async () => (await paymentImpactIn(d, id)).impact)
}

/**
 * Delete an account or way to pay. Never used: removed, and so is every link to it (the cards a 行動支付
 * holds, what was used last); a notice type pointing at it stays and shows it can no longer be used
 * (Q127 A). Used: 已刪除, a bank together with its cards.
 */
export async function deletePaymentMethod(id: string, d: MoneyDB = db): Promise<DeleteImpact> {
  return d.transaction('rw', PAY_TABLES(d), async () => {
    const { p, all, impact } = await paymentImpactIn(d, id)
    if (impact.blocked) throw new MoneyError(impact.blocked)
    if (impact.mode === 'soft') {
      await d.paymentMethods.put({ ...p, isActive: false })
      for (const c of impact.cascade) {
        const card = all.find((x) => x.id === c.id)!
        await d.paymentMethods.put({ ...card, isActive: false, deletedWith: id })
      }
      return impact
    }
    await d.paymentMethods.delete(id)
    for (const w of all) {
      if (w.cards?.includes(id)) {
        const cards = w.cards.filter((x) => x !== id)
        const next: PaymentMethod = { ...w, cards }
        if (!cards.length) delete next.cards
        await d.paymentMethods.put(next)
      }
    }
    await forgetInSettings(d, id)
    return impact
  })
}

/** What was remembered about a payment method that is gone. */
async function forgetInSettings(d: MoneyDB, id: string) {
  for (const key of [LAST_KEYS.expense, LAST_KEYS.income, LAST_KEYS.source, LAST_KEYS.from, LAST_KEYS.to]) {
    if ((await d.settings.get(key))?.value === id) await d.settings.delete(key)
  }
  for (const key of [LAST_KEYS.walletCards, NOTICE_METHODS_SETTING, DEFAULT_CARDS_SETTING]) {
    const v = (await d.settings.get(key))?.value
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const kept = Object.entries(v as Record<string, unknown>).filter(([k, x]) => k !== id && x !== id)
    if (kept.length !== Object.keys(v).length) await d.settings.put({ key, value: Object.fromEntries(kept) })
  }
}

/** Back from 已刪除; a bank brings back the cards deleted together with it (Q136 B). */
export async function restorePaymentMethod(id: string, d: MoneyDB = db): Promise<string[]> {
  return d.transaction('rw', d.paymentMethods, async () => {
    const p = await d.paymentMethods.get(id)
    if (!p) throw new MoneyError('找不到這個帳戶或付款方式')
    const back = (x: PaymentMethod) => {
      const next = { ...x, isActive: true }
      delete next.deletedWith
      return next
    }
    await d.paymentMethods.put(back(p))
    const cards = (await d.paymentMethods.toArray()).filter((c) => c.deletedWith === id)
    for (const c of cards) await d.paymentMethods.put(back(c))
    return cards.map((c) => c.name)
  })
}

/* ---------------- categories ---------------- */

async function categoryImpactIn(d: MoneyDB, id: string): Promise<DeleteImpact> {
  const c = await d.categories.get(id)
  if (!c) throw new MoneyError('找不到這個分類')
  const uses =
    (await d.transactions.where('categoryId').equals(id).count()) +
    (await d.planTemplates.filter((t) => t.categoryId === id).count()) +
    (await d.plannedExpenses.filter((x) => x.categoryId === id).count())
  const others = await d.categories.where('type').equals(c.type).filter((x) => x.id !== id && x.isActive).count()
  const blocked = PROTECTED_CATEGORIES[id] ?? (others ? '' : `至少要保留一個${c.type === 'expense' ? '支出' : '收入'}分類`)
  return { mode: uses ? 'soft' : 'hard', uses, blocked, owed: 0, cascade: [] }
}

const CAT_TABLES = (d: MoneyDB) => [d.categories, d.transactions, d.planTemplates, d.plannedExpenses]

export async function categoryDeleteImpact(id: string, d: MoneyDB = db): Promise<DeleteImpact> {
  return d.transaction('r', CAT_TABLES(d), () => categoryImpactIn(d, id))
}

export async function deleteCategory(id: string, d: MoneyDB = db): Promise<DeleteImpact> {
  return d.transaction('rw', CAT_TABLES(d), async () => {
    const impact = await categoryImpactIn(d, id)
    if (impact.blocked) throw new MoneyError(impact.blocked)
    if (impact.mode === 'hard') await d.categories.delete(id)
    else await d.categories.update(id, { isActive: false })
    return impact
  })
}

export async function restoreCategory(id: string, d: MoneyDB = db): Promise<void> {
  if (!(await d.categories.update(id, { isActive: true }))) throw new MoneyError('找不到這個分類')
}

/* ---------------- salary items ---------------- */

async function salaryImpactIn(d: MoneyDB, id: string): Promise<DeleteImpact> {
  if (!(await d.salaryItems.get(id))) throw new MoneyError('找不到這個項目')
  const uses = await d.payslips.filter((s) => s.lines.some((l) => l.itemId === id)).count()
  return { mode: uses ? 'soft' : 'hard', uses, blocked: '', owed: 0, cascade: [] }
}

export async function salaryItemDeleteImpact(id: string, d: MoneyDB = db): Promise<DeleteImpact> {
  return d.transaction('r', [d.salaryItems, d.payslips], () => salaryImpactIn(d, id))
}

export async function deleteSalaryItem(id: string, d: MoneyDB = db): Promise<DeleteImpact> {
  return d.transaction('rw', [d.salaryItems, d.payslips], async () => {
    const impact = await salaryImpactIn(d, id)
    if (impact.mode === 'hard') await d.salaryItems.delete(id)
    else await d.salaryItems.update(id, { isActive: false })
    return impact
  })
}

export async function restoreSalaryItem(id: string, d: MoneyDB = db): Promise<void> {
  if (!(await d.salaryItems.update(id, { isActive: true }))) throw new MoneyError('找不到這個項目')
}

/* ---------------- the confirmation ---------------- */

const money = (n: number) => `NT$ ${Math.abs(n).toLocaleString('en-US')}`

/** Q137: what the confirmation says, in the order it matters. */
export function deleteMessage(impact: DeleteImpact, kind: 'card' | 'account' | 'other'): string {
  const out: string[] = []
  if (impact.mode === 'hard') out.push('沒有任何紀錄用到它，刪除後無法復原。')
  else out.push(`${impact.uses ? `過去 ${impact.uses} 筆紀錄會保留，` : '過去的紀錄會保留，'}之後可以在「已刪除」恢復。`)
  if (kind === 'card' && impact.owed > 0) out.push(`還有 ${money(impact.owed)} 卡費沒繳，刪除後仍算在預扣裡，直到繳清。`)
  if (kind === 'account' && impact.owed !== 0) {
    out.push(`還有${impact.owed < 0 ? '負的' : ''}餘額 ${money(impact.owed)}，刪除後仍算進帳戶合計，直到餘額變成 0。`)
  }
  if (impact.cascade.length) {
    const owing = impact.cascade.filter((c) => c.owed > 0)
    out.push(
      `底下的${impact.cascade.map((c) => `「${c.name}」`).join('、')}會一起刪除${
        owing.length ? `（${owing.map((c) => `${c.name} 還有 ${money(c.owed)} 卡費沒繳`).join('；')}）` : ''
      }，恢復時也會一起恢復。`,
    )
  }
  return out.join('')
}
