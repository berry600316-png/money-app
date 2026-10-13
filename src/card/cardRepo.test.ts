import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBackup, parseBackup } from '../backup/format'
import { readAllData, restoreBackup, restoreRange, undoRestore } from '../backup/store'
import { MoneyDB } from '../db/db'
import { addPaymentMethod, addTransaction, deleteTransaction, MoneyError, updateTransaction } from '../db/repo'
import { DEFAULT_CATEGORIES } from '../db/defaults'
import {
  commitNotificationImport,
  DEFAULT_CARDS_SETTING,
  deferToNext,
  getDefaultCards,
  deleteStatement,
  matchManually,
  reconfirmPair,
  recordFromEntry,
  saveAutoPairs,
  saveStatement,
  applyStatementAmount,
  type StatementInput,
} from './cardRepo'
import { capture, SIM_NOTIFICATION_ADAPTER, SIM_NOTIFICATIONS, SIM_STATEMENT_LINES } from './fixtures'
import { planImport } from './importPlan'
import { reconcile } from './reconcile'
import { parseStatementLines } from './statementParser'

let d: MoneyDB
let n = 0
const now = new Date(2026, 9, 20, 9, 0)
let cardId = ''

beforeEach(async () => {
  d = new MoneyDB(`card-${n++}`)
  await d.open()
  cardId = (await addPaymentMethod({ name: '台新 Richart', type: 'credit_card', bank: '台新', cardLast4: '1234' }, d)).id
})
afterEach(() => d.close())

async function plan(bodies: string[], ids?: string[]) {
  return planImport({
    captures: bodies.map((body, i) => capture({ body, captureId: ids?.[i] ?? `c${i}` })),
    knownCaptureIds: new Set((await d.importedNotifications.toArray()).map((x) => x.captureId)),
    transactions: await d.transactions.toArray(),
    paymentMethods: await d.paymentMethods.toArray(),
    categories: DEFAULT_CATEGORIES,
    history: [],
    defaultCards: {},
    adapters: [SIM_NOTIFICATION_ADAPTER],
    // These cases test the card import path through the (switched-off) generic reader (D-128).
    generic: true,
    now,
  })
}

const statementInput = (): StatementInput => {
  const p = parseStatementLines(SIM_STATEMENT_LINES)
  return { paymentMethodId: cardId, bank: '台新', statementMonth: '2026-10', periodStart: p.periodStart, periodEnd: p.periodEnd, dueDate: p.dueDate, fileHash: 'hash-1', fileName: 'oct.pdf', adapter: 'generic', confirmed: false, entries: p.entries }
}

describe('payment methods as cards (D-80)', () => {
  it('stores bank and last four digits only for credit cards', async () => {
    expect(await d.paymentMethods.get(cardId)).toMatchObject({ bank: '台新', cardLast4: '1234' })
    const cash = await addPaymentMethod({ name: '零錢包', type: 'cash', bank: 'x', cardLast4: '1111' }, d)
    expect(cash.bank).toBeUndefined()
    await expect(addPaymentMethod({ name: 'bad', type: 'credit_card', cardLast4: '12' }, d)).rejects.toThrow('末四碼')
  })
})

