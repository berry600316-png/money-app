/* D-140: deleting settings items (never used: for good; used: 已刪除, restorable). */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from './db'
import { addCategory, addPaymentMethod, addTransaction, LAST_KEYS, setStartBalances, type TxInput } from './repo'
import { addSalaryItem, savePayslip } from './salary'
import { addPlanTemplate, deletePlanTemplate, planTemplateDeleteImpact, setPlanTemplateActive, skipPlannedExpense, startPlan } from './planRepo'
import {
  categoryDeleteImpact,
  deleteCategory,
  deleteMessage,
  deletePaymentMethod,
  deleteSalaryItem,
  paymentDeleteImpact,
  restoreCategory,
  restorePaymentMethod,
  restoreSalaryItem,
} from './deletion'
import { computeBalances, overview } from '../lib/accounts'
import { getNoticeTypes, NOTICE_METHODS_SETTING, saveNoticeType } from '../card/cardRepo'
import { targetProblem } from '../card/noticeTypes'
import { buildBackup, parseBackup } from '../backup/format'
import { readAllData } from '../backup/store'

let d: MoneyDB
let n = 0
const now = new Date(2026, 9, 14, 12, 0)

beforeEach(async () => {
  d = new MoneyDB(`del-${n++}`)
  await d.open()
})
afterEach(() => d.close())

const spend = (p: Partial<TxInput>): TxInput => ({ type: 'expense', amount: 100, merchant: '', categoryId: 'food', paymentMethodId: 'cash', date: '2026-10-12', time: '12:00', note: '', ...p })
const start = { date: '2026-10-01', amount: 20000 }

async function setup() {
  const bank = await addPaymentMethod({ name: '台新', type: 'bank', start }, d, now)
  const card = await addPaymentMethod({ name: '台新信用卡', type: 'credit_card', payFromId: bank.id, start: { ...start, amount: 0 } }, d, now)
  const debit = await addPaymentMethod({ name: '台新金融卡', type: 'debit_card', payFromId: bank.id }, d, now)
  const wallet = await addPaymentMethod({ name: 'LINE Pay', type: 'mobile', cards: [card.id, debit.id] }, d, now)
  return { bank: bank.id, card: card.id, debit: debit.id, wallet: wallet.id }
}

describe('categories', () => {
  it('never used: gone for good; used: 已刪除 and back again', async () => {
    const fresh = await addCategory({ name: '寵物', type: 'expense', icon: 'pet' }, d)
    expect(await categoryDeleteImpact(fresh.id, d)).toMatchObject({ mode: 'hard', uses: 0, blocked: '' })
    await deleteCategory(fresh.id, d)
    expect(await d.categories.get(fresh.id)).toBeUndefined()

    await addTransaction(spend({ categoryId: 'food' }), d, now)
    const r = await deleteCategory('food', d)
    expect(r).toMatchObject({ mode: 'soft', uses: 1 })
    expect((await d.categories.get('food'))!.isActive).toBe(false)
    // The record still has its category.
    expect((await d.transactions.toArray())[0].categoryId).toBe('food')
    await restoreCategory('food', d)
    expect((await d.categories.get('food'))!.isActive).toBe(true)
  })
  it('Q133: 薪資 and 其他 cannot be deleted; nor the last one of a kind', async () => {
    expect((await categoryDeleteImpact('salary', d)).blocked).toContain('薪資單')
    expect((await categoryDeleteImpact('other', d)).blocked).toContain('手續費')
    await expect(deleteCategory('salary', d)).rejects.toThrow('不能刪除')
    const income = (await d.categories.where('type').equals('income').toArray()).filter((c) => c.id !== 'salary')
    for (const c of income) await deleteCategory(c.id, d)
    // Only 薪資 is left, and it is protected anyway; the last expense category is refused too.
    const expense = (await d.categories.where('type').equals('expense').toArray()).filter((c) => c.id !== 'other')
    for (const c of expense) await deleteCategory(c.id, d)
    expect((await categoryDeleteImpact('other', d)).blocked).not.toBe('')
  })
})

