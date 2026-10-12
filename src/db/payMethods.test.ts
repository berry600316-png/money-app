import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from './db'
import { addPaymentMethod, addTransaction, setStartBalances, updatePaymentMethod, updateTransaction, type TxInput } from './repo'
import type { CardStatement, StatementEntry } from './types'
import { accountFlow, chargedTo, computeBalances, defaultPay, describePay, payGroups, payKey } from '../lib/accounts'
import { filterTx, type TxFilter } from '../lib/stats'
import { reconcile } from '../card/reconcile'
import { buildBackup, parseBackup, toCsv } from '../backup/format'
import { readAllData, restoreBackup, restoreRange } from '../backup/store'

let d: MoneyDB
let n = 0
const now = new Date(2026, 9, 12, 18, 0)

beforeEach(async () => {
  d = new MoneyDB(`pay-${n++}`)
  await d.open()
})
afterEach(() => d.close())

const spend = (p: Partial<TxInput>): TxInput => ({ type: 'expense', amount: 100, merchant: '', categoryId: 'food', paymentMethodId: 'cash', date: '2026-10-12', time: '12:00', note: '', ...p })

/** 台新 with its card and an Apple Pay bound to the card; LINE Pay bound to 台新 itself; cash. */
async function setup() {
  const start = (amount: number) => ({ date: '2026-10-01', amount })
  const taishin = await addPaymentMethod({ name: '台新 Richart', type: 'bank', start: start(20000) }, d, now)
  const card = await addPaymentMethod({ name: '台新@GoGo', type: 'credit_card', cardLast4: '1234', payFromId: taishin.id, start: start(0) }, d, now)
  const apple = await addPaymentMethod({ name: 'Apple Pay', type: 'mobile', boundTo: card.id }, d, now)
  const line = await addPaymentMethod({ name: 'LINE Pay', type: 'mobile', boundTo: taishin.id }, d, now)
  await setStartBalances([{ id: 'cash', amount: 1500 }], '2026-10-01', d, now)
  return { taishin: taishin.id, card: card.id, apple: apple.id, line: line.id }
}

const balances = async () => {
  const all = await readAllData(d)
  return computeBalances(all.paymentMethods, all.transactions, all.adjustments)
}