describe('notification import (Phase 1)', () => {
  it('imports once; the same file again adds nothing (D-83)', async () => {
    const rows = await plan([SIM_NOTIFICATIONS.convenience, SIM_NOTIFICATIONS.refund])
    const s1 = await commitNotificationImport(rows, { files: 1 }, d, now)
    expect(s1).toMatchObject({ imported: 1, skipped: 1 })
    const t = (await d.transactions.toArray())[0]
    expect(t).toMatchObject({ amount: 85, merchant: '全家便利商店', paymentMethodId: cardId, source: 'notification', externalId: 'c0', type: 'expense' })
    const again = await plan([SIM_NOTIFICATIONS.convenience, SIM_NOTIFICATIONS.refund])
    expect(again.map((r) => r.status)).toEqual(['duplicate', 'duplicate'])
    const s2 = await commitNotificationImport(again, { files: 1 }, d, now)
    expect(s2.imported).toBe(0)
    expect(await d.transactions.count()).toBe(1)
  })
  it('rejects the whole batch when a chosen row has no card, writing nothing', async () => {
    const rows = (await plan(['於10/11 14:05在全家消費NT$85'])).map((r) => ({ ...r, include: true, paymentMethodId: null }))
    await expect(commitNotificationImport(rows, { files: 1 }, d, now)).rejects.toBeInstanceOf(MoneyError)
    expect(await d.transactions.count()).toBe(0)
    expect(await d.importedNotifications.count()).toBe(0)
  })
  it('remembers the chosen card per source app, keeping the choices of other apps (D-84)', async () => {
    await d.settings.put({ key: DEFAULT_CARDS_SETTING, value: { 'Other Bank': 'cash' } })
    const rows = (await plan(['於10/11 14:05在全家消費NT$85'])).map((r) => ({ ...r, paymentMethodId: cardId }))
    await commitNotificationImport(rows, { files: 1, rememberCards: { 'Richart Life': cardId } }, d, now)
    expect(await getDefaultCards(d)).toEqual({ 'Other Bank': 'cash', 'Richart Life': cardId })
  })
})

describe('statements (Phase 2)', () => {
  it('saves entries; the same file or the same card+month cannot be imported twice (D-88)', async () => {
    const st = await saveStatement(statementInput(), {}, d, now)
    expect(st.parseStatus).toBe('needs_review')
    expect(await d.statementEntries.where('statementId').equals(st.id).count()).toBe(7)
    await expect(saveStatement(statementInput(), {}, d, now)).rejects.toThrow('已經匯入過')
    await expect(saveStatement({ ...statementInput(), fileHash: 'hash-2' }, {}, d, now)).rejects.toThrow('已經有帳單')
    const replaced = await saveStatement({ ...statementInput(), fileHash: 'hash-2' }, { replaceId: st.id }, d, now)
    expect(await d.cardStatements.count()).toBe(1)
    expect(await d.statementEntries.where('statementId').equals(replaced.id).count()).toBe(7)
  })
  it('rejects bad entries without writing', async () => {
    await expect(saveStatement({ ...statementInput(), entries: [] }, {}, d, now)).rejects.toThrow('沒有任何')
    const bad = statementInput()
    bad.entries[0] = { ...bad.entries[0], amount: 1.5 }
    await expect(saveStatement(bad, {}, d, now)).rejects.toThrow('金額')
    expect(await d.cardStatements.count()).toBe(0)
  })
})

