import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from '../db/db'
import { addPaymentMethod, addTransaction, adjustBalance, setStartBalances, updateTransaction, type TxInput } from '../db/repo'
import { computeBalances } from '../lib/accounts'
import { BackupError, buildBackup, parseBackup, toCsv, type BackupFile } from './format'
import { readAllData, restoreBackup, restoreRange } from './store'

let a: MoneyDB
let b: MoneyDB
let n = 0
const now = new Date(2026, 9, 12, 18, 0)

beforeEach(async () => {
  a = new MoneyDB(`accb-a-${n}`)
  b = new MoneyDB(`accb-b-${n++}`)
  await Promise.all([a.open(), b.open()])
})
afterEach(() => {
  a.close()
  b.close()
})

const tx = (p: Partial<TxInput>): TxInput => ({ type: 'expense', amount: 100, merchant: '', categoryId: 'food', paymentMethodId: 'cash', date: '2026-10-05', time: '12:00', note: '', ...p })
const move = (from: string, to: string, amount: number, p: Partial<TxInput> = {}) => tx({ type: 'transfer', categoryId: '', paymentMethodId: from, toAccountId: to, amount, ...p })

async function seed(d: MoneyDB) {
  const bank = await addPaymentMethod({ name: '台新 Richart', type: 'bank', start: { date: '2026-10-01', amount: 20000 } }, d, now)
  const card = await addPaymentMethod({ name: '台新信用卡', type: 'credit_card', payFromId: bank.id, start: { date: '2026-10-01', amount: 0 } }, d, now)
  await setStartBalances([{ id: 'cash', amount: 1500 }], '2026-10-01', d, now)
  await addTransaction(tx({ amount: 860, paymentMethodId: card.id, date: '2026-10-03' }), d, now)
  await addTransaction(move(bank.id, 'cash', 2000, { date: '2026-10-04', fee: 15 }), d, now)
  await addTransaction(move(bank.id, card.id, 860, { date: '2026-10-08' }), d, now)
  await addTransaction(tx({ amount: 15000, categoryId: 'home', paymentMethodId: 'transfer', sourceAccountId: bank.id, date: '2026-10-09' }), d, now)
  await adjustBalance('cash', 3400, '點現金', d, now)
  return { bank: bank.id, card: card.id }
}

const balancesOf = async (d: MoneyDB) => {
  const data = await readAllData(d)
  return computeBalances(data.paymentMethods, data.transactions, data.adjustments)
}
const fileOf = async (d: MoneyDB) => JSON.parse(JSON.stringify(buildBackup(await readAllData(d), now)))

