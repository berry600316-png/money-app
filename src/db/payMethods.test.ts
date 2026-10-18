import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from './db'
import { addPaymentMethod, addTransaction, LAST_KEYS, lastWalletCards, setStartBalances, updatePaymentMethod, updateTransaction, type TxInput } from './repo'
import type { CardStatement, StatementEntry } from './types'
import { accountFlow, cashOnHand, cashSpent, chargedTo, computeBalances, defaultPay, describePay, migrateWalletLinks, payGroups, payKey } from '../lib/accounts'
import { filterTx, type TxFilter } from '../lib/stats'
import { reconcile } from '../card/reconcile'
import { buildBackup, parseBackup, toCsv } from '../backup/format'
import { linksByName } from '../card/notificationAdapters'
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

/** 台新 with a credit card and a debit card; Apple Pay holds both, LINE Pay only the credit card; cash. */
async function setup() {
  const start = (amount: number) => ({ date: '2026-10-01', amount })
  const taishin = await addPaymentMethod({ name: '台新 Richart', type: 'bank', start: start(20000) }, d, now)
  const card = await addPaymentMethod({ name: '台新@GoGo', type: 'credit_card', cardLast4: '1234', payFromId: taishin.id, start: start(0) }, d, now)
  const debit = await addPaymentMethod({ name: '台新金融卡', type: 'debit_card', payFromId: taishin.id }, d, now)
  const apple = await addPaymentMethod({ name: 'Apple Pay', type: 'mobile', cards: [card.id, debit.id] }, d, now)
  const line = await addPaymentMethod({ name: 'LINE Pay', type: 'mobile', cards: [card.id] }, d, now)
  await setStartBalances([{ id: 'cash', amount: 1500 }], '2026-10-01', d, now)
  return { taishin: taishin.id, card: card.id, debit: debit.id, apple: apple.id, line: line.id }
}

const balances = async () => {
  const all = await readAllData(d)
  return computeBalances(all.paymentMethods, all.transactions, all.adjustments)
}

