import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from './db'
import {
  addPaymentMethod,
  addTransaction,
  adjustBalance,
  balanceOf,
  deleteEntry,
  deleteTransaction,
  LAST_KEYS,
  moveCategory,
  restoreTransaction,
  setStartBalances,
  transferFee,
  updatePaymentMethod,
  updateTransaction,
  type TxInput,
} from './repo'
import { savePayslip } from './salary'
import { computeBalances, overview } from '../lib/accounts'
import { calendarMonth } from '../lib/calendar'
import { filterTx, groupByDay, summarize, yearByMonth, type TxFilter } from '../lib/stats'
import { summarizePlan } from '../lib/plan'

let d: MoneyDB
let n = 0
// 2026-10-12 18:00 local
const now = new Date(2026, 9, 12, 18, 0)

beforeEach(async () => {
  d = new MoneyDB(`acc-${n++}`)
  await d.open()
})
afterEach(() => d.close())

const spend = (p: Partial<TxInput>): TxInput => ({ type: 'expense', amount: 100, merchant: '', categoryId: 'food', paymentMethodId: 'cash', date: '2026-10-12', time: '12:00', note: '', ...p })
const income = (p: Partial<TxInput>): TxInput => ({ ...spend({}), type: 'income', categoryId: 'salary', ...p })
const emptyFilterForTest = (): TxFilter => ({ q: '', type: 'all', categoryIds: [], payment: null, dateMode: 'month', from: '', to: '' })
const move = (from: string, to: string, amount: number, p: Partial<TxInput> = {}): TxInput => ({ ...spend({}), type: 'transfer', categoryId: '', paymentMethodId: from, toAccountId: to, amount, ...p })

/** The setup of spec §19: 台新, 國泰, 現金, 悠遊卡 and a 台新 card paid from 台新. */
async function setup() {
  const start = (amount: number) => ({ date: '2026-10-01', amount })
  const taishin = await addPaymentMethod({ name: '台新 Richart', type: 'bank', start: start(20000) }, d, now)
  const cathay = await addPaymentMethod({ name: '國泰世華', type: 'bank', start: start(5000) }, d, now)
  await setStartBalances([{ id: 'cash', amount: 1500 }, { id: 'easycard', amount: 300 }], '2026-10-01', d, now)
  const card = await addPaymentMethod({ name: '台新信用卡', type: 'credit_card', cardLast4: '1234', payFromId: taishin.id, start: start(0) }, d, now)
  return { taishin: taishin.id, cathay: cathay.id, card: card.id }
}

async function balances() {
  const [accounts, txs, adjs] = await Promise.all([d.paymentMethods.toArray(), d.transactions.toArray(), d.adjustments.toArray()])
  return computeBalances(accounts, txs, adjs)
}

