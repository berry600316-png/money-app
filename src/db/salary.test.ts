import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB, SCHEMA_VERSION } from './db'
import { DEFAULT_SALARY_ITEMS } from './defaults'
import { deleteTransaction, MoneyError, updateTransaction } from './repo'
import { addSalaryItem, deletePayslip, restorePayslip, savePayslip, updateSalaryItem, type PayslipInput } from './salary'

let d: MoneyDB
let n = 0
const now = new Date(2026, 9, 10, 9, 0)

beforeEach(async () => {
  d = new MoneyDB(`salary-${n++}`)
  await d.open()
})
afterEach(() => d.close())

const oct: PayslipInput = {
  month: '2026-09',
  payDate: '2026-10-05',
  company: '星和科技',
  paymentMethodId: 'transfer',
  lines: [
    { itemId: 'BASE_SALARY', amount: 45000 },
    { itemId: 'BONUS_PERFORMANCE', amount: 1500 },
    { itemId: 'LABOR_INSURANCE', amount: 1145 },
    { itemId: 'HEALTH_INSURANCE', amount: 710 },
  ],
}

describe('schema v2', () => {
  it('a fresh database has the default salary items', async () => {
    expect((await d.salaryItems.toArray()).map((i) => i.id).sort()).toEqual(DEFAULT_SALARY_ITEMS.map((i) => i.id).sort())
  })

  it('upgrading a v1 database keeps all data and adds the salary items', async () => {
    const name = `salary-upgrade-${n++}`
    const v1 = new Dexie(name)
    v1.version(1).stores({ transactions: 'id, occurredAt, type, categoryId, paymentMethodId, [source+externalId]', categories: 'id, type', paymentMethods: 'id', settings: 'key' })
    await v1.open()
    await v1.table('transactions').add({ id: 't1', type: 'expense', amount: 100, occurredAt: now.toISOString() })
    await v1.table('settings').add({ key: 'schemaVersion', value: 1 })
    v1.close()

    const up = new MoneyDB(name)
    await up.open()
    expect(await up.transactions.get('t1')).toMatchObject({ amount: 100 })
    expect(await up.salaryItems.count()).toBe(DEFAULT_SALARY_ITEMS.length)
    expect((await up.settings.get('schemaVersion'))?.value).toBe(SCHEMA_VERSION)
    expect(await up.cardStatements.count()).toBe(0) // v3 tables exist after the upgrade
    up.close()
  })
})

