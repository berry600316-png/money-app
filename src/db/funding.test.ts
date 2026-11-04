import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from './db'
import { addPaymentMethod, addTransaction, deleteEntry, MoneyError, setStartBalances, updateTransaction, type TxInput } from './repo'
import { fundingMonthReport } from '../lib/funding'
import { buildBackup, parseBackup } from '../backup/format'
import { readAllData, restoreBackup } from '../backup/store'

let d: MoneyDB
let counter = 0
const now = new Date(2026, 10, 15, 12, 0)
beforeEach(async () => { d = new MoneyDB(`funding-${counter++}`); await d.open() })
afterEach(() => d.close())

const expense = (extra: Partial<TxInput>): TxInput => ({ type: 'expense', amount: 100, merchant: '測試', categoryId: 'food', paymentMethodId: 'cash', date: '2026-11-12', time: '12:00', note: '', ...extra })
const income = (extra: Partial<TxInput>): TxInput => ({ ...expense({}), type: 'income', categoryId: 'salary', ...extra })

describe('funding allocation through transaction repository', () => {
  it('saves a split purchase, keeps its actual date and reassigns monthly results', async () => {
    await addTransaction(income({ amount: 1000, date: '2026-10-12' }), d, now)
    const saved = await addTransaction(expense({ amount: 500, funding: [{ month: '2026-10', amount: 300 }, { month: '2026-11', amount: 200 }] }), d, now)
    const stored = await d.transactions.get(saved.id)
    expect(stored?.funding).toEqual([{ month: '2026-10', amount: 300, earnedAmount: 300 }, { month: '2026-11', amount: 200, earnedAmount: 200 }])
    expect(new Date(stored!.occurredAt).getMonth()).toBe(10)
    const all = await d.transactions.toArray()
    expect(fundingMonthReport(all, { y: 2026, m: 9 }).balance).toBe(700)
    expect(fundingMonthReport(all, { y: 2026, m: 10 }).expense).toBe(200)
  })

  it('rejects cross-month overuse and a later edit that would make it invalid', async () => {
    const earned = await addTransaction(income({ amount: 400, date: '2026-10-12' }), d, now)
    await expect(addTransaction(expense({ amount: 500, funding: [{ month: '2026-10', amount: 500 }] }), d, now)).rejects.toBeInstanceOf(MoneyError)
    await addTransaction(expense({ amount: 300, funding: [{ month: '2026-10', amount: 300 }] }), d, now)
    await expect(updateTransaction(earned.id, income({ amount: 200, date: '2026-10-12' }), d, now)).rejects.toBeInstanceOf(MoneyError)
    expect((await d.transactions.get(earned.id))?.amount).toBe(400)
    await expect(deleteEntry(earned.id, d)).rejects.toBeInstanceOf(MoneyError)
  })

  it('uses opening funds after earnings without adding opening balance to income', async () => {
    await setStartBalances([{ id: 'cash', amount: 400 }], '2026-10-01', d, new Date(2026, 9, 15, 12, 0))
    await addTransaction(income({ amount: 600, date: '2026-10-12' }), d, now)
    await addTransaction(expense({ amount: 800, funding: [{ month: '2026-10', amount: 800 }] }), d, now)
    const report = fundingMonthReport(await d.transactions.toArray(), { y: 2026, m: 9 })
    expect(report).toEqual({ income: 600, expense: 600, balance: 0, openingUsed: 200 })
  })

  it('assigns the entire transfer fee to the earliest funding month', async () => {
    const bank = await addPaymentMethod({ name: '測試銀行', type: 'bank' }, d, now)
    await addTransaction(income({ amount: 1000, date: '2026-10-12' }), d, now)
    const transfer = await addTransaction({ type: 'transfer', amount: 500, merchant: '', categoryId: '', paymentMethodId: 'cash', toAccountId: bank.id, date: '2026-11-12', time: '12:00', note: '', fee: 15, funding: [{ month: '2026-10', amount: 300 }, { month: '2026-11', amount: 200 }] }, d, now)
    const fee = await d.transactions.where('feeOf').equals(transfer.id).first()
    expect(fee?.funding).toEqual([{ month: '2026-10', amount: 15, earnedAmount: 15 }])
  })

  it('does not silently move an old-month card reservation to an unfunded paying bank', async () => {
    const linked = await addPaymentMethod({ name: '扣款銀行', type: 'bank' }, d, now)
    const other = await addPaymentMethod({ name: '另一銀行', type: 'bank' }, d, now)
    const card = await addPaymentMethod({ name: '測試信用卡', type: 'credit_card', cardLast4: '1234', payFromId: linked.id }, d, now)
    await addTransaction(income({ amount: 500, paymentMethodId: linked.id, date: '2026-10-12' }), d, now)
    await addTransaction(expense({ amount: 300, paymentMethodId: card.id, funding: [{ month: '2026-10', amount: 300 }] }), d, now)
    const bill: TxInput = { type: 'transfer', amount: 300, merchant: '', categoryId: '', paymentMethodId: other.id, toAccountId: card.id, date: '2026-11-13', time: '12:00', note: '' }
    await expect(addTransaction(bill, d, now)).rejects.toBeInstanceOf(MoneyError)
    expect((await d.transactions.toArray()).filter((t) => t.type === 'transfer')).toHaveLength(0)
  })

  it('keeps source months and opening provenance through backup and restore', async () => {
    await setStartBalances([{ id: 'cash', amount: 400 }], '2026-10-01', d, new Date(2026, 9, 15, 12, 0))
    await addTransaction(income({ amount: 600, date: '2026-10-12' }), d, now)
    await addTransaction(expense({ amount: 800, funding: [{ month: '2026-10', amount: 800 }] }), d, now)
    const target = new MoneyDB(`funding-restore-${counter++}`)
    await target.open()
    try {
      const file = parseBackup(JSON.stringify(buildBackup(await readAllData(d), now)))
      await restoreBackup(file, target, now)
      expect((await target.paymentMethods.get('cash'))?.openingFundingMonth).toBe('2026-10')
      expect(fundingMonthReport(await target.transactions.toArray(), { y: 2026, m: 9 })).toEqual({ income: 600, expense: 600, balance: 0, openingUsed: 200 })
    } finally { target.close() }
  })

  it('uses newly recorded old-month income before opening money when the ledger is recalculated', async () => {
    await setStartBalances([{ id: 'cash', amount: 400 }], '2026-10-01', d, new Date(2026, 9, 15, 12, 0))
    const used = await addTransaction(expense({ amount: 300, funding: [{ month: '2026-10', amount: 300 }] }), d, now)
    expect((await d.transactions.get(used.id))?.funding?.[0].earnedAmount).toBe(0)
    await addTransaction(income({ amount: 200, date: '2026-10-12' }), d, now)
    expect((await d.transactions.get(used.id))?.funding?.[0].earnedAmount).toBe(200)
    expect(fundingMonthReport(await d.transactions.toArray(), { y: 2026, m: 9 })).toEqual({ income: 200, expense: 200, balance: 0, openingUsed: 100 })
  })
})