describe('accounts and balances (spec §17)', () => {
  it('17.1 opening balances; accounts without one are "尚未設定"', async () => {
    const a = await setup()
    const b = await balances()
    expect(b.get(a.taishin)).toBe(20000)
    expect(b.get('cash')).toBe(1500)
    expect(b.get(a.card)).toBe(0)
    expect(b.has('card')).toBe(false) // the seeded 信用卡 has no start yet
    expect(b.has('transfer')).toBe(false) // a way to pay never has a balance
    const ov = overview(await d.paymentMethods.toArray(), b)
    expect(ov.total).toBe(20000 + 5000 + 1500 + 300)
    expect(ov.unset.map((p) => p.id)).toEqual(['card'])
  })

  it('17.2 / 17.3 income adds, cash / bank / stored-value spending subtracts', async () => {
    const a = await setup()
    await addTransaction(income({ amount: 53000, paymentMethodId: a.taishin }), d, now)
    await addTransaction(spend({ amount: 120, paymentMethodId: 'cash' }), d, now)
    await addTransaction(spend({ amount: 3000, paymentMethodId: a.cathay }), d, now)
    await addTransaction(spend({ amount: 30, paymentMethodId: 'easycard' }), d, now)
    const b = await balances()
    expect(b.get(a.taishin)).toBe(73000)
    expect(b.get('cash')).toBe(1380)
    expect(b.get(a.cathay)).toBe(2000)
    expect(b.get('easycard')).toBe(270)
  })

  it('17.4 a card purchase is an expense and 預扣, the bank does not move', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 860, paymentMethodId: a.card }), d, now)
    const b = await balances()
    expect(b.get(a.card)).toBe(860)
    expect(b.get(a.taishin)).toBe(20000)
    expect(summarize(await d.transactions.toArray()).expense).toBe(860)
  })

  it('17.5 paying the bill moves money from the bank and is never a second expense', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 860, paymentMethodId: a.card }), d, now)
    await addTransaction(move(a.taishin, a.card, 860), d, now)
    const b = await balances()
    expect(b.get(a.card)).toBe(0)
    expect(b.get(a.taishin)).toBe(19140)
    const all = await d.transactions.toArray()
    expect(summarize(all)).toEqual({ expense: 860, income: 0, balance: -860 })
  })

  it('17.6 transfers between accounts, a withdrawal, a deposit, a top-up, and a fee', async () => {
    const a = await setup()
    await addTransaction(move(a.taishin, a.cathay, 5000), d, now)
    await addTransaction(move(a.taishin, 'cash', 2000), d, now)
    await addTransaction(move('cash', a.cathay, 500), d, now)
    const top = await addTransaction(move(a.taishin, 'easycard', 500, { fee: 15 }), d, now)
    const b = await balances()
    expect(b.get(a.taishin)).toBe(20000 - 5000 - 2000 - 500 - 15)
    expect(b.get(a.cathay)).toBe(5000 + 5000 + 500)
    expect(b.get('cash')).toBe(1500 + 2000 - 500)
    expect(b.get('easycard')).toBe(800)
    // The fee is its own expense, in 其他, from the source account; the transfer itself is not.
    const all = await d.transactions.toArray()
    const fee = all.find((t) => t.feeOf === top.id)!
    expect(fee).toMatchObject({ type: 'expense', amount: 15, categoryId: 'other', paymentMethodId: a.taishin, occurredAt: top.occurredAt })
    expect(summarize(all).expense).toBe(15)
    expect(await transferFee(top.id, d)).toBe(15)
  })

  it('a transfer fee follows the transfer when edited or deleted, and comes back on undo', async () => {
    const a = await setup()
    const t = await addTransaction(move(a.taishin, a.cathay, 1000, { fee: 15 }), d, now)
    await updateTransaction(t.id, move(a.taishin, a.cathay, 1000, { fee: 30 }), d, now)
    expect(await transferFee(t.id, d)).toBe(30)
    await updateTransaction(t.id, move(a.taishin, a.cathay, 1000, { fee: 0 }), d, now)
    expect(await transferFee(t.id, d)).toBe(0)
    await updateTransaction(t.id, move(a.taishin, a.cathay, 1000, { fee: 10 }), d, now)
    const removed = await deleteEntry(t.id, d)
    expect(removed).toHaveLength(2)
    expect(await d.transactions.count()).toBe(0)
    await restoreTransaction(removed, d)
    expect(await transferFee(t.id, d)).toBe(10)
    // Turning a transfer into an expense drops its fee record.
    await updateTransaction(t.id, spend({ amount: 1000, paymentMethodId: a.taishin }), d, now)
    expect(await transferFee(t.id, d)).toBe(0)
    expect((await d.transactions.get(t.id))!.toAccountId).toBeUndefined()
  })

  it('17.7 only records on or after the start date count; adjustments correct the balance', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 999, paymentMethodId: a.taishin, date: '2026-09-30' }), d, now) // before the start
    await addTransaction(spend({ amount: 100, paymentMethodId: a.taishin, date: '2026-10-01', time: '00:00' }), d, now)
    expect((await balances()).get(a.taishin)).toBe(19900)
    const adj = await adjustBalance(a.taishin, 20150, '利息', d, now)
    expect(adj).toMatchObject({ before: 19900, after: 20150, delta: 250 })
    expect(await balanceOf(a.taishin, d)).toBe(20150)
    await expect(adjustBalance(a.taishin, 20150, '', d, now)).rejects.toThrow('一樣')
    await expect(adjustBalance('card', 100, '', d, now)).rejects.toThrow('還沒設定')
    // Adjustments are never income or expense.
    expect(summarize(await d.transactions.toArray()).income).toBe(0)
  })

  it("D-118: today's balance starts at the moment it is entered, so nothing already in it counts twice", async () => {
    // Lunch at 12:00 was recorded before the balance was set at 18:00; the 3,200 already reflects it.
    await addTransaction(spend({ amount: 140, paymentMethodId: 'cash', time: '12:00' }), d, now)
    await setStartBalances([{ id: 'cash', amount: 3200 }], '2026-10-12', d, now)
    expect((await d.paymentMethods.get('cash'))!.balanceFrom).toBe(new Date(now.getTime() + 1).toISOString())
    expect(await balanceOf('cash', d)).toBe(3200)
    // A forgotten earlier purchase typed in afterwards is also already in the balance.
    const later = new Date(2026, 9, 12, 18, 5)
    await addTransaction(spend({ amount: 60, paymentMethodId: 'cash', time: '12:30' }), d, later)
    expect(await balanceOf('cash', d)).toBe(3200)
    // Something spent from now on counts.
    await addTransaction(spend({ amount: 80, paymentMethodId: 'cash', time: '18:05' }), d, later)
    expect(await balanceOf('cash', d)).toBe(3120)
    // Saving the same date and amount again keeps the start; a new amount starts afresh.
    await updatePaymentMethod('cash', { start: { date: '2026-10-12', amount: 3200 } }, d, later)
    expect((await d.paymentMethods.get('cash'))!.balanceFrom).toBe(new Date(now.getTime() + 1).toISOString())
    await updatePaymentMethod('cash', { start: { date: '2026-10-12', amount: 3000 } }, d, later)
    expect((await d.paymentMethods.get('cash'))!.balanceFrom).toBe(new Date(later.getTime() + 1).toISOString())
    expect(await balanceOf('cash', d)).toBe(3000)
  })

  it('income filed under a card or a way to pay (older records) moves no balance', async () => {
    const a = await setup()
    await d.transactions.add({
      id: 'old-income', type: 'income', amount: 53000, merchant: '', categoryId: 'salary', paymentMethodId: a.card,
      occurredAt: new Date(2026, 9, 5, 12).toISOString(), note: '', source: 'manual', externalId: null,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    })
    await addTransaction(income({ amount: 100, paymentMethodId: 'transfer' }), d, now)
    const b = await balances()
    expect(b.get(a.card)).toBe(0)
    expect(b.get(a.taishin)).toBe(20000)
  })

  it('D-120: paying with 轉帳 / 行動支付 takes the money from the chosen account', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 15000, categoryId: 'home', paymentMethodId: 'transfer', sourceAccountId: a.taishin }), d, now)
    await addTransaction(spend({ amount: 200, paymentMethodId: 'mobile', sourceAccountId: 'cash' }), d, now)
    const b = await balances()
    expect(b.get(a.taishin)).toBe(5000)
    expect(b.get('cash')).toBe(1300)
    expect((await d.settings.get(LAST_KEYS.source))?.value).toBe('cash')
    await expect(addTransaction(spend({ paymentMethodId: 'transfer', sourceAccountId: a.card }), d, now)).rejects.toThrow('從哪個帳戶付')
    await expect(addTransaction(spend({ paymentMethodId: 'cash', sourceAccountId: a.taishin }), d, now)).rejects.toThrow('付款方式不正確')
  })

  it('D-119: the first payment of a card without a payer remembers it', async () => {
    await setup()
    await updatePaymentMethod('card', { start: { date: '2026-10-01', amount: 1530 } }, d, now)
    expect((await d.paymentMethods.get('card'))!.payFromId).toBeUndefined()
    await addTransaction(move('cash', 'card', 1000), d, now)
    expect((await d.paymentMethods.get('card'))!.payFromId).toBe('cash')
    expect((await balances()).get('card')).toBe(530)
  })

  it('rejects transfers that make no sense', async () => {
    const a = await setup()
    await expect(addTransaction(move(a.card, a.taishin, 100), d, now)).rejects.toThrow('從哪個帳戶轉出')
    await expect(addTransaction(move(a.taishin, a.taishin, 100), d, now)).rejects.toThrow('同一個帳戶')
    await expect(addTransaction(move(a.taishin, 'transfer', 100), d, now)).rejects.toThrow('轉到哪個帳戶')
    await expect(addTransaction(move(a.taishin, 'nope', 100), d, now)).rejects.toThrow('轉到哪個帳戶')
    // A transfer never keeps a category or a merchant.
    const t = await addTransaction(move(a.taishin, a.cathay, 100, { categoryId: 'food', merchant: 'x' }), d, now)
    expect(t).toMatchObject({ categoryId: '', merchant: '' })
  })

  it('remembers the last accounts per kind', async () => {
    const a = await setup()
    await addTransaction(income({ paymentMethodId: a.cathay }), d, now)
    await addTransaction(move(a.taishin, 'cash', 100), d, now)
    expect((await d.settings.get(LAST_KEYS.income))?.value).toBe(a.cathay)
    expect((await d.settings.get(LAST_KEYS.from))?.value).toBe(a.taishin)
    expect((await d.settings.get(LAST_KEYS.to))?.value).toBe('cash')
  })

  it('validates start balances and the card payer', async () => {
    await expect(addPaymentMethod({ name: 'x', type: 'bank', start: { date: '2026-10-13', amount: 1 } }, d, now)).rejects.toThrow('未來')
    await expect(addPaymentMethod({ name: 'x', type: 'bank', start: { date: '2026-02-31', amount: 1 } }, d, now)).rejects.toThrow('起算日期不正確')
    await expect(addPaymentMethod({ name: 'x', type: 'bank', start: { date: '2026-10-01', amount: -1 } }, d, now)).rejects.toThrow('金額')
    await expect(addPaymentMethod({ name: 'y', type: 'credit_card', payFromId: 'transfer' }, d, now)).rejects.toThrow('繳卡費的帳戶')
    // Ways to pay never hold a balance, even when asked to.
    const m = await addPaymentMethod({ name: 'LINE Pay', type: 'mobile', start: { date: '2026-10-01', amount: 100 } }, d, now)
    expect(m.balanceFrom).toBeUndefined()
    await updatePaymentMethod('cash', { start: null }, d, now)
    expect((await d.paymentMethods.get('cash'))!.openingBalance).toBeUndefined()
  })

  it('17.11 a payslip into an account adds to its balance', async () => {
    const a = await setup()
    await savePayslip(null, { month: '2026-10', payDate: '2026-10-05', company: '公司', paymentMethodId: a.taishin, lines: [{ itemId: 'BASE_SALARY', amount: 50000 }] }, d, now)
    expect((await balances()).get(a.taishin)).toBe(70000)
  })

  it('17.12 an imported card purchase (source notification) adds to the card 預扣 like any other', async () => {
    const a = await setup()
    await d.transactions.add({
      id: 'n1', type: 'expense', amount: 85, merchant: '全家', categoryId: 'food', paymentMethodId: a.card,
      occurredAt: new Date(2026, 9, 5, 12).toISOString(), note: '', source: 'notification', externalId: 'cap-1',
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    })
    expect((await balances()).get(a.card)).toBe(85)
  })
})