describe('savePayslip (D-61..D-66)', () => {
  it('creates the payslip and a linked salary income for the net pay', async () => {
    const s = await savePayslip(null, oct, d, now)
    expect(s.lines.map((l) => l.name)).toEqual(['本薪', '績效獎金', '勞保費', '健保費'])
    const tx = await d.transactions.get(s.transactionId!)
    expect(tx).toMatchObject({ type: 'income', amount: 45000 + 1500 - 1145 - 710, categoryId: 'salary', merchant: '星和科技', paymentMethodId: 'transfer', source: 'payslip', externalId: s.id })
    expect(new Date(tx!.occurredAt).getDate()).toBe(5)
  })

  it('uses "X月薪資" when no company is given', async () => {
    const s = await savePayslip(null, { ...oct, company: '  ' }, d, now)
    expect((await d.transactions.get(s.transactionId!))?.merchant).toBe('9月薪資')
  })

  it('updates the same income on edit and keeps it in step', async () => {
    const s = await savePayslip(null, oct, d, now)
    const s2 = await savePayslip(s.id, { ...oct, lines: [...oct.lines.slice(0, 1), { itemId: 'BONUS_PERFORMANCE', amount: 3200 }, ...oct.lines.slice(2)] }, d, now)
    expect(s2.transactionId).toBe(s.transactionId)
    expect(await d.transactions.count()).toBe(1)
    expect((await d.transactions.get(s.transactionId!))?.amount).toBe(45000 + 3200 - 1145 - 710)
  })

  it('net pay ≤ 0 removes the income and saves the payslip anyway (D-64)', async () => {
    const s = await savePayslip(null, oct, d, now)
    const s2 = await savePayslip(s.id, { ...oct, lines: [{ itemId: 'BASE_SALARY', amount: 0 }, { itemId: 'LEAVE_DEDUCTION', amount: 500 }] }, d, now)
    expect(s2.transactionId).toBeNull()
    expect(await d.transactions.count()).toBe(0)
    expect(await d.payslips.count()).toBe(1)
  })

  it('only one payslip per month', async () => {
    await savePayslip(null, oct, d, now)
    await expect(savePayslip(null, { ...oct, payDate: '2026-10-06' }, d, now)).rejects.toThrow('2026年9月已有薪資單')
  })

  it('rejects bad input without writing', async () => {
    await expect(savePayslip(null, { ...oct, month: '2026-13' }, d, now)).rejects.toBeInstanceOf(MoneyError)
    await expect(savePayslip(null, { ...oct, month: '2026-11' }, d, now)).rejects.toThrow('未來的月份')
    await expect(savePayslip(null, { ...oct, payDate: '2026-02-31' }, d, now)).rejects.toThrow('發薪日不正確')
    await expect(savePayslip(null, { ...oct, payDate: '2026-10-11' }, d, now)).rejects.toThrow('未來')
    await expect(savePayslip(null, { ...oct, lines: [{ itemId: 'BASE_SALARY', amount: -1 }] }, d, now)).rejects.toThrow('整數')
    await expect(savePayslip(null, { ...oct, lines: [{ itemId: 'BASE_SALARY', amount: 1.5 }] }, d, now)).rejects.toThrow('整數')
    await expect(savePayslip(null, { ...oct, lines: [{ itemId: 'NOPE', amount: 1 }] }, d, now)).rejects.toThrow('不存在')
    await expect(savePayslip(null, { ...oct, paymentMethodId: 'nope' }, d, now)).rejects.toThrow('入帳方式')
    await expect(
      savePayslip(null, { ...oct, lines: [{ itemId: 'BASE_SALARY', amount: 99_999_999 }, { itemId: 'BONUS_OTHER', amount: 2 }] }, d, now),
    ).rejects.toThrow('實領金額超過')
    expect(await d.payslips.count()).toBe(0)
    expect(await d.transactions.count()).toBe(0)
  })

  it('keeps the saved name of existing lines after a rename (D-69)', async () => {
    const s = await savePayslip(null, oct, d, now)
    await updateSalaryItem('BONUS_PERFORMANCE', { name: '績效考核獎金' }, d)
    const s2 = await savePayslip(s.id, oct, d, now)
    expect(s2.lines.find((l) => l.itemId === 'BONUS_PERFORMANCE')?.name).toBe('績效獎金')
    const nov = await savePayslip(null, { ...oct, month: '2026-10', payDate: '2026-10-10' }, d, now)
    expect(nov.lines.find((l) => l.itemId === 'BONUS_PERFORMANCE')?.name).toBe('績效考核獎金')
  })

  it('the linked income can only be changed through the payslip', async () => {
    const s = await savePayslip(null, oct, d, now)
    const input = { type: 'income' as const, amount: 1, merchant: '', categoryId: 'salary', paymentMethodId: 'cash', date: '2026-10-05', note: '' }
    await expect(updateTransaction(s.transactionId!, input, d, now)).rejects.toThrow('薪資單')
    await expect(deleteTransaction(s.transactionId!, d)).rejects.toThrow('薪資單')
  })

  it('delete removes payslip and income; undo brings both back (D-75)', async () => {
    const s = await savePayslip(null, oct, d, now)
    const saved = await deletePayslip(s.id, d)
    expect(await d.payslips.count()).toBe(0)
    expect(await d.transactions.count()).toBe(0)
    await restorePayslip(saved, d)
    expect(await d.payslips.get(s.id)).toEqual(s)
    expect(await d.transactions.get(s.transactionId!)).toEqual(saved.tx)
  })
})

describe('salary items (D-68)', () => {
  it('adds at the end of its kind, renames, toggles nature, rejects duplicates', async () => {
    const it1 = await addSalaryItem({ name: '交通津貼', kind: 'earning', nature: 'fixed' }, d)
    expect(it1.sortOrder).toBe(7)
    await expect(addSalaryItem({ name: '交通津貼', kind: 'earning', nature: 'fixed' }, d)).rejects.toThrow('已經有')
    await updateSalaryItem(it1.id, { name: '車馬費', nature: 'variable', isActive: false }, d)
    expect(await d.salaryItems.get(it1.id)).toMatchObject({ name: '車馬費', nature: 'variable', isActive: false, kind: 'earning' })
  })
})
