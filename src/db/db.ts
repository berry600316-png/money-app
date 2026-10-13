import Dexie, { type EntityTable } from 'dexie'
import { DEFAULT_CATEGORIES, DEFAULT_PAYMENT_METHODS, DEFAULT_SALARY_ITEMS } from './defaults'
import { captureFingerprint } from '../card/notificationFile'
import { migrateWalletLinks, type LegacyPaymentMethod } from '../lib/accounts'
import type {
  BalanceAdjustment,
  CardStatement,
  Category,
  ImportBatch,
  ImportedNotification,
  MonthlyPlan,
  PaymentMethod,
  Payslip,
  PlannedExpense,
  PlanTemplate,
  Reconciliation,
  SalaryItem,
  Setting,
  StatementEntry,
  Transaction,
} from './types'

export const DB_NAME = 'money'
export const SCHEMA_VERSION = 7

/*
 * Schema changes MUST add a new this.version(n) block with an upgrade() that migrates
 * existing rows. Never delete or recreate the database: it holds the user's only copy.
 */
export class MoneyDB extends Dexie {
  transactions!: EntityTable<Transaction, 'id'>
  categories!: EntityTable<Category, 'id'>
  paymentMethods!: EntityTable<PaymentMethod, 'id'>
  settings!: EntityTable<Setting, 'key'>
  salaryItems!: EntityTable<SalaryItem, 'id'>
  payslips!: EntityTable<Payslip, 'id'>
  importedNotifications!: EntityTable<ImportedNotification, 'id'>
  importBatches!: EntityTable<ImportBatch, 'id'>
  cardStatements!: EntityTable<CardStatement, 'id'>
  statementEntries!: EntityTable<StatementEntry, 'id'>
  reconciliations!: EntityTable<Reconciliation, 'id'>
  monthlyPlans!: EntityTable<MonthlyPlan, 'month'>
  planTemplates!: EntityTable<PlanTemplate, 'id'>
  plannedExpenses!: EntityTable<PlannedExpense, 'id'>
  adjustments!: EntityTable<BalanceAdjustment, 'id'>

  constructor(name = DB_NAME) {
    super(name)
    this.version(1).stores({
      transactions: 'id, occurredAt, type, categoryId, paymentMethodId, [source+externalId]',
      categories: 'id, type',
      paymentMethods: 'id',
      settings: 'key',
    })
    // v2: payslips and salary items (D-60..D-75). Existing data is untouched.
    this.version(2)
      .stores({
        salaryItems: 'id, kind',
        payslips: 'id, &month, payDate',
      })
      .upgrade(async (tx) => {
        await tx.table('salaryItems').bulkAdd(DEFAULT_SALARY_ITEMS)
        await tx.table('settings').put({ key: 'schemaVersion', value: 2 })
      })
    // v3: credit card module (D-80..D-95). New tables only; existing data is untouched.
    this.version(3)
      .stores({
        importedNotifications: 'id, &captureId, batchId, transactionId',
        importBatches: 'id, createdAt',
        cardStatements: 'id, paymentMethodId, &fileHash, statementMonth',
        statementEntries: 'id, statementId',
        reconciliations: 'id, statementId, entryId, transactionId',
      })
      .upgrade(async (tx) => {
        await tx.table('settings').put({ key: 'schemaVersion', value: 3 })
      })
    // v4: monthly planning (D-105). New tables only; transactions are never touched (existing times stay as stored, D-99).
    this.version(4)
      .stores({
        monthlyPlans: 'month',
        planTemplates: 'id',
        plannedExpenses: 'id, month, &[month+templateId], transactionId',
      })
      .upgrade(async (tx) => {
        await tx.table('settings').put({ key: 'schemaVersion', value: 4 })
      })
    // v5: accounts (D-117..D-121). Transfers and account links are new optional fields; existing rows are
    // untouched, and no account gets a balance until the user sets one (D-118: never guess old data).
    this.version(5)
      .stores({
        transactions: 'id, occurredAt, type, categoryId, paymentMethodId, toAccountId, sourceAccountId, feeOf, [source+externalId]',
        adjustments: 'id, accountId, occurredAt',
      })
      .upgrade(async (tx) => {
        await tx.table('settings').put({ key: 'schemaVersion', value: 5 })
      })
    // v6 (D-131): notifications that never became a record keep no text; each keeps a fingerprint of its
    // content (taken here, before the text goes) so a later capture reusing its id is still told apart.
    this.version(6)
      .stores({})
      .upgrade(async (tx) => {
        await tx
          .table('importedNotifications')
          .toCollection()
          .modify((n: ImportedNotification) => {
            if (!n.fingerprint && (n.title !== null || n.subtitle !== null || n.body !== null)) n.fingerprint = captureFingerprint(n)
            if (n.status !== 'imported') {
              n.title = null
              n.subtitle = null
              n.body = null
            }
          })
        await tx.table('settings').put({ key: 'schemaVersion', value: 6 })
      })
    // v7 (D-132, Q107 A): a 行動支付 bound to one card (or one bank account) now holds a list of cards; an
    // expense through it that recorded only the account now records that account's debit card when there
    // is exactly one. Nothing else changes.
    this.version(7)
      .stores({})
      .upgrade(async (tx) => {
        const methods = (await tx.table('paymentMethods').toArray()) as LegacyPaymentMethod[]
        const transactions = (await tx.table('transactions').toArray()) as Transaction[]
        const moved = migrateWalletLinks(methods, transactions)
        if (moved.methods.length) await tx.table('paymentMethods').bulkPut(moved.methods)
        if (moved.transactions.length) await tx.table('transactions').bulkPut(moved.transactions)
        await tx.table('settings').put({ key: 'schemaVersion', value: 7 })
      })
    // Runs once, when the database is first created on this device (at the latest version).
    this.on('populate', async (tx) => {
      await tx.table('categories').bulkAdd(DEFAULT_CATEGORIES)
      await tx.table('paymentMethods').bulkAdd(DEFAULT_PAYMENT_METHODS)
      await tx.table('salaryItems').bulkAdd(DEFAULT_SALARY_ITEMS)
      await tx.table('settings').bulkAdd([
        { key: 'schemaVersion', value: SCHEMA_VERSION },
        { key: 'installedAt', value: new Date().toISOString() },
      ])
    })
  }
}

export const db = new MoneyDB()