describe('cards under accounts; 行動支付 hold cards (D-125, D-132)', () => {
  it('lists each bank with its credit and debit cards and 轉帳, then every card each 行動支付 holds', async () => {
    const a = await setup()
    const groups = payGroups(await d.paymentMethods.toArray())
    const taishin = groups.find((g) => g.account?.id === a.taishin)!
    expect(taishin.options.map((o) => [o.label, o.cardId ?? o.sourceAccountId ?? ''])).toEqual([
      ['台新@GoGo', ''],
      ['台新金融卡', a.taishin],
      ['轉帳', a.taishin],
    ])
    const wallets = groups.find((g) => g.title === '行動支付')!
    expect(wallets.options.map((o) => [o.label, o.cardId])).toEqual([
      ['Apple Pay · 台新@GoGo', a.card],
      ['Apple Pay · 台新金融卡', a.debit],
      ['LINE Pay · 台新@GoGo', a.card],
    ])
    expect(groups.find((g) => g.account?.id === 'cash')!.options.map((o) => o.paymentMethodId)).toEqual(['cash'])
    // The default card (no bank yet) and the default 行動支付 (no card yet) wait in the last group.
    const loose = groups.find((g) => g.title === '還沒指定帳戶')!
    expect(loose.options.map((o) => o.paymentMethodId).sort()).toEqual(['card', 'mobile'])
  })

  it('Q109 B: a 行動支付 starts with the card it used last time; 轉帳 with the account last used', async () => {
    const a = await setup()
    const cathay = await addPaymentMethod({ name: '國泰世華', type: 'bank' }, d, now)
    const groups = payGroups(await d.paymentMethods.toArray())
    expect(defaultPay(groups, 'transfer', cathay.id)!.sourceAccountId).toBe(cathay.id)
    expect(defaultPay(groups, a.apple)!.cardId).toBe(a.card)
    expect(defaultPay(groups, a.apple, undefined, a.debit)!.cardId).toBe(a.debit)
    // A remembered card no longer held falls back to its first card.
    expect(defaultPay(groups, a.line, undefined, a.debit)!.cardId).toBe(a.card)
    expect(defaultPay(groups, 'gone')).toBe(groups[0].options[0])
    // Saving an expense remembers the card per 行動支付.
    await addTransaction(spend({ paymentMethodId: a.apple, cardId: a.debit }), d, now)
    await addTransaction(spend({ paymentMethodId: a.line, cardId: a.card }), d, now)
    expect(await lastWalletCards(d)).toEqual({ [a.apple]: a.debit, [a.line]: a.card })
    expect((await d.settings.get(LAST_KEYS.walletCards))!.value).toEqual({ [a.apple]: a.debit, [a.line]: a.card })
  })

  it('money moves by the card used: credit waits as 預扣, debit leaves the bank at once — directly or through Apple Pay', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 800, paymentMethodId: a.card }), d, now)
    await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card }), d, now)
    await addTransaction(spend({ amount: 200, paymentMethodId: a.apple, cardId: a.debit }), d, now)
    await addTransaction(spend({ amount: 70, paymentMethodId: a.debit, sourceAccountId: a.taishin }), d, now)
    await addTransaction(spend({ amount: 50, paymentMethodId: 'transfer', sourceAccountId: a.taishin }), d, now)
    const b = await balances()
    expect(b.get(a.card)).toBe(1100)
    expect(b.get(a.taishin)).toBe(20000 - 200 - 70 - 50)
    // Paying the bill: the bank goes down, 預扣 clears, no new expense.
    await addTransaction({ ...spend({}), type: 'transfer', categoryId: '', paymentMethodId: a.taishin, toAccountId: a.card, amount: 1100 }, d, now)
    const after = await balances()
    expect([after.get(a.card), after.get(a.taishin)]).toEqual([0, 20000 - 320 - 1100])
  })

  it('a recorded payment keeps its card when the cards a 行動支付 holds change later', async () => {
    const a = await setup()
    const t = await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card }), d, now)
    await updatePaymentMethod(a.apple, { cards: [a.debit] }, d, now)
    expect((await d.transactions.get(t.id))!.cardId).toBe(a.card)
    expect((await balances()).get(a.card)).toBe(300)
    await updateTransaction(t.id, spend({ amount: 320, paymentMethodId: a.apple, cardId: a.card }), d, now)
    expect((await balances()).get(a.card)).toBe(320)
  })

  it('Q110 B: a 行動支付 holds cards only; a card link that does not fit is refused', async () => {
    const a = await setup()
    await expect(addTransaction(spend({ paymentMethodId: a.card, cardId: a.card }), d, now)).rejects.toThrow('付款方式不正確')
    await expect(addTransaction(spend({ paymentMethodId: a.apple, cardId: a.taishin }), d, now)).rejects.toThrow('卡片不存在')
    await expect(addTransaction(spend({ paymentMethodId: a.apple, cardId: a.card, sourceAccountId: a.taishin }), d, now)).rejects.toThrow('付款方式不正確')
    await expect(addTransaction({ ...spend({ paymentMethodId: a.apple, cardId: a.card }), type: 'income', categoryId: 'salary' }, d, now)).rejects.toThrow('付款方式不正確')
    await expect(addPaymentMethod({ name: 'x', type: 'mobile', cards: [a.taishin] }, d, now)).rejects.toThrow('只能綁信用卡或金融卡')
    await expect(updatePaymentMethod(a.apple, { cards: ['transfer'] }, d, now)).rejects.toThrow('只能綁信用卡或金融卡')
    // Cards only mean something for 行動支付 / 其他.
    await updatePaymentMethod(a.apple, { type: 'transfer' }, d, now)
    expect((await d.paymentMethods.get(a.apple))!.cards).toBeUndefined()
  })

  it('D-135: linksByName links a kind of notice to the one 行動支付 / 其他 named like it, never guessing between two', () => {
    const m = (id: string, name: string, type: 'mobile' | 'other' | 'credit_card' = 'mobile') => ({ id, name, type })
    expect(linksByName([m('a', 'LINE Pay'), m('b', 'Apple Pay')], {})).toEqual({ linepay: 'a' })
    expect(linksByName([m('a', ' linepay ', 'other')], {})).toEqual({ linepay: 'a' })
    expect(linksByName([m('a', 'LINE Pay'), m('b', 'line pay', 'other')], {})).toEqual({})
    expect(linksByName([m('a', 'LINE Pay')], { linepay: 'z' })).toEqual({})
    expect(linksByName([m('c', 'LINE Pay', 'credit_card')], {})).toEqual({})
  })

  it('describes how it was paid', async () => {
    const a = await setup()
    const all = await d.paymentMethods.toArray()
    const byId = (id: string) => all.find((p) => p.id === id)
    expect(describePay({ paymentMethodId: a.card }, byId)).toMatchObject({ label: '台新 Richart · 台新@GoGo', pending: true })
    expect(describePay({ paymentMethodId: a.apple, cardId: a.card }, byId)).toMatchObject({ label: 'Apple Pay · 台新@GoGo', account: '台新@GoGo', pending: true })
    expect(describePay({ paymentMethodId: a.apple, cardId: a.debit }, byId)).toMatchObject({ label: 'Apple Pay · 台新金融卡', pending: false })
    expect(describePay({ paymentMethodId: a.debit, sourceAccountId: a.taishin }, byId)).toMatchObject({ label: '台新 Richart · 台新金融卡', pending: false })
    expect(describePay({ paymentMethodId: 'transfer', sourceAccountId: a.taishin }, byId)).toMatchObject({ label: '台新 Richart · 轉帳', pending: false })
    expect(describePay({ paymentMethodId: 'cash' }, byId)).toMatchObject({ label: '現金', pending: false })
    expect(payKey({ paymentMethodId: 'transfer', sourceAccountId: a.taishin })).toBe(`transfer|${a.taishin}|`)
  })

  it("a bank's history lists its credit cards' charges as 預扣 and debit payments as money out", async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 800, paymentMethodId: a.card, time: '10:00' }), d, now)
    await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card, time: '11:00' }), d, now)
    await addTransaction(spend({ amount: 120, paymentMethodId: a.apple, cardId: a.debit, time: '11:30' }), d, now)
    await addTransaction(spend({ amount: 50, paymentMethodId: 'transfer', sourceAccountId: a.taishin, time: '12:00' }), d, now)
    const all = await readAllData(d)
    const bank = all.paymentMethods.find((p) => p.id === a.taishin)!
    const rows = accountFlow(bank, all.paymentMethods, all.transactions, all.adjustments)
    expect(rows.map((r) => [r.tx!.amount, r.delta, !!r.pending])).toEqual([
      [50, -50, false],
      [120, -120, false],
      [300, -300, true],
      [800, -800, true],
    ])
  })

  it('filtering: the bank shows its cards and what was paid with them; 所有信用卡 includes credit cards through 行動支付', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 800, paymentMethodId: a.card }), d, now)
    await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card }), d, now)
    await addTransaction(spend({ amount: 120, paymentMethodId: a.apple, cardId: a.debit }), d, now)
    await addTransaction(spend({ amount: 70, paymentMethodId: 'cash' }), d, now)
    const all = await readAllData(d)
    const ctx = {
      month: { y: 2026, m: 9 },
      isCard: (id: string) => all.paymentMethods.find((p) => p.id === id)?.type === 'credit_card',
      homeOf: (id: string) => all.paymentMethods.find((p) => p.id === id)?.payFromId,
      names: { category: (id: string) => id, payment: (id: string) => id },
    }
    const f = (payment: string): TxFilter => ({ q: '', type: 'all', categoryIds: [], payment, dateMode: 'month', from: '', to: '' })
    expect(filterTx(all.transactions, f(a.taishin), ctx).map((t) => t.amount).sort((x, y) => x - y)).toEqual([120, 300, 800])
    expect(filterTx(all.transactions, f('__cards__'), ctx).map((t) => t.amount).sort((x, y) => x - y)).toEqual([300, 800])
    expect(filterTx(all.transactions, f(a.debit), ctx).map((t) => t.amount)).toEqual([120])
    expect(filterTx(all.transactions, f(a.apple), ctx).map((t) => t.amount).sort((x, y) => x - y)).toEqual([120, 300])
  })

  it('the card statement matches a purchase made with Apple Pay on that card', async () => {
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

  it('backups keep the cards a 行動支付 holds and the card used; links pointing nowhere are dropped', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card }), d, now)
    await addTransaction(spend({ amount: 120, paymentMethodId: a.apple, cardId: a.debit }), d, now)
    const file = JSON.parse(JSON.stringify(buildBackup(await readAllData(d), now)))
    expect(file.schemaVersion).toBe(9)
    const parsed = parseBackup(JSON.stringify(file))
    expect(parsed.paymentMethods.find((p) => p.id === a.apple)!.cards).toEqual([a.card, a.debit])
    // A file of this version is not linked by name (the user's link, or none, is kept as it is).
    expect(parsed.settings.find((s) => s.key === 'noticeMethods')).toBeUndefined()
    const other = new MoneyDB(`pay-other-${n++}`)
    await other.open()
    await restoreBackup(parsed, other, now)
    const all = await readAllData(other)
    const b = computeBalances(all.paymentMethods, all.transactions, all.adjustments)
    expect([b.get(a.card), b.get(a.taishin)]).toEqual([300, 20000 - 120])
    other.close()

    // A held card that is missing or not a card is dropped; a record's card that is not a card is refused.
    const broken = JSON.parse(JSON.stringify(file))
    broken.paymentMethods.find((p: { id: string }) => p.id === a.apple).cards = [a.card, 'nope', a.taishin, a.card]
    broken.paymentMethods.find((p: { id: string }) => p.id === a.line).notifyCardId = a.debit
    broken.settings.push({ key: 'noticeMethods', value: { linepay: a.card, gone: 'nope', ok: a.line } })
    const p2 = parseBackup(JSON.stringify(broken))
    expect(p2.paymentMethods.find((p) => p.id === a.apple)!.cards).toEqual([a.card])
    expect('notifyCardId' in p2.paymentMethods.find((p) => p.id === a.line)!).toBe(false)
    expect(p2.settings.find((s) => s.key === 'noticeMethods')!.value).toEqual({ ok: a.line })
    broken.transactions[0].cardId = a.taishin
    expect(() => parseBackup(JSON.stringify(broken))).toThrow('信用卡不正確')

    // CSV: the 帳戶 column names the card used.
    const names = { category: (id: string) => id, payment: (id: string) => all.paymentMethods.find((p) => p.id === id)?.name ?? id }
    const rows = toCsv(all.transactions, names).split('\r\n').slice(1, 3).map((r) => r.split(','))
    expect(rows.map((r) => [r[5], r[8]]).sort()).toEqual([
      ['Apple Pay', '台新@GoGo'],
      ['Apple Pay', '台新金融卡'],
    ])
  })

  it('Q107 A: an older backup (one card or one account per 行動支付) comes in with the new rules', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card }), d, now)
    const file = JSON.parse(JSON.stringify(buildBackup(await readAllData(d), now)))
    file.schemaVersion = 6
    const apple = file.paymentMethods.find((p: { id: string }) => p.id === a.apple)
    delete apple.cards
    apple.boundTo = a.card
    const line = file.paymentMethods.find((p: { id: string }) => p.id === a.line)
    delete line.cards
    delete line.notifyCardId
    line.boundTo = a.taishin
    file.transactions.push({ ...file.transactions[0], id: 'old-line', amount: 60, paymentMethodId: a.line, sourceAccountId: a.taishin, cardId: undefined })
    const parsed = parseBackup(JSON.stringify(file))
    expect(parsed.paymentMethods.find((p) => p.id === a.apple)).toMatchObject({ cards: [a.card] })
    // Bound to 台新, which has one debit card: it now holds that card.
    expect(parsed.paymentMethods.find((p) => p.id === a.line)).toMatchObject({ cards: [a.debit] })
    expect(parsed.paymentMethods.some((p) => 'boundTo' in p || 'notifyCardId' in p)).toBe(false)
    // D-135: the one named LINE Pay takes LINE Pay notices.
    expect(parsed.settings.find((s) => s.key === 'noticeMethods')!.value).toEqual({ linepay: a.line })
    const old = parsed.transactions.find((t) => t.id === 'old-line')!
    expect([old.cardId, old.sourceAccountId]).toEqual([a.debit, undefined])
  })

  it('migrateWalletLinks: an account without exactly one debit card leaves the wallet empty and the record unchanged', () => {
    const methods = [
      { id: 'b', name: 'B', type: 'bank' as const, isActive: true, sortOrder: 0 },
      { id: 'd1', name: 'D1', type: 'debit_card' as const, isActive: true, sortOrder: 1, payFromId: 'b' },
      { id: 'd2', name: 'D2', type: 'debit_card' as const, isActive: true, sortOrder: 2, payFromId: 'b' },
      { id: 'w', name: 'W', type: 'mobile' as const, isActive: true, sortOrder: 3, boundTo: 'b' },
    ]
    const tx = { id: 't', type: 'expense' as const, amount: 5, merchant: '', categoryId: 'food', paymentMethodId: 'w', sourceAccountId: 'b', occurredAt: now.toISOString(), note: '', source: 'manual', externalId: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }
    const r = migrateWalletLinks(methods, [tx])
    expect(r.methods).toEqual([{ id: 'w', name: 'W', type: 'mobile', isActive: true, sortOrder: 3 }])
    expect(r.transactions).toEqual([])
  })

  /** The database as an older app version left it (no upgrade code: the data is written as it was then). */
  const legacyDb = (name: string, upTo: 6 | 7) => {
    const old = new Dexie(name)
    old.version(1).stores({ transactions: 'id, occurredAt, type, categoryId, paymentMethodId, [source+externalId]', categories: 'id, type', paymentMethods: 'id', settings: 'key' })
    old.version(2).stores({ salaryItems: 'id, kind', payslips: 'id, &month, payDate' })
    old.version(3).stores({ importedNotifications: 'id, &captureId, batchId, transactionId', importBatches: 'id, createdAt', cardStatements: 'id, paymentMethodId, &fileHash, statementMonth', statementEntries: 'id, statementId', reconciliations: 'id, statementId, entryId, transactionId' })
    old.version(4).stores({ monthlyPlans: 'month', planTemplates: 'id', plannedExpenses: 'id, month, &[month+templateId], transactionId' })
    old.version(5).stores({ transactions: 'id, occurredAt, type, categoryId, paymentMethodId, toAccountId, sourceAccountId, feeOf, [source+externalId]', adjustments: 'id, accountId, occurredAt' })
    old.version(6).stores({})
    if (upTo === 7) old.version(7).stores({})
    return old
  }

  it('database v6 → v8 converts the bindings and the records through them', async () => {
    const name = `pay-up-${n++}`
    const old = legacyDb(name, 6)
    await old.open()
    await old.table('paymentMethods').bulkAdd([
      { id: 'bank', name: '台新', type: 'bank', isActive: true, sortOrder: 0 },
      { id: 'cc', name: '卡', type: 'credit_card', isActive: true, sortOrder: 1, payFromId: 'bank' },
      { id: 'dc', name: '金融卡', type: 'debit_card', isActive: true, sortOrder: 2, payFromId: 'bank' },
      { id: 'ap', name: 'Apple Pay', type: 'mobile', isActive: true, sortOrder: 3, boundTo: 'cc' },
      { id: 'lp', name: 'LINE Pay', type: 'mobile', isActive: true, sortOrder: 4, boundTo: 'bank' },
    ])
    const base = { type: 'expense', merchant: '', categoryId: 'food', occurredAt: now.toISOString(), note: '', source: 'manual', externalId: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }
    await old.table('transactions').bulkAdd([
      { ...base, id: 't1', amount: 10, paymentMethodId: 'ap', cardId: 'cc' },
      { ...base, id: 't2', amount: 20, paymentMethodId: 'lp', sourceAccountId: 'bank' },
    ])
    old.close()
    const up = new MoneyDB(name)
    await up.open()
    expect(await up.paymentMethods.get('ap')).toMatchObject({ cards: ['cc'] })
    expect(await up.paymentMethods.get('lp')).toMatchObject({ cards: ['dc'] })
    expect('boundTo' in (await up.paymentMethods.get('ap'))!).toBe(false)
    expect('notifyCardId' in (await up.paymentMethods.get('ap'))!).toBe(false)
    expect(await up.transactions.get('t1')).toMatchObject({ cardId: 'cc' })
    const t2 = (await up.transactions.get('t2'))!
    expect([t2.cardId, t2.sourceAccountId]).toEqual(['dc', undefined])
    expect((await up.settings.get('noticeMethods'))!.value).toEqual({ linepay: 'lp' })
    expect((await up.settings.get('schemaVersion'))!.value).toBe(9)
    up.close()
  })

  it('database v7 → v8 drops the card chosen for notices, keeps the cards and an existing link', async () => {
    const name = `pay-up8-${n++}`
    const old = legacyDb(name, 7)
    await old.open()
    await old.table('paymentMethods').bulkAdd([
      { id: 'bank', name: '台新', type: 'bank', isActive: true, sortOrder: 0 },
      { id: 'cc', name: '卡', type: 'credit_card', isActive: true, sortOrder: 1, payFromId: 'bank' },
      { id: 'dc', name: '金融卡', type: 'debit_card', isActive: true, sortOrder: 2, payFromId: 'bank' },
      { id: 'ap', name: 'Apple Pay', type: 'mobile', isActive: true, sortOrder: 3, cards: ['cc', 'dc'], notifyCardId: 'dc' },
      { id: 'lp', name: 'LINE Pay', type: 'mobile', isActive: true, sortOrder: 4, cards: ['cc'], notifyCardId: 'cc' },
    ])
    await old.table('settings').put({ key: 'schemaVersion', value: 7 })
    old.close()
    const up = new MoneyDB(name)
    await up.open()
    const ap = (await up.paymentMethods.get('ap'))!
    expect(ap.cards).toEqual(['cc', 'dc'])
    expect('notifyCardId' in ap || 'notifyCardId' in (await up.paymentMethods.get('lp'))!).toBe(false)
    expect((await up.settings.get('noticeMethods'))!.value).toEqual({ linepay: 'lp' })
    expect((await up.settings.get('schemaVersion'))!.value).toBe(9)
    up.close()

    // A link the user already has is never replaced.
    const name2 = `pay-up8-${n++}`
    const old2 = legacyDb(name2, 7)
    await old2.open()
    await old2.table('paymentMethods').bulkAdd([
      { id: 'lp', name: 'LINE Pay', type: 'mobile', isActive: true, sortOrder: 0 },
      { id: 'mine', name: '我的錢包', type: 'other', isActive: true, sortOrder: 1 },
    ])
    await old2.table('settings').put({ key: 'noticeMethods', value: { linepay: 'mine' } })
    old2.close()
    const up2 = new MoneyDB(name2)
    await up2.open()
    expect((await up2.settings.get('noticeMethods'))!.value).toEqual({ linepay: 'mine' })
    up2.close()
  })

  it('a range restore keeps the bank of a card and the cards of a 行動支付 that come back together', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 300, paymentMethodId: a.apple, cardId: a.card }), d, now)
    await addTransaction({ ...spend({}), type: 'transfer', categoryId: '', paymentMethodId: a.taishin, toAccountId: 'cash', amount: 100 }, d, now)
    const file = parseBackup(JSON.stringify(buildBackup(await readAllData(d), now)))
    const fresh = new MoneyDB(`pay-fresh-${n++}`)
    await fresh.open()
    await restoreRange(file, '2026-10-12', '2026-10-12', fresh, now)
    const pays = await fresh.paymentMethods.toArray()
    expect(pays.find((p) => p.id === a.card)!.payFromId).toBe(a.taishin)
    // The debit card did not come back, so Apple Pay holds only the card that did.
    expect(pays.find((p) => p.id === a.apple)!.cards).toEqual([a.card])
    fresh.close()
  })

  it('an older card linked to cash counts as not assigned to a bank', async () => {
    const a = await setup()
    await d.paymentMethods.update(a.card, { payFromId: 'cash' })
    const groups = payGroups(await d.paymentMethods.toArray())
    expect(groups.find((g) => g.account?.id === 'cash')!.options.map((o) => o.paymentMethodId)).toEqual(['cash'])
    expect(groups.find((g) => g.title === '還沒指定帳戶')!.options.some((o) => o.paymentMethodId === a.card)).toBe(true)
  })

  it('D-138: cash spending counts only what left a 現金 account', async () => {
    const a = await setup()
    await addTransaction(spend({ amount: 120, paymentMethodId: 'cash' }), d, now)
    await addTransaction(spend({ amount: 80, paymentMethodId: 'cash', time: '13:00' }), d, now)
    await addTransaction(spend({ amount: 300, paymentMethodId: a.card }), d, now)
    await addTransaction(spend({ amount: 50, paymentMethodId: 'easycard' }), d, now)
    await addTransaction(spend({ amount: 200, paymentMethodId: a.apple, cardId: a.debit }), d, now)
    await addTransaction({ ...spend({ amount: 1000, paymentMethodId: 'cash' }), type: 'income', categoryId: 'salary' }, d, now)
    await addTransaction({ ...spend({}), type: 'transfer', categoryId: '', paymentMethodId: 'cash', toAccountId: a.taishin, amount: 500 }, d, now)
    const all = await readAllData(d)
    expect(cashSpent(all.transactions, all.paymentMethods)).toBe(200)
  })

  it('D-139: cash on hand adds up the 現金 accounts in use that count a balance', async () => {
    await setup()
    const extra = await addPaymentMethod({ name: '零錢包', type: 'cash', start: { date: '2026-10-01', amount: 300 } }, d, now)
    const unset = await addPaymentMethod({ name: '撲滿', type: 'cash' }, d, now)
    await addTransaction(spend({ amount: 120, paymentMethodId: 'cash' }), d, now)
    let all = await readAllData(d)
    let b = computeBalances(all.paymentMethods, all.transactions, all.adjustments)
    const on = cashOnHand(all.paymentMethods, b)
    expect([...on.ids].sort()).toEqual(['cash', extra.id].sort())
    expect(on.total).toBe(1500 - 120 + 300)
    expect(cashOnHand(all.paymentMethods, b).ids).not.toContain(unset.id)
    // A disabled one no longer counts; none counting = nothing to show.
    await updatePaymentMethod(extra.id, { isActive: false }, d, now)
    all = await readAllData(d)
    b = computeBalances(all.paymentMethods, all.transactions, all.adjustments)
    expect(cashOnHand(all.paymentMethods, b).ids).not.toContain(extra.id)
    expect(cashOnHand(all.paymentMethods, undefined)).toEqual({ ids: [], total: 0 })
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
