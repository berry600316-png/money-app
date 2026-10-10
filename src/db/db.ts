import Dexie, { type EntityTable } from 'dexie'
import { DEFAULT_CATEGORIES, DEFAULT_PAYMENT_METHODS } from './defaults'
import type { Category, PaymentMethod, Setting, Transaction } from './types'

export const DB_NAME = 'money'
export const SCHEMA_VERSION = 1

/*
 * Schema changes MUST add a new this.version(n) block with an upgrade() that migrates
 * existing rows. Never delete or recreate the database: it holds the user's only copy.
 */
export class MoneyDB extends Dexie {
  transactions!: EntityTable<Transaction, 'id'>
  categories!: EntityTable<Category, 'id'>
  paymentMethods!: EntityTable<PaymentMethod, 'id'>
  settings!: EntityTable<Setting, 'key'>

  constructor(name = DB_NAME) {
    super(name)
    this.version(1).stores({
      transactions: 'id, occurredAt, type, categoryId, paymentMethodId, [source+externalId]',
      categories: 'id, type',
      paymentMethods: 'id',
      settings: 'key',
    })
    // Runs once, when the database is first created on this device.
    this.on('populate', async (tx) => {
      await tx.table('categories').bulkAdd(DEFAULT_CATEGORIES)
      await tx.table('paymentMethods').bulkAdd(DEFAULT_PAYMENT_METHODS)
      await tx.table('settings').bulkAdd([
        { key: 'schemaVersion', value: SCHEMA_VERSION },
        { key: 'installedAt', value: new Date().toISOString() },
      ])
    })
  }
}

export const db = new MoneyDB()