describe('transfers never count as income or expense (17.8 / 17.9)', () => {
  it('summaries, day groups, the calendar, the year and the plan ignore transfers', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 100, paymentMethodId: 'cash' }), d, now)
    await addTransaction(move(a.taishin, a.cathay, 5000), d, now)
    const all = await d.transactions.toArray()
    expect(summarize(all)).toEqual({ expense: 100, income: 0, balance: -100 })
    expect(groupByDay(all)[0]).toMatchObject({ expense: 100, income: 0 })
    expect(calendarMonth(all, { y: 2026, m: 9 }, now).days[11].expense).toBe(100)
    expect(yearByMonth(all, 2026, now)[9]).toMatchObject({ expense: 100, income: 0 })
    expect(summarizePlan('2026-10', null, [], all, new Map()).otherSpending).toBe(100)
  })

  it('an account filter shows its transfers in both directions, also with a date range', async () => {
    const a = await setup()
    await addTransaction(move(a.taishin, a.cathay, 5000, { date: '2026-10-03' }), d, now)
    await addTransaction(move('cash', a.taishin, 300, { date: '2026-10-08' }), d, now)
    await addTransaction(spend({ amount: 120, paymentMethodId: 'transfer', sourceAccountId: a.taishin, date: '2026-10-10' }), d, now)
    await addTransaction(spend({ amount: 70, paymentMethodId: 'cash' }), d, now)
    const all = await d.transactions.toArray()
    const ctx = { month: { y: 2026, m: 9 }, isCard: () => false, names: { category: () => '', payment: () => '' } }
    expect(filterTx(all, { ...emptyFilterForTest(), payment: a.taishin }, ctx)).toHaveLength(3)
    expect(filterTx(all, { ...emptyFilterForTest(), payment: a.taishin, dateMode: 'range', from: '2026-10-05', to: '2026-10-12' }, ctx)).toHaveLength(2)
    expect(filterTx(all, { ...emptyFilterForTest(), type: 'transfer' }, ctx)).toHaveLength(2)
  })
})

describe('categories (D-122)', () => {
  it('moves a category up and down within its type', async () => {
    const order = async () => (await d.categories.where('type').equals('expense').toArray()).sort((x, y) => x.sortOrder - y.sortOrder).map((c) => c.id)
    expect((await order()).slice(0, 3)).toEqual(['food', 'transport', 'daily'])
    await moveCategory('daily', -1, d)
    expect((await order()).slice(0, 3)).toEqual(['food', 'daily', 'transport'])
    await moveCategory('food', -1, d) // already first: nothing happens
    expect((await order())[0]).toBe('food')
    const incomes = (await d.categories.where('type').equals('income').toArray()).map((c) => c.sortOrder).sort()
    expect(incomes).toEqual([0, 1, 2]) // other types untouched
  })
})

describe('deleting', () => {
  it('deleteTransaction still returns the single record for older callers', async () => {
    const t = await addTransaction(spend({}), d, now)
    expect((await deleteTransaction(t.id, d)).id).toBe(t.id)
  })
})