describe('backups with accounts (D-124, spec §15 / §17.10)', () => {
  it('a full backup restores every account, transfer, fee and adjustment with the same balances', async () => {
    const ids = await seed(a)
    const before = await balancesOf(a)
    expect(before.get(ids.bank)).toBe(20000 - 2000 - 15 - 860 - 15000)
    expect(before.get('cash')).toBe(3400)
    expect(before.get(ids.card)).toBe(0)

    const file = parseBackup(JSON.stringify(await fileOf(a)))
    expect(file.schemaVersion).toBe(6)
    expect(file.adjustments).toHaveLength(1)
    expect(file.paymentMethods.find((p) => p.id === ids.card)!.payFromId).toBe(ids.bank)
    await restoreBackup(file, b, now)
    expect(await balancesOf(b)).toEqual(before)
    expect((await b.transactions.toArray()).filter((t) => t.feeOf)).toHaveLength(1)
  })

  it('a backup from before accounts (schema 4) restores; every account starts as "尚未設定"', async () => {
    await addTransaction(tx({ amount: 52000, type: 'income', categoryId: 'salary', paymentMethodId: 'transfer' }), a, now)
    const raw = await fileOf(a)
    raw.schemaVersion = 4
    delete raw.adjustments
    const file = parseBackup(JSON.stringify(raw))
    expect(file.adjustments).toEqual([])
    await restoreBackup(file, b, now)
    expect(await b.transactions.count()).toBe(1)
    expect((await balancesOf(b)).size).toBe(0)
  })

  it('a backup from a newer app is refused before anything is written', () => {
    expect(() => parseBackup(JSON.stringify({ app: 'money', format: 1, schemaVersion: 7, exportedAt: now.toISOString() }))).toThrow('請先更新 App')
  })

  it('rejects broken account data and drops a dangling card payer', async () => {
    const ids = await seed(a)
    const good = await fileOf(a)
    const bad = (f: (x: Record<string, any>) => void) => {
      const x = JSON.parse(JSON.stringify(good))
      f(x)
      return () => parseBackup(JSON.stringify(x))
    }
    const transfer = (x: Record<string, any>) => x.transactions.find((t: any) => t.type === 'transfer')
    expect(bad((x) => (transfer(x).categoryId = 'food'))).toThrow(BackupError)
    expect(bad((x) => (transfer(x).toAccountId = transfer(x).paymentMethodId))).toThrow('轉入帳戶')
    expect(bad((x) => delete transfer(x).toAccountId)).toThrow('轉入帳戶')
    expect(bad((x) => (x.adjustments[0].delta = 1))).toThrow('餘額調整')
    expect(bad((x) => (x.adjustments[0].accountId = 'nope'))).toThrow('餘額調整')
    expect(bad((x) => (x.paymentMethods.find((p: any) => p.id === 'cash').openingBalance = -5))).toThrow('起始餘額')
    expect(bad((x) => delete x.paymentMethods.find((p: any) => p.id === 'cash').balanceFrom)).toThrow('起始餘額')
    const dangling = JSON.parse(JSON.stringify(good))
    dangling.paymentMethods.find((p: any) => p.id === ids.card).payFromId = 'transfer'
    expect(parseBackup(JSON.stringify(dangling)).paymentMethods.find((p) => p.id === ids.card)!.payFromId).toBeUndefined()
  })

  it('a range restore keeps every transfer whole and brings back the accounts it needs', async () => {
    const ids = await seed(a)
    const file: BackupFile = parseBackup(JSON.stringify(await fileOf(a)))
    // The current device has none of these accounts and no records.
    const preview = await restoreRange(file, '2026-10-04', '2026-10-08', b, now)
    expect(preview.fromBackup).toBe(3) // the transfer, its fee and the card payment
    const back = await b.transactions.toArray()
    expect(back.filter((t) => t.type === 'transfer')).toHaveLength(2)
    const pays = new Set((await b.paymentMethods.toArray()).map((p) => p.id))
    for (const t of back) {
      expect(pays.has(t.paymentMethodId)).toBe(true)
      if (t.toAccountId) expect(pays.has(t.toAccountId)).toBe(true)
    }
    // A card arriving without its paying account loses the link instead of pointing nowhere... unless it came too.
    expect(pays.has(ids.bank)).toBe(true)
  })

  it('a range restore replaces balance corrections dated inside the range only', async () => {
    await seed(a)
    const file = parseBackup(JSON.stringify(await fileOf(a)))
    await restoreBackup(file, b, now)
    await adjustBalance('cash', 100, '另一次', b, new Date(2026, 9, 2, 9))
    expect(await b.adjustments.count()).toBe(2)
    const p = await restoreRange(file, '2026-10-12', '2026-10-12', b, now)
    expect(p).toMatchObject({ adjustmentsFromBackup: 1, adjustmentsReplaced: 1 })
    const left = await b.adjustments.toArray()
    expect(left.map((x) => x.note).sort()).toEqual(['另一次', '點現金'])
  })

  it('CSV marks transfers and names the accounts money moved in (D-124)', async () => {
    const ids = await seed(a)
    const data = await readAllData(a)
    const name = (id: string) => data.paymentMethods.find((p) => p.id === id)?.name ?? ''
    const csv = toCsv(data.transactions, { category: (id) => data.categories.find((c) => c.id === id)?.name ?? '', payment: name })
    const rows = csv.replace(/^﻿/, '').trim().split('\r\n').map((r) => r.split(','))
    const move = rows.find((r) => r[2] === '互轉' && r[9] === '現金')!
    expect(move).toEqual(['2026-10-04', '12:00', '互轉', '2000', '', '台新 Richart', '', '', '台新 Richart', '現金'])
    const rent = rows.find((r) => r[3] === '15000')!
    expect(rent.slice(5)).toEqual(['轉帳', '', '', '台新 Richart', ''])
    expect(rows.find((r) => r[5] === name(ids.card))![8]).toBe('台新信用卡')
  })
})