describe('ways to pay belong to an account (D-125)', () => {
  it('groups every way to pay under the account it draws on', async () => {
    const a = await setup()
    const groups = payGroups(await d.paymentMethods.toArray())
    const taishin = groups.find((g) => g.account?.id === a.taishin)!
    expect(taishin.options.map((o) => [o.name, o.cardId ?? o.sourceAccountId ?? '', !!o.card])).toEqual([
      ['台新@GoGo', '', true],
      ['Apple Pay', a.card, true],
      ['LINE Pay', a.taishin, false],
      ['轉帳', a.taishin, false],
    ])
    // Cash is its own way to pay; the default card (no bank yet) and the unbound 行動支付 wait in the last group.
    expect(groups.find((g) => g.account?.id === 'cash')!.options.map((o) => o.paymentMethodId)).toEqual(['cash'])
    const loose = groups.find((g) => !g.account)!
    expect(loose.options.map((o) => o.paymentMethodId).sort()).toEqual(['card', 'mobile'])
  })

  it('a second bank offers 轉帳 too, and defaultPay follows the account last used with it', async () => {
    const a = await setup()
    const cathay = await addPaymentMethod({ name: '國泰世華', type: 'bank' }, d, now)
    const groups = payGroups(await d.paymentMethods.toArray())
    expect(defaultPay(groups, 'transfer', cathay.id)!.sourceAccountId).toBe(cathay.id)
    expect(defaultPay(groups, 'transfer', a.taishin)!.sourceAccountId).toBe(a.taishin)
    // A 行動支付 follows its current binding.
    expect(defaultPay(groups, a.apple)!.cardId).toBe(a.card)
    // Something no longer offered falls back to the first option.
    expect(defaultPay(groups, 'gone')).toBe(groups[0].options[0])
  })

  it('card spending — directly or through a bound 行動支付 — waits as 預扣; the others leave the account at once', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 800, paymentMethodId: a.card }), d, now)
    await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card }), d, now)
    await addTransaction(spend({ amount: 200, paymentMethodId: a.line, sourceAccountId: a.taishin }), d, now)
    await addTransaction(spend({ amount: 50, paymentMethodId: 'transfer', sourceAccountId: a.taishin }), d, now)
    const b = await balances()
    expect(b.get(a.card)).toBe(1100)
    expect(b.get(a.taishin)).toBe(20000 - 250)
    // Paying the bill: the bank goes down, 預扣 clears, no new expense.
    await addTransaction({ ...spend({}), type: 'transfer', categoryId: '', paymentMethodId: a.taishin, toAccountId: a.card, amount: 1100 }, d, now)
    const after = await balances()
    expect(after.get(a.card)).toBe(0)
    expect(after.get(a.taishin)).toBe(20000 - 250 - 1100)
  })

  it('a recorded charge keeps its card when the binding later changes', async () => {
    const a = await setup()
    const t = await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card }), d, now)
    await updatePaymentMethod(a.apple, { boundTo: a.taishin }, d, now)
    expect((await d.transactions.get(t.id))!.cardId).toBe(a.card)
    expect((await balances()).get(a.card)).toBe(300)
    // Editing the record with what the entry sheet loaded keeps it too.
    await updateTransaction(t.id, spend({ amount: 320, paymentMethodId: a.apple, cardId: a.card }), d, now)
    expect((await balances()).get(a.card)).toBe(320)
  })

  it('rejects a card link that does not fit', async () => {
    const a = await setup()
    await expect(addTransaction(spend({ paymentMethodId: a.card, cardId: a.card }), d, now)).rejects.toThrow('付款方式不正確')
    await expect(addTransaction(spend({ paymentMethodId: a.apple, cardId: a.taishin }), d, now)).rejects.toThrow('信用卡不存在')
    await expect(addTransaction(spend({ paymentMethodId: a.apple, cardId: a.card, sourceAccountId: a.taishin }), d, now)).rejects.toThrow('付款方式不正確')
    await expect(addTransaction({ ...spend({ paymentMethodId: a.apple, cardId: a.card }), type: 'income', categoryId: 'salary' }, d, now)).rejects.toThrow('付款方式不正確')
    await expect(addPaymentMethod({ name: 'x', type: 'mobile', boundTo: 'transfer' }, d, now)).rejects.toThrow('綁定')
    await expect(updatePaymentMethod(a.apple, { boundTo: a.apple }, d, now)).rejects.toThrow('綁定')
    // A binding only means something for 行動支付 / 其他.
    await updatePaymentMethod(a.apple, { type: 'transfer' }, d, now)
    expect((await d.paymentMethods.get(a.apple))!.boundTo).toBeUndefined()
  })

  it('describes how it was paid with the account it draws on', async () => {
    const a = await setup()
    const all = await d.paymentMethods.toArray()
    const byId = (id: string) => all.find((p) => p.id === id)
    expect(describePay({ paymentMethodId: a.card }, byId)).toMatchObject({ label: '台新 Richart · 台新@GoGo', pending: true })
    expect(describePay({ paymentMethodId: a.apple, cardId: a.card }, byId)).toMatchObject({ label: '台新 Richart · Apple Pay', pending: true })
    expect(describePay({ paymentMethodId: 'transfer', sourceAccountId: a.taishin }, byId)).toMatchObject({ label: '台新 Richart · 轉帳', pending: false })
    expect(describePay({ paymentMethodId: 'cash' }, byId)).toMatchObject({ label: '現金', pending: false })
    expect(payKey({ paymentMethodId: 'transfer', sourceAccountId: a.taishin })).toBe(`transfer|${a.taishin}|`)
  })

  it("a bank's history also lists its cards' charges as 預扣", async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 800, paymentMethodId: a.card, time: '10:00' }), d, now)
    await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card, time: '11:00' }), d, now)
    await addTransaction(spend({ amount: 50, paymentMethodId: 'transfer', sourceAccountId: a.taishin, time: '12:00' }), d, now)
    const all = await readAllData(d)
    const bank = all.paymentMethods.find((p) => p.id === a.taishin)!
    const rows = accountFlow(bank, all.paymentMethods, all.transactions, all.adjustments)
    expect(rows.map((r) => [r.tx!.amount, r.delta, !!r.pending])).toEqual([
      [50, -50, false],
      [300, -300, true],
      [800, -800, true],
    ])
  })

  it('filtering by the bank shows its cards and bound 行動支付; 所有信用卡 includes card charges through 行動支付', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 800, paymentMethodId: a.card }), d, now)
    await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card }), d, now)
    await addTransaction(spend({ amount: 70, paymentMethodId: 'cash' }), d, now)
    const all = await readAllData(d)
    const ctx = {
      month: { y: 2026, m: 9 },
      isCard: (id: string) => all.paymentMethods.find((p) => p.id === id)?.type === 'credit_card',
      homeOf: (id: string) => all.paymentMethods.find((p) => p.id === id)?.payFromId,
      names: { category: (id: string) => id, payment: (id: string) => id },
    }
    const f = (payment: string): TxFilter => ({ q: '', type: 'all', categoryIds: [], payment, dateMode: 'month', from: '', to: '' })
    expect(filterTx(all.transactions, f(a.taishin), ctx).map((t) => t.amount).sort()).toEqual([300, 800])
    expect(filterTx(all.transactions, f('__cards__'), ctx).map((t) => t.amount).sort()).toEqual([300, 800])
  })

  it('the card statement matches a purchase made with a 行動支付 bound to the card', async () => {
    const a = await setup()
    const t = await addTransaction(spend({ amount: 300, merchant: '全家', paymentMethodId: a.apple, cardId: a.card }), d, now)
    const statement: CardStatement = {
      id: 's1', paymentMethodId: a.card, bank: '台新', statementMonth: '2026-10', periodStart: '2026-09-13', periodEnd: '2026-10-12', dueDate: null,
      fileHash: 'h', fileName: 'f.pdf', parseStatus: 'confirmed', adapter: 'generic', batchId: 'b', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    }
    const entry: StatementEntry = { id: 'e1', statementId: 's1', txDate: '2026-10-12', postDate: null, merchant: '全家', amount: 300, currency: 'TWD', foreign: null, reference: null, kind: 'purchase', raw: '', order: 0 }
    const r = reconcile({ statement, entries: [entry], transactions: [t], recons: [] })
    expect(r.autoPairs).toEqual([{ entryId: 'e1', transactionId: t.id }])
  })

  it('backups keep bindings and card links; links pointing nowhere are dropped', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card }), d, now)
    const file = JSON.parse(JSON.stringify(buildBackup(await readAllData(d), now)))
    const parsed = parseBackup(JSON.stringify(file))
    expect(parsed.paymentMethods.find((p) => p.id === a.apple)!.boundTo).toBe(a.card)
    expect(parsed.transactions[0].cardId).toBe(a.card)
    const other = new MoneyDB(`pay-other-${n++}`)
    await other.open()
    await restoreBackup(parsed, other, now)
    const all = await readAllData(other)
    expect(computeBalances(all.paymentMethods, all.transactions, all.adjustments).get(a.card)).toBe(300)
    other.close()

    // A binding to something missing (or to a 轉帳) is dropped; a card link to a non-card is refused.
    const broken = JSON.parse(JSON.stringify(file))
    broken.paymentMethods.find((p: { id: string }) => p.id === a.line).boundTo = 'transfer'
    broken.paymentMethods.find((p: { id: string }) => p.id === a.apple).boundTo = 'nope'
    const p2 = parseBackup(JSON.stringify(broken))
    expect(p2.paymentMethods.find((p) => p.id === a.line)!.boundTo).toBeUndefined()
    expect(p2.paymentMethods.find((p) => p.id === a.apple)!.boundTo).toBeUndefined()
    broken.transactions[0].cardId = a.taishin
    expect(() => parseBackup(JSON.stringify(broken))).toThrow('信用卡不正確')

    // CSV: the 帳戶 column names the card charged.
    const names = { category: (id: string) => id, payment: (id: string) => all.paymentMethods.find((p) => p.id === id)?.name ?? id }
    const row = toCsv(all.transactions, names).split('\r\n')[1].split(',')
    expect(row[5]).toBe('Apple Pay')
    expect(row[8]).toBe('台新@GoGo')
  })

  it('a range restore keeps the bank of a card and the card of a 行動支付 that come back together', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card }), d, now)
    await addTransaction({ ...spend({}), type: 'transfer', categoryId: '', paymentMethodId: a.taishin, toAccountId: 'cash', amount: 100 }, d, now)
    const file = parseBackup(JSON.stringify(buildBackup(await readAllData(d), now)))
    const fresh = new MoneyDB(`pay-fresh-${n++}`)
    await fresh.open()
    await restoreRange(file, '2026-10-12', '2026-10-12', fresh, now)
    const pays = await fresh.paymentMethods.toArray()
    expect(pays.find((p) => p.id === a.card)!.payFromId).toBe(a.taishin)
    expect(pays.find((p) => p.id === a.apple)!.boundTo).toBe(a.card)
    fresh.close()
  })

  it('an older card linked to cash counts as not assigned to a bank', async () => {
    const a = await setup()
    await d.paymentMethods.update(a.card, { payFromId: 'cash' })
    const groups = payGroups(await d.paymentMethods.toArray())
    expect(groups.find((g) => g.account?.id === 'cash')!.options.map((o) => o.paymentMethodId)).toEqual(['cash'])
    expect(groups.find((g) => !g.account)!.options.some((o) => o.paymentMethodId === a.card)).toBe(true)
  })

  it('the charged card is the one a statement lists (chargedTo)', () => {
    expect(chargedTo({ paymentMethodId: 'apple', cardId: 'c1' })).toBe('c1')
    expect(chargedTo({ paymentMethodId: 'c1' })).toBe('c1')
  })

  it('a card belongs to a bank account only', async () => {
    const a = await setup()
    await expect(updatePaymentMethod(a.card, { payFromId: 'cash' }, d, now)).rejects.toThrow('銀行帳戶')
    await updatePaymentMethod(a.card, { payFromId: '' }, d, now)
    expect((await d.paymentMethods.get(a.card))!.payFromId).toBeUndefined()
  })
})
