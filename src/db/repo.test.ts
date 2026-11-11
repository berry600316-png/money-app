import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB, SCHEMA_VERSION } from './db'
import {
  addCategory,
  addPaymentMethod,
  addTransaction,
  deleteTransaction,
  MoneyError,
  lastMerchantPayment,
  manualMerchantPaymentHistory,
  recentMerchants,
  restoreTransaction,
  updateCategory,
  updatePaymentMethod,
  updateTransaction,
  type TxInput,
} from './repo'

let d: MoneyDB
let n = 0
const now = new Date(2026, 9, 10, 9, 15)

beforeEach(async () => {
  d = new MoneyDB(`test-${n++}`)
  await d.open()
})
afterEach(async () => {
  d.close()
})

const base: TxInput = { type: 'expense', amount: 185, merchant: ' 全家 ', categoryId: 'food', paymentMethodId: 'card', date: '2026-10-10', note: '' }

describe('defaults', () => {
  it('seeds categories and payment methods once', async () => {
    expect(await d.categories.count()).toBe(11)
    expect(await d.paymentMethods.count()).toBe(5)
    expect((await d.settings.get('schemaVersion'))?.value).toBe(SCHEMA_VERSION)
  })
})

describe('transactions', () => {
  it('adds with spec fields and trims text', async () => {
    const t = await addTransaction(base, d, now)
    const saved = await d.transactions.get(t.id)
    expect(saved).toMatchObject({ amount: 185, merchant: '全家', source: 'manual', externalId: null, type: 'expense' })
    expect(saved?.occurredAt).toBe(now.toISOString())
    expect((await d.settings.get('lastPaymentMethodId'))?.value).toBe('card')
  })

  it('rejects bad input without writing', async () => {
    await expect(addTransaction({ ...base, amount: 0 }, d, now)).rejects.toBeInstanceOf(MoneyError)
    await expect(addTransaction({ ...base, amount: 12.5 }, d, now)).rejects.toBeInstanceOf(MoneyError)
    await expect(addTransaction({ ...base, date: '2026-10-11' }, d, now)).rejects.toThrow('未來')
    await expect(addTransaction({ ...base, date: '2026-09-99' }, d, now)).rejects.toThrow('日期不正確')
    await expect(addTransaction({ ...base, date: '2026-02-31' }, d, now)).rejects.toThrow('日期不正確')
    await expect(addTransaction({ ...base, date: '2026-13-01' }, d, now)).rejects.toThrow('日期不正確')
    await expect(addTransaction({ ...base, categoryId: 'salary' }, d, now)).rejects.toBeInstanceOf(MoneyError)
    await expect(addTransaction({ ...base, paymentMethodId: 'nope' }, d, now)).rejects.toBeInstanceOf(MoneyError)
    expect(await d.transactions.count()).toBe(0)
  })

  it('keeps the original time when the date is unchanged', async () => {
    const t = await addTransaction({ ...base, date: '2026-10-03' }, d, now)
    const later = new Date(2026, 9, 10, 20)
    const u = await updateTransaction(t.id, { ...base, date: '2026-10-03', amount: 200 }, d, later)
    expect(u.occurredAt).toBe(t.occurredAt)
    expect(u.amount).toBe(200)
    expect(u.createdAt).toBe(t.createdAt)
    expect(u.updatedAt).toBe(later.toISOString())
    const moved = await updateTransaction(t.id, { ...base, date: '2026-10-05' }, d, later)
    expect(new Date(moved.occurredAt).getDate()).toBe(5)
    // editing an old record must not change the default payment method for new entries
    await updateTransaction(t.id, { ...base, date: '2026-10-05', paymentMethodId: 'cash' }, d, later)
    expect((await d.settings.get('lastPaymentMethodId'))?.value).toBe('card')
  })

  it('delete returns the record and undo restores it unchanged', async () => {
    const t = await addTransaction(base, d, now)
    const del = await deleteTransaction(t.id, d)
    expect(await d.transactions.count()).toBe(0)
    await restoreTransaction(del, d)
    expect(await d.transactions.get(t.id)).toEqual(t)
  })

  it('suggests distinct recent merchants of the same type', async () => {
    await addTransaction({ ...base, merchant: '全家便利商店', categoryId: 'food', date: '2026-10-09' }, d, new Date(2026, 9, 9, 8))
    await addTransaction({ ...base, merchant: '全聯福利中心', categoryId: 'daily', date: '2026-10-09' }, d, new Date(2026, 9, 9, 12))
    await addTransaction({ ...base, merchant: '全家便利商店', categoryId: 'daily', date: '2026-10-10' }, d, now)
    const s = await recentMerchants('全', 'expense', 4, d)
    expect(s).toEqual([
      { merchant: '全家便利商店', categoryId: 'daily' },
      { merchant: '全聯福利中心', categoryId: 'daily' },
    ])
    expect(await recentMerchants('全', 'income', 4, d)).toEqual([])
    expect(await recentMerchants('全家便利商店', 'expense', 4, d)).toEqual([])
  })

  it('prefers an exact merchant over newer similar names and ignores imported or generated expenses', async () => {
    const exact = await addTransaction({ ...base, merchant: '全家中山店', paymentMethodId: 'cash', date: '2026-10-07' }, d, now)
    await addTransaction({ ...base, merchant: '全家台北店', paymentMethodId: 'card', date: '2026-10-08' }, d, now)
    const imported = await addTransaction({ ...base, merchant: '全家中山店', paymentMethodId: 'card', date: '2026-10-09' }, d, now)
    await d.transactions.update(imported.id, { source: 'statement' })
    const fee = await addTransaction({ ...base, merchant: '全家中山店', paymentMethodId: 'card', date: '2026-10-10' }, d, now)
    await d.transactions.update(fee.id, { feeOf: 'transfer' })

    const history = await manualMerchantPaymentHistory(d)
    expect(lastMerchantPayment(' 全家中山店 ', history)).toEqual({ paymentMethodId: exact.paymentMethodId })
    expect(lastMerchantPayment('全家松山店', history)).toEqual({ paymentMethodId: 'card' })
    expect(lastMerchantPayment('不存在的商家', history)).toBeNull()
  })

  it('uses transaction date rather than save order and returns the full payment choice', async () => {
    await d.paymentMethods.add({ id: 'bank-a', name: '銀行 A', type: 'bank', isActive: true, sortOrder: 5 })
    await addTransaction({ ...base, merchant: 'A', paymentMethodId: 'cash', date: '2026-10-08' }, d, now)
    await addTransaction({ ...base, merchant: 'A', paymentMethodId: 'transfer', sourceAccountId: 'bank-a', date: '2026-10-10' }, d, now)
    await addTransaction({ ...base, merchant: 'A', paymentMethodId: 'cash', date: '2026-10-09' }, d, now)

    expect(lastMerchantPayment('a', await manualMerchantPaymentHistory(d))).toEqual({ paymentMethodId: 'transfer', sourceAccountId: 'bank-a' })
  })

  it('uses the most recently saved payment when two purchases have the same minute', async () => {
    const first = new Date(2026, 9, 10, 9, 15, 1)
    const second = new Date(2026, 9, 10, 9, 16, 20)
    const earlier = await addTransaction({ ...base, merchant: 'A', paymentMethodId: 'cash', time: '09:15' }, d, first)
    await addTransaction({ ...base, merchant: 'A', paymentMethodId: 'card', time: '09:15' }, d, second)

    expect(lastMerchantPayment('A', await manualMerchantPaymentHistory(d))).toEqual({ paymentMethodId: 'card' })
    await updateTransaction(earlier.id, { ...base, merchant: 'A', paymentMethodId: 'cash', time: '09:15' }, d, new Date(2026, 9, 10, 9, 17))
    expect(lastMerchantPayment('A', await manualMerchantPaymentHistory(d))).toEqual({ paymentMethodId: 'cash' })
  })

  it('recognises different branches of an unknown merchant name', async () => {
    await addTransaction({ ...base, merchant: '阿華早餐店中山店', paymentMethodId: 'cash' }, d, now)
    const history = await manualMerchantPaymentHistory(d)
    expect(lastMerchantPayment('阿華早餐店台北店', history)).toEqual({ paymentMethodId: 'cash' })
    expect(lastMerchantPayment('阿華早餐館', history)).toBeNull()
  })
})