describe('reconciliation decisions (Phase 3)', () => {
  async function setup() {
    const st = await saveStatement(statementInput(), {}, d, now)
    const entries = await d.statementEntries.where('statementId').equals(st.id).sortBy('order')
    const base = { type: 'expense' as const, categoryId: 'food', paymentMethodId: cardId, note: '' }
    const fam = await addTransaction({ ...base, amount: 85, merchant: '全家', date: '2026-09-18' }, d, now)
    const cpc = await addTransaction({ ...base, amount: 1000, merchant: '中油', date: '2026-10-05' }, d, now)
    const louisa = await addTransaction({ ...base, amount: 150, merchant: '路易莎', date: '2026-09-28' }, d, now)
    return { st, entries, fam, cpc, louisa }
  }
  const run = async (stId: string) =>
    reconcile({
      statement: (await d.cardStatements.get(stId))!,
      entries: await d.statementEntries.where('statementId').equals(stId).toArray(),
      transactions: await d.transactions.where('paymentMethodId').equals(cardId).toArray(),
      recons: await d.reconciliations.toArray(),
    })

  it('auto pairs are saved and then show as matched', async () => {
    const { st, fam } = await setup()
    const r = await run(st.id)
    expect(await saveAutoPairs(st.id, r.autoPairs, d, now)).toBe(1)
    const r2 = await run(st.id)
    expect(r2.autoPairs).toEqual([])
    expect(r2.items.find((i) => i.kind === 'matched' && i.tx.id === fam.id)).toBeTruthy()
  })
  it('back-fill a bank-only entry: one step creates the expense AND the pair (§8.1)', async () => {
    const { st, entries } = await setup()
    const netflix = entries.find((e) => e.merchant.includes('NETFLIX'))!
    const t = await recordFromEntry(st.id, netflix.id, 'fun', d, now)
    expect(t).toMatchObject({ amount: 390, merchant: 'NETFLIX.COM', paymentMethodId: cardId, source: 'statement', categoryId: 'fun' })
    expect(new Date(t.occurredAt).getDate()).toBe(1) // purchase date, not the posting date
    const r = await run(st.id)
    expect(r.items.find((i) => 'entry' in i && i.entry.id === netflix.id)?.kind).toBe('matched')
  })
  it('amount difference: the record is only changed when the user asks; its date never changes (§8.3)', async () => {
    const { st, entries, cpc } = await setup()
    const e = entries.find((x) => x.amount === 1015)!
    await applyStatementAmount(st.id, e.id, cpc.id, d, now)
    const after = (await d.transactions.get(cpc.id))!
    expect(after.amount).toBe(1015)
    expect(after.occurredAt).toBe(cpc.occurredAt)
    expect((await run(st.id)).items.find((i) => 'entry' in i && i.entry.id === e.id)?.kind).toBe('matched')
  })
  it('one-to-one: a record already paired cannot be paired again', async () => {
    const { st, entries, fam } = await setup()
    await matchManually(st.id, entries[0].id, fam.id, '', d, now)
    await expect(matchManually(st.id, entries[1].id, fam.id, '', d, now)).rejects.toThrow('已經和其他')
  })
  it('manual pairs only with an expense on the same card; re-confirming a broken pair is one step', async () => {
    const { st, entries, fam } = await setup()
    const income = await addTransaction({ type: 'income', amount: 85, merchant: 'x', categoryId: 'salary', paymentMethodId: cardId, date: '2026-09-18', note: '' }, d, now)
    await expect(matchManually(st.id, entries[0].id, income.id, '', d, now)).rejects.toThrow('支出')
    const cash = await addTransaction({ type: 'expense', amount: 85, merchant: '全家', categoryId: 'food', paymentMethodId: 'cash', date: '2026-09-18', note: '' }, d, now)
    await expect(matchManually(st.id, entries[0].id, cash.id, '', d, now)).rejects.toThrow('不是用這張卡')
    await matchManually(st.id, entries[0].id, fam.id, '', d, now)
    await updateTransaction(fam.id, { type: 'expense', amount: 86, merchant: '全家', categoryId: 'food', paymentMethodId: cardId, date: '2026-09-18', note: '' }, d, now)
    const broken = (await d.reconciliations.toArray()).find((r) => r.transactionId === fam.id)!
    await reconfirmPair(broken.id, d, now)
    expect((await run(st.id)).items.find((i) => 'entry' in i && i.entry.id === entries[0].id)?.kind).toBe('matched')
    expect(await d.reconciliations.count()).toBe(1)
  })
  it('unticked suspected duplicates are not remembered, so they can be imported later', async () => {
    const rows = (await plan([SIM_NOTIFICATIONS.convenience])).map((r) => ({ ...r, include: false }))
    await commitNotificationImport(rows, { files: 1 }, d, now)
    expect(await d.importedNotifications.count()).toBe(0)
    expect((await plan([SIM_NOTIFICATIONS.convenience]))[0].status).toBe('new')
  })

  it('defer to next statement keeps the record waiting, never deleted (§8.2)', async () => {
    const { st, louisa } = await setup()
    expect((await run(st.id)).items.find((i) => 'tx' in i && i.tx?.id === louisa.id)?.kind).toBe('book_only')
    await deferToNext(st.id, louisa.id, d, now)
    expect((await run(st.id)).items.find((i) => 'tx' in i && i.tx?.id === louisa.id)?.kind).toBe('pending_next')
    expect(await d.transactions.get(louisa.id)).toBeTruthy()
  })
  it('editing or deleting a paired record breaks the pair instead of staying "matched" (spec §10)', async () => {
    const { st, entries, fam } = await setup()
    await matchManually(st.id, entries[0].id, fam.id, '', d, now)
    await updateTransaction(fam.id, { type: 'expense', amount: 86, merchant: '全家', categoryId: 'food', paymentMethodId: cardId, date: '2026-09-18', note: '' }, d, now)
    expect((await run(st.id)).items.find((i) => 'entry' in i && i.entry.id === entries[0].id)?.kind).toBe('broken')
    await deleteTransaction(fam.id, d)
    const b = (await run(st.id)).items.find((i) => 'entry' in i && i.entry.id === entries[0].id)
    expect(b?.kind === 'broken' && b.reason).toContain('刪除')
  })
  it('deleting a statement removes its entries and decisions', async () => {
    const { st, entries, fam } = await setup()
    await matchManually(st.id, entries[0].id, fam.id, '', d, now)
    await deleteStatement(st.id, d)
    expect(await d.statementEntries.count()).toBe(0)
    expect(await d.reconciliations.count()).toBe(0)
    expect(await d.transactions.get(fam.id)).toBeTruthy()
  })
})

