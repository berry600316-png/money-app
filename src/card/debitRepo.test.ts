import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyDB } from '../db/db'
import { addPaymentMethod, addTransaction, updateTransaction } from '../db/repo'
import { explain, matchManually, recordFromEntry, recordTransferFromEntry, saveStatement } from './cardRepo'
import { reconcile } from './reconcile'

let d: MoneyDB
let sequence = 0
const now = new Date(2026, 9, 20, 12)

beforeEach(async () => { d = new MoneyDB(`debit-repo-${sequence++}`); await d.open() })
afterEach(() => d.close())

async function setup() {
  const bank = await addPaymentMethod({ name: '台新銀行', type: 'bank' }, d, now)
  const other = await addPaymentMethod({ name: '另一帳戶', type: 'bank' }, d, now)
  const card = await addPaymentMethod({ name: '台新金融卡', type: 'debit_card', payFromId: bank.id }, d, now)
  const st = await saveStatement({ paymentMethodId: card.id, statementType: 'debit_card', accountId: bank.id,
    bank: '台新', statementMonth: '2026-10', periodStart: '2026-10-01', periodEnd: '2026-10-31', dueDate: null,
    fileHash: 'debit-pdf', fileName: 'statement.pdf', adapter: 'taishin-debit-v1', confirmed: true,
    entries: [
      { txDate: '2026-10-01', postDate: '2026-10-01', merchant: '購物', amount: 200, kind: 'purchase', currency: 'TWD', foreign: null, reference: null, evidence: 'both', raw: '', },
      { txDate: '2026-10-02', postDate: '2026-10-02', merchant: '退費', amount: -80, kind: 'refund', currency: 'TWD', foreign: null, reference: null, evidence: 'both', raw: '', },
      { txDate: '2026-10-03', postDate: '2026-10-03', merchant: '轉帳', amount: 100, kind: 'transfer_out', currency: 'TWD', foreign: null, reference: null, evidence: 'account', raw: '', },
      { txDate: '2026-10-04', postDate: '2026-10-04', merchant: '提款', amount: 500, kind: 'withdrawal', currency: 'TWD', foreign: null, reference: null, evidence: 'account', raw: '', },
    ],
  }, {}, d, now)
  const entries = await d.statementEntries.where('statementId').equals(st.id).sortBy('order')
  const run = async () => reconcile({ statement: st, entries, transactions: await d.transactions.toArray(), recons: await d.reconciliations.toArray() })
  return { bank, other, card, st, entries, run }
}

describe('debit reconciliation decisions', () => {
  it('upgrades an existing database without old reconciliation marks or deleted book transactions', async () => {
    const name = `debit-migrate-${sequence++}`
    const old = new Dexie(name)
    old.version(11).stores({
      transactions: 'id, occurredAt, type, categoryId, paymentMethodId, toAccountId, sourceAccountId, feeOf, [source+externalId]',
      categories: 'id, type', paymentMethods: 'id', settings: 'key', salaryItems: 'id, kind', payslips: 'id, &month, payDate',
      importedNotifications: 'id, &captureId, batchId, transactionId', importBatches: 'id, createdAt',
      cardStatements: 'id, paymentMethodId, &fileHash, statementMonth', statementEntries: 'id, statementId',
      reconciliations: 'id, statementId, entryId, transactionId', monthlyPlans: 'month', planTemplates: 'id',
      plannedExpenses: 'id, month, &[month+templateId], transactionId', adjustments: 'id, accountId, occurredAt',
    })
    await old.open()
    await old.table('transactions').add({ id: 'old-tx', type: 'expense', amount: 20 })
    await old.table('cardStatements').add({ id: 'old-st', paymentMethodId: 'old-card', fileHash: 'old-file', statementMonth: '2026-09', parseStatus: 'confirmed' })
    await old.table('reconciliations').add({ id: 'old-mark', statementId: 'old-st', entryId: 'old-entry', transactionId: 'old-tx', status: 'matched' })
    old.close()
    const upgraded = new MoneyDB(name)
    await upgraded.open()
    expect((await upgraded.cardStatements.get('old-st'))?.parseStatus).toBe('needs_reimport')
    expect(await upgraded.reconciliations.count()).toBe(0)
    expect((await upgraded.transactions.get('old-tx'))?.amount).toBe(20)
    upgraded.close()
  })
  it('records refund income and bank transfer without creating an expense for withdrawal', async () => {
    const { bank, other, card, st, entries, run } = await setup()
    const purchase = await recordFromEntry(st.id, entries[0].id, 'food', d, now)
    expect(purchase).toMatchObject({ type: 'expense', amount: 200, paymentMethodId: card.id, sourceAccountId: bank.id })
    const refund = await recordFromEntry(st.id, entries[1].id, 'salary', d, now)
    expect(refund).toMatchObject({ type: 'income', amount: 80, paymentMethodId: bank.id })
    const transfer = await recordTransferFromEntry(st.id, entries[2].id, other.id, d, now)
    expect(transfer).toMatchObject({ type: 'transfer', amount: 100, paymentMethodId: bank.id, toAccountId: other.id })
    await expect(recordFromEntry(st.id, entries[3].id, 'food', d, now)).rejects.toThrow('提款')
    expect((await run()).items.filter((item) => item.kind === 'matched')).toHaveLength(3)
  })

  it('requires a reason for manual confirmation and removes the check after editing a book record', async () => {
    const { bank, card, st, entries, run } = await setup()
    const tx = await addTransaction({ type: 'expense', amount: 200, merchant: '購物', categoryId: 'food', paymentMethodId: card.id, sourceAccountId: bank.id, date: '2026-10-01', note: '' }, d, now)
    await matchManually(st.id, entries[0].id, tx.id, '', d, now)
    expect((await run()).items[0].kind).toBe('matched')
    await updateTransaction(tx.id, { type: 'expense', amount: 201, merchant: '購物', categoryId: 'food', paymentMethodId: card.id, sourceAccountId: bank.id, date: '2026-10-01', note: '' }, d, now)
    expect((await run()).items[0].kind).toBe('broken')
    await expect(explain(st.id, { entryId: entries[3].id }, '', d, now)).rejects.toThrow('原因')
    await explain(st.id, { entryId: entries[3].id }, '提款後付現', d, now)
    expect((await run()).items.find((item) => 'entry' in item && item.entry.id === entries[3].id)?.kind).toBe('explained_entry')
    const income = await addTransaction({ type: 'income', amount: 50, merchant: '現金回補', categoryId: 'salary', paymentMethodId: bank.id, date: '2026-10-05', note: '' }, d, now)
    await explain(st.id, { transactionId: income.id }, '已核實現金回補', d, now)
    expect((await run()).items.find((item) => 'tx' in item && item.tx?.id === income.id)?.kind).toBe('explained_tx')
  })
})