describe('categories & payment methods', () => {
  it('adds a category at the end of its type', async () => {
    const c = await addCategory({ name: '寵物', type: 'expense', icon: 'pet' }, d)
    expect(c.sortOrder).toBe(8)
    await expect(addCategory({ name: '寵物', type: 'expense', icon: 'pet' }, d)).rejects.toThrow('已經有')
    await expect(addCategory({ name: '  ', type: 'expense', icon: 'pet' }, d)).rejects.toThrow('名稱')
  })

  it('deactivated categories keep their history', async () => {
    const t = await addTransaction(base, d, now)
    await updateCategory('food', { isActive: false }, d)
    expect((await d.categories.get('food'))?.isActive).toBe(false)
    expect((await d.transactions.get(t.id))?.categoryId).toBe('food')
  })

  it('keeps at least one active category per type (D-15)', async () => {
    await updateCategory('salary', { isActive: false }, d)
    await updateCategory('bonus', { isActive: false }, d)
    await expect(updateCategory('other_income', { isActive: false }, d)).rejects.toThrow('至少要保留一個收入分類')
  })

  it('payment methods: add, rename, keep one active', async () => {
    const p = await addPaymentMethod({ name: '台新卡', type: 'credit_card' }, d)
    expect(p).toMatchObject({ type: 'credit_card', isActive: true, sortOrder: 5 })
    await updatePaymentMethod(p.id, { name: 'Richart 卡' }, d)
    expect((await d.paymentMethods.get(p.id))?.name).toBe('Richart 卡')
    for (const id of ['cash', 'card', 'easycard', 'mobile', 'transfer']) await updatePaymentMethod(id, { isActive: false }, d)
    await expect(updatePaymentMethod(p.id, { isActive: false }, d)).rejects.toThrow('至少要保留一個帳戶或付款方式')
  })
})