describe('accounts and ways to pay', () => {
  it('never used: removed, with every link to it; a notice type pointing at it shows it is gone', async () => {
    const a = await setup()
    await saveNoticeType({ name: 'LINE Pay', keywords: ['LINE Pay'], paymentMethodId: a.wallet, cardId: a.debit }, d)
    await d.settings.bulkPut([
      { key: LAST_KEYS.expense, value: a.debit },
      { key: LAST_KEYS.walletCards, value: { [a.wallet]: a.debit } },
      { key: NOTICE_METHODS_SETTING, value: { linepay: a.wallet } },
    ])
    expect(await paymentDeleteImpact(a.debit, d)).toMatchObject({ mode: 'hard', uses: 0 })
    await deletePaymentMethod(a.debit, d)
    expect(await d.paymentMethods.get(a.debit)).toBeUndefined()
    expect((await d.paymentMethods.get(a.wallet))!.cards).toEqual([a.card])
    expect(await d.settings.get(LAST_KEYS.expense)).toBeUndefined()
    expect((await d.settings.get(LAST_KEYS.walletCards))!.value).toEqual({})
    expect((await d.settings.get(NOTICE_METHODS_SETTING))!.value).toEqual({ linepay: a.wallet })
    const [t] = await getNoticeTypes(d)
    expect(targetProblem(t, await d.paymentMethods.toArray())).toBe('記到的卡已刪除')
  })
  it('Q134 A: a used credit card with 預扣 goes to 已刪除; the 預扣 still counts until paid', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 3200, paymentMethodId: a.card }), d, now)
    const impact = await paymentDeleteImpact(a.card, d)
    expect(impact).toMatchObject({ mode: 'soft', uses: 1, owed: 3200 })
    expect(deleteMessage(impact, 'card')).toContain('還有 NT$ 3,200 卡費沒繳')
    await deletePaymentMethod(a.card, d)
    const all = await readAllData(d)
    expect(all.paymentMethods.find((p) => p.id === a.card)!.isActive).toBe(false)
    const b = computeBalances(all.paymentMethods, all.transactions, all.adjustments)
    expect(overview(all.paymentMethods, b).pending).toBe(3200)
  })
  it('Q135 A: an account with money says how much; it still counts', async () => {
    await setStartBalances([{ id: 'cash', amount: 1500 }], '2026-10-01', d, now)
    const impact = await paymentDeleteImpact('cash', d)
    expect(impact).toMatchObject({ mode: 'soft', owed: 1500 })
    expect(deleteMessage(impact, 'account')).toContain('還有餘額 NT$ 1,500')
    // Money in it, even with no record yet: never removed for good.
    await deletePaymentMethod('cash', d)
    expect((await d.paymentMethods.get('cash'))!.isActive).toBe(false)
    const all = await readAllData(d)
    expect(overview(all.paymentMethods, computeBalances(all.paymentMethods, all.transactions, all.adjustments)).total).toBe(1500)
  })
  it('Q136 B: a bank goes with the cards in use under it, and comes back with them', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 500, paymentMethodId: a.card }), d, now)
    // The debit card was deleted on its own before (used, so 已刪除): it does not come back with the bank.
    await addTransaction(spend({ amount: 50, paymentMethodId: a.debit, sourceAccountId: a.bank }), d, now)
    await deletePaymentMethod(a.debit, d)
    const impact = await paymentDeleteImpact(a.bank, d)
    expect(impact.mode).toBe('soft')
    expect(impact.cascade).toEqual([{ id: a.card, name: '台新信用卡', owed: 500 }])
    expect(deleteMessage(impact, 'account')).toContain('底下的「台新信用卡」會一起刪除（台新信用卡 還有 NT$ 500 卡費沒繳）')
    await deletePaymentMethod(a.bank, d)
    expect(await d.paymentMethods.get(a.card)).toMatchObject({ isActive: false, deletedWith: a.bank })
    expect(await restorePaymentMethod(a.bank, d)).toEqual(['台新信用卡'])
    expect(await d.paymentMethods.get(a.card)).toMatchObject({ isActive: true })
    expect('deletedWith' in (await d.paymentMethods.get(a.card))!).toBe(false)
    expect((await d.paymentMethods.get(a.debit))!.isActive).toBe(false)
  })
  it('the last way to pay in use cannot go', async () => {
    for (const p of await d.paymentMethods.toArray()) if (p.id !== 'cash') await deletePaymentMethod(p.id, d)
    expect((await paymentDeleteImpact('cash', d)).blocked).toBe('至少要保留一個帳戶或付款方式')
    await expect(deletePaymentMethod('cash', d)).rejects.toThrow('至少要保留')
  })
  it('a deleted card keeps its bank in a backup; a link to nothing is dropped', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 500, paymentMethodId: a.card }), d, now)
    await deletePaymentMethod(a.bank, d)
    const file = JSON.parse(JSON.stringify(buildBackup(await readAllData(d), now)))
    expect(parseBackup(JSON.stringify(file)).paymentMethods.find((p) => p.id === a.card)!.deletedWith).toBe(a.bank)
    file.paymentMethods.find((p: { id: string }) => p.id === a.card).deletedWith = 'nope'
    expect('deletedWith' in parseBackup(JSON.stringify(file)).paymentMethods.find((p) => p.id === a.card)!).toBe(false)
  })
})