describe('a transfer and its fee restore together (D-121, D-124)', () => {
  const orphans = async (d: MoneyDB) => {
    const all = await d.transactions.toArray()
    const transfers = new Set(all.filter((t) => t.type === 'transfer').map((t) => t.id))
    return all.filter((t) => t.feeOf && !transfers.has(t.feeOf))
  }
  // Data from before fees were locked to their transfer's date: move the fee elsewhere directly.
  const moveFee = async (d: MoneyDB, ymd: string) => {
    const fee = (await d.transactions.toArray()).find((t) => t.feeOf)!
    await d.transactions.put({ ...fee, occurredAt: new Date(`${ymd}T12:00:00`).toISOString() })
    return fee
  }

  it('a fee can no longer be dated apart from its transfer', async () => {
    const bank = await addPaymentMethod({ name: 'B', type: 'bank', start: { date: '2026-10-01', amount: 1000 } }, a, now)
    await addTransaction(move(bank.id, 'cash', 500, { fee: 15 }), a, now)
    const fee = (await a.transactions.toArray()).find((t) => t.feeOf)!
    const at = new Date(fee.occurredAt)
    const same = { amount: 20, paymentMethodId: bank.id, merchant: '互轉手續費', categoryId: fee.categoryId, date: '2026-10-05', time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` }
    await expect(updateTransaction(fee.id, tx({ ...same, date: '2026-10-11' }), a, now)).rejects.toThrow('跟著那筆互轉')
    // Other changes to the fee itself are still fine.
    expect((await updateTransaction(fee.id, tx(same), a, now)).amount).toBe(20)
  })

  it('restoring only the fee\'s dates brings nothing half-way (transfer dated outside)', async () => {
    const bank = await addPaymentMethod({ name: 'B', type: 'bank', start: { date: '2026-10-01', amount: 1000 } }, a, now)
    await addTransaction(move(bank.id, 'cash', 500, { fee: 15, date: '2026-10-05' }), a, now)
    await moveFee(a, '2026-10-08')
    const file = parseBackup(JSON.stringify(await fileOf(a)))
    await restoreRange(file, '2026-10-07', '2026-10-09', b, now)
    expect(await orphans(b)).toEqual([])
    expect((await b.transactions.toArray()).filter((t) => t.feeOf || t.type === 'transfer')).toEqual([])
    // Restoring the transfer's date brings the fee with it.
    await restoreRange(file, '2026-10-05', '2026-10-05', b, now)
    expect((await b.transactions.toArray()).map((t) => t.type).sort()).toEqual(['expense', 'transfer'])
    expect(await orphans(b)).toEqual([])
  })

  it('a transfer replaced by a range restore takes its fee with it, wherever the fee is dated', async () => {
    const bank = await addPaymentMethod({ name: 'B', type: 'bank', start: { date: '2026-10-01', amount: 1000 } }, a, now)
    const older = parseBackup(JSON.stringify(await fileOf(a)))
    await addTransaction(move(bank.id, 'cash', 500, { fee: 15, date: '2026-10-05' }), a, now)
    await moveFee(a, '2026-10-11')
    await restoreRange(older, '2026-10-01', '2026-10-10', a, now)
    expect(await orphans(a)).toEqual([])
    expect(await a.transactions.count()).toBe(0)
    expect((await balancesOf(a)).get(bank.id)).toBe(1000)
  })

  it('a fee stays when its transfer stays outside the range', async () => {
    const bank = await addPaymentMethod({ name: 'B', type: 'bank', start: { date: '2026-10-01', amount: 1000 } }, a, now)
    const older = parseBackup(JSON.stringify(await fileOf(a)))
    await addTransaction(move(bank.id, 'cash', 500, { fee: 15, date: '2026-10-05' }), a, now)
    await moveFee(a, '2026-10-08')
    await restoreRange(older, '2026-10-07', '2026-10-09', a, now)
    expect((await a.transactions.toArray()).map((t) => t.type).sort()).toEqual(['expense', 'transfer'])
    expect(await orphans(a)).toEqual([])
  })

  it('restoring a transfer back over a changed one leaves exactly its own fee', async () => {
    const bank = await addPaymentMethod({ name: 'B', type: 'bank', start: { date: '2026-10-01', amount: 1000 } }, a, now)
    await addTransaction(move(bank.id, 'cash', 500, { fee: 15, date: '2026-10-05' }), a, now)
    const file = parseBackup(JSON.stringify(await fileOf(a)))
    // Later the fee was rewritten under a new id and the transfer moved out of the range.
    const t = (await a.transactions.toArray()).find((x) => x.type === 'transfer')!
    const fee = (await a.transactions.toArray()).find((x) => x.feeOf)!
    await a.transactions.bulkPut([{ ...t, occurredAt: new Date('2026-10-11T12:00:00').toISOString() }, { ...fee, id: 'other-fee', occurredAt: new Date('2026-10-11T12:00:00').toISOString() }])
    await a.transactions.delete(fee.id)
    await restoreRange(file, '2026-10-05', '2026-10-05', a, now)
    const fees = (await a.transactions.toArray()).filter((x) => x.feeOf)
    expect(fees.map((f) => f.id)).toEqual([fee.id])
    expect((await balancesOf(a)).get(bank.id)).toBe(1000 - 500 - 15)
  })

  it('a fee whose transfer is missing from the file is read as an ordinary expense', async () => {
    const bank = await addPaymentMethod({ name: 'B', type: 'bank', start: { date: '2026-10-01', amount: 1000 } }, a, now)
    await addTransaction(move(bank.id, 'cash', 500, { fee: 15 }), a, now)
    const raw = await fileOf(a)
    raw.transactions = raw.transactions.filter((t: { type: string }) => t.type !== 'transfer')
    const file = parseBackup(JSON.stringify(raw))
    expect(file.transactions).toHaveLength(1)
    expect(file.transactions[0].feeOf).toBeUndefined()
  })
})