describe('date and time (D-99, D-100)', () => {
  const at = (iso: string) => {
    const t = new Date(iso)
    return [t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes()]
  }
  it('stores the chosen local time; the current minute keeps the exact instant', async () => {
    const a = await addTransaction({ ...base, date: '2026-10-08', time: '21:40' }, d, now)
    expect(at(a.occurredAt)).toEqual([2026, 10, 8, 21, 40])
    const b = await addTransaction({ ...base, date: '2026-10-10', time: '09:15' }, d, now)
    expect(b.occurredAt).toBe(now.toISOString())
  })
  it('rejects a future time and an invalid one', async () => {
    await expect(addTransaction({ ...base, date: '2026-10-10', time: '09:16' }, d, now)).rejects.toThrow('不能選未來的時間')
    await expect(addTransaction({ ...base, date: '2026-10-09', time: '24:00' }, d, now)).rejects.toThrow('時間不正確')
    await expect(addTransaction({ ...base, date: '2026-10-09', time: '9:05' }, d, now)).rejects.toThrow('時間不正確')
    expect(await d.transactions.count()).toBe(0)
  })
  it('allows a later time today only for an eligible expense draft, without storing that permission', async () => {
    const later = await addTransaction({ ...base, paymentMethodId: 'cash', time: '12:00', allowFutureMealTime: true }, d, now)
    expect(at(later.occurredAt)).toEqual([2026, 10, 10, 12, 0])
    expect(later).not.toHaveProperty('allowFutureMealTime')
    await expect(addTransaction({ ...base, type: 'income', time: '12:00', allowFutureMealTime: true }, d, now)).rejects.toThrow('不能選未來的時間')
    await expect(addTransaction({ ...base, date: '2026-10-11', time: '08:00', allowFutureMealTime: true }, d, now)).rejects.toThrow('不能選未來的日期')
  })
  it('preserves an already saved later time during edits, but rejects a new later time without permission', async () => {
    const original = await addTransaction({ ...base, paymentMethodId: 'card', time: '12:00', allowFutureMealTime: true }, d, now)
    const editTime = new Date(2026, 9, 10, 9, 20)
    const kept = await updateTransaction(original.id, { ...base, time: '12:00', note: '已確認' }, d, editTime)
    expect(kept.occurredAt).toBe(original.occurredAt)
    await expect(updateTransaction(original.id, { ...base, time: '13:00' }, d, editTime)).rejects.toThrow('不能選未來的時間')
    const changed = await updateTransaction(original.id, { ...base, time: '13:00', allowFutureMealTime: true }, d, editTime)
    expect(at(changed.occurredAt)).toEqual([2026, 10, 10, 13, 0])
  })
  it('changing the date keeps the chosen time', async () => {
    const a = await addTransaction({ ...base, date: '2026-10-08', time: '21:40' }, d, now)
    const b = await updateTransaction(a.id, { ...base, date: '2026-10-05', time: '21:40' }, d, now)
    expect(at(b.occurredAt)).toEqual([2026, 10, 5, 21, 40])
  })
  it('an unchanged date and time keeps the stored instant and its time source; a new time drops the marker', async () => {
    const stored = new Date(2026, 9, 7, 14, 5, 33).toISOString()
    await d.transactions.add({ id: 'n1', type: 'expense', amount: 85, merchant: '全家', categoryId: 'food', paymentMethodId: 'card', occurredAt: stored, note: '', source: 'notification', externalId: 'c1', createdAt: stored, updatedAt: stored, timeSource: 'notification' })
    const same = await updateTransaction('n1', { ...base, amount: 90, date: '2026-10-07', time: '14:05' }, d, now)
    expect(same.occurredAt).toBe(stored)
    expect(same.timeSource).toBe('notification')
    const moved = await updateTransaction('n1', { ...base, amount: 90, date: '2026-10-07', time: '13:58' }, d, now)
    expect(at(moved.occurredAt)).toEqual([2026, 10, 7, 13, 58])
    expect(moved.timeSource).toBeUndefined()
    expect((await d.transactions.get('n1'))?.timeSource).toBeUndefined()
  })
  it('records written before times existed are never touched', async () => {
    const noon = new Date(2026, 9, 1, 12, 0).toISOString()
    await d.transactions.add({ id: 'old', type: 'expense', amount: 50, merchant: '', categoryId: 'food', paymentMethodId: 'card', occurredAt: noon, note: '', source: 'manual', externalId: null, createdAt: noon, updatedAt: noon })
    const t = await updateTransaction('old', { ...base, date: '2026-10-01', time: '12:00', note: '午餐' }, d, now)
    expect(t.occurredAt).toBe(noon)
  })
})

describe('category icons (D-127)', () => {
  it('can be chosen when adding and changed later; new income gets the income icon', async () => {
    const c = await addCategory({ name: '寵物', type: 'expense', icon: 'pet' }, d)
    await updateCategory(c.id, { icon: 'gift' }, d)
    expect((await d.categories.get(c.id))!.icon).toBe('gift')
    const inc = await addCategory({ name: '利息', type: 'income' }, d)
    expect(inc.icon).toBe('plusCircle')
    await expect(updateCategory(c.id, { icon: '<svg>' }, d)).rejects.toThrow('圖示')
    await expect(addCategory({ name: 'x', type: 'expense', icon: '' }, d)).rejects.toThrow('圖示')
  })
})