describe('backups with card data (D-94)', () => {
  it('full round trip keeps statements, entries, pairs and notifications identical', async () => {
    await commitNotificationImport(await plan([SIM_NOTIFICATIONS.convenience]), { files: 1 }, d, now)
    const st = await saveStatement(statementInput(), {}, d, now)
    const entries = await d.statementEntries.where('statementId').equals(st.id).sortBy('order')
    const t = (await d.transactions.toArray())[0]
    await matchManually(st.id, entries[0].id, t.id, '', d, now)
    const before = await readAllData(d)
    const other = new MoneyDB(`card-target-${n++}`)
    await other.open()
    await restoreBackup(parseBackup(JSON.stringify(buildBackup(before, now))), other, now)
    const after = await readAllData(other)
    const sort = <T extends { id: string }>(a: T[]) => [...a].sort((x, y) => x.id.localeCompare(y.id))
    for (const k of ['cardStatements', 'statementEntries', 'reconciliations', 'importedNotifications', 'importBatches', 'paymentMethods', 'transactions'] as const) {
      expect(sort(after[k] as { id: string }[])).toEqual(sort(before[k] as { id: string }[]))
    }
    other.close()
  })
  it('rejects backups with dangling or duplicate card links', async () => {
    const st = await saveStatement(statementInput(), {}, d, now)
    const entries = await d.statementEntries.where('statementId').equals(st.id).sortBy('order')
    const t = await addTransaction({ type: 'expense', amount: 85, merchant: '全家', categoryId: 'food', paymentMethodId: cardId, date: '2026-09-18', note: '' }, d, now)
    await matchManually(st.id, entries[0].id, t.id, '', d, now)
    const b = JSON.parse(JSON.stringify(buildBackup(await readAllData(d), now)))
    expect(() => parseBackup(JSON.stringify({ ...b, cardStatements: [] }))).toThrow('對應的帳單')
    const dup = { ...b.reconciliations[0], id: 'dup' }
    expect(() => parseBackup(JSON.stringify({ ...b, reconciliations: [...b.reconciliations, dup] }))).toThrow('重複的核對配對')
    expect(() => parseBackup(JSON.stringify({ ...b, cardStatements: [b.cardStatements[0], { ...b.cardStatements[0], id: 'x' }] }))).toThrow('重複的帳單')
  })
  it('a backup taken after deleting a paired record still restores; the pair shows as broken (verifier finding)', async () => {
    const st = await saveStatement(statementInput(), {}, d, now)
    const entries = await d.statementEntries.where('statementId').equals(st.id).sortBy('order')
    const base = { type: 'expense' as const, categoryId: 'food', paymentMethodId: cardId, note: '' }
    const t = await addTransaction({ ...base, amount: 85, merchant: '全家', date: '2026-09-18' }, d, now)
    const lou = await addTransaction({ ...base, amount: 150, merchant: '路易莎', date: '2026-09-28' }, d, now)
    await matchManually(st.id, entries[0].id, t.id, '', d, now)
    await deferToNext(st.id, lou.id, d, now)
    await deleteTransaction(t.id, d)
    await deleteTransaction(lou.id, d)
    const parsed = parseBackup(JSON.stringify(buildBackup(await readAllData(d), now)))
    expect(parsed.reconciliations.map((r) => r.status)).toEqual(['matched']) // the note on a deleted record is dropped
    const other = new MoneyDB(`card-dangling-${n++}`)
    await other.open()
    await restoreBackup(parsed, other, now)
    const r = reconcile({ statement: st, entries, transactions: await other.transactions.toArray(), recons: await other.reconciliations.toArray() })
    expect(r.items.find((i) => 'entry' in i && i.entry.id === entries[0].id)?.kind).toBe('broken')
    other.close()
  })

  it('range restore leaves card data alone; a pair whose record was replaced shows as broken; undo restores', async () => {
    const st = await saveStatement(statementInput(), {}, d, now)
    const entries = await d.statementEntries.where('statementId').equals(st.id).sortBy('order')
    const backup = parseBackup(JSON.stringify(buildBackup(await readAllData(d), now))) // no transactions yet
    const t = await addTransaction({ type: 'expense', amount: 85, merchant: '全家', categoryId: 'food', paymentMethodId: cardId, date: '2026-09-18', note: '' }, d, now)
    await matchManually(st.id, entries[0].id, t.id, '', d, now)
    const before = await readAllData(d)
    await restoreRange(backup, '2026-09-01', '2026-09-30', d, now)
    expect(await d.transactions.get(t.id)).toBeUndefined()
    expect(await d.reconciliations.count()).toBe(1) // kept, and now reported as broken by the engine
    const r = reconcile({ statement: st, entries, transactions: await d.transactions.toArray(), recons: await d.reconciliations.toArray() })
    expect(r.items.find((i) => 'entry' in i && i.entry.id === entries[0].id)?.kind).toBe('broken')
    await undoRestore(d)
    const back = await readAllData(d)
    expect(back.reconciliations).toEqual(before.reconciliations)
    expect(back.transactions).toEqual(before.transactions)
  })
  it('schema v2 → v3 upgrade keeps data and adds empty card tables', async () => {
    const name = `card-up-${n++}`
    const v2 = new Dexie(name)
    v2.version(1).stores({ transactions: 'id, occurredAt, type, categoryId, paymentMethodId, [source+externalId]', categories: 'id, type', paymentMethods: 'id', settings: 'key' })
    v2.version(2).stores({ salaryItems: 'id, kind', payslips: 'id, &month, payDate' })
    await v2.open()
    await v2.table('transactions').add({ id: 't1', amount: 5 })
    await v2.table('payslips').add({ id: 'p1', month: '2026-09', payDate: '2026-10-05' })
    v2.close()
    const up = new MoneyDB(name)
    await up.open()
    expect(await up.transactions.get('t1')).toEqual({ id: 't1', amount: 5 })
    expect(await up.payslips.get('p1')).toMatchObject({ month: '2026-09' })
    expect(await up.cardStatements.count()).toBe(0)
    up.close()
  })
})