describe('salary items and fixed items', () => {
  it('a salary item on a payslip goes to 已刪除; one never used is removed', async () => {
    const fresh = await addSalaryItem({ name: '交通津貼', kind: 'earning', nature: 'fixed' }, d)
    expect((await deleteSalaryItem(fresh.id, d)).mode).toBe('hard')
    expect(await d.salaryItems.get(fresh.id)).toBeUndefined()
    const used = await addSalaryItem({ name: '全勤', kind: 'earning', nature: 'fixed' }, d)
    await savePayslip(null, { month: '2026-09', payDate: '2026-10-05', company: '', paymentMethodId: 'cash', lines: [{ itemId: used.id, amount: 1000 }] }, d, now)
    expect(await deleteSalaryItem(used.id, d)).toMatchObject({ mode: 'soft', uses: 1 })
    await restoreSalaryItem(used.id, d)
    expect((await d.salaryItems.get(used.id))!.isActive).toBe(true)
  })
  it('a fixed item whose only items were untouched is removed; one with a skipped month is 已刪除', async () => {
    await startPlan('2026-10', d, now)
    const input = { name: '房租', amount: 12000, day: 5, fixedDate: true, categoryId: 'home', paymentMethodId: 'cash' }
    const fresh = await addPlanTemplate(input, '2026-10', d, now)
    expect(await planTemplateDeleteImpact(fresh.id, d, now)).toMatchObject({ mode: 'hard', uses: 0 })
    await deletePlanTemplate(fresh.id, d, now)
    expect(await d.planTemplates.get(fresh.id)).toBeUndefined()
    expect(await d.plannedExpenses.filter((x) => x.templateId === fresh.id).count()).toBe(0)

    const kept = await addPlanTemplate({ ...input, name: '管理費' }, '2026-10', d, now)
    const item = (await d.plannedExpenses.filter((x) => x.templateId === kept.id).toArray())[0]
    await skipPlannedExpense(item.id, d, now)
    expect(await deletePlanTemplate(kept.id, d, now)).toMatchObject({ mode: 'soft', uses: 1 })
    expect((await d.planTemplates.get(kept.id))!.isActive).toBe(false)
    await setPlanTemplateActive(kept.id, true, d, now)
    expect((await d.planTemplates.get(kept.id))!.isActive).toBe(true)
  })
})
