/*
 * Backup file format (spec 0.9, decisions D-40/D-42). Pure functions only: no database access,
 * so every rule here is covered by unit tests.
 */
import type { Category, PaymentMethod, PaymentType, Setting, Transaction, TxType } from '../db/types'
import { PAYMENT_TYPE_LABELS } from '../db/types'
import { SCHEMA_VERSION } from '../db/db'
import { isValidAmount } from '../lib/money'
import { timeLabel, toYmd } from '../lib/dates'

export const BACKUP_APP = 'money'
export const BACKUP_FORMAT = 1

/** Settings that describe this device, not the user's data; never exported, never overwritten by a restore. */
export const DEVICE_SETTING_KEYS = new Set([
  'schemaVersion',
  'installedAt',
  'lastBackupAt',
  'txCountAtLastBackup',
  'backupReminderDismissedAt',
  'preRestoreSnapshot',
])

export interface MoneyData {
  transactions: Transaction[]
  categories: Category[]
  paymentMethods: PaymentMethod[]
  settings: Setting[]
}

export interface BackupFile extends MoneyData {
  app: typeof BACKUP_APP
  format: typeof BACKUP_FORMAT
  schemaVersion: number
  exportedAt: string
}

export class BackupError extends Error {}

export function buildBackup(data: MoneyData, now = new Date()): BackupFile {
  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    transactions: [...data.transactions].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0)),
    categories: data.categories,
    paymentMethods: data.paymentMethods,
    settings: data.settings.filter((s) => !DEVICE_SETTING_KEYS.has(s.key)),
  }
}

function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function backupFileName(now = new Date()): string {
  return `money-backup-${stamp(now)}.json`
}

export function csvFileName(now = new Date()): string {
  return `money-transactions-${stamp(now)}.csv`
}

/* ---------------- validation ---------------- */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isIso = (v: unknown): v is string => isStr(v) && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))
const TX_TYPES: TxType[] = ['expense', 'income']
const PAY_TYPES = Object.keys(PAYMENT_TYPE_LABELS) as PaymentType[]

function fail(msg: string): never {
  throw new BackupError(msg)
}

function checkUnique(items: { id: string }[], what: string) {
  const seen = new Set<string>()
  for (const it of items) {
    if (seen.has(it.id)) fail(`備份檔有重複的${what}（${it.id}）`)
    seen.add(it.id)
  }
}

/**
 * Parse and fully validate a backup file. Throws BackupError with a message the user can act on;
 * nothing is written anywhere until this returns.
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    fail('這不是 Money 的備份檔（無法讀取 JSON）')
  }
  if (!isObj(raw) || raw.app !== BACKUP_APP) fail('這不是 Money 的備份檔')
  if (raw.format !== BACKUP_FORMAT) fail('這個備份檔的版本比 App 新，請先更新 App')
  if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion > SCHEMA_VERSION) fail('這個備份檔的版本比 App 新，請先更新 App')
  if (!isIso(raw.exportedAt)) fail('備份檔缺少匯出時間')
  for (const k of ['transactions', 'categories', 'paymentMethods', 'settings'] as const) {
    if (!Array.isArray(raw[k])) fail('備份檔內容不完整')
  }

  const categories = (raw.categories as unknown[]).map((c, i): Category => {
    const n = i + 1
    if (!isObj(c) || !isStr(c.id) || !c.id) fail(`第 ${n} 個分類缺少編號`)
    if (!isStr(c.name) || !c.name.trim()) fail(`第 ${n} 個分類缺少名稱`)
    if (!TX_TYPES.includes(c.type as TxType)) fail(`分類「${c.name}」的類型不正確`)
    if (!isStr(c.icon)) fail(`分類「${c.name}」缺少圖示`)
    if (typeof c.isActive !== 'boolean') fail(`分類「${c.name}」缺少啟用狀態`)
    if (typeof c.sortOrder !== 'number' || !Number.isFinite(c.sortOrder)) fail(`分類「${c.name}」缺少排序`)
    return { id: c.id, name: c.name, type: c.type as TxType, icon: c.icon, isActive: c.isActive, sortOrder: c.sortOrder }
  })
  checkUnique(categories, '分類')

  const paymentMethods = (raw.paymentMethods as unknown[]).map((p, i): PaymentMethod => {
    const n = i + 1
    if (!isObj(p) || !isStr(p.id) || !p.id) fail(`第 ${n} 個付款方式缺少編號`)
    if (!isStr(p.name) || !p.name.trim()) fail(`第 ${n} 個付款方式缺少名稱`)
    if (!PAY_TYPES.includes(p.type as PaymentType)) fail(`付款方式「${p.name}」的類型不正確`)
    if (typeof p.isActive !== 'boolean') fail(`付款方式「${p.name}」缺少啟用狀態`)
    if (typeof p.sortOrder !== 'number' || !Number.isFinite(p.sortOrder)) fail(`付款方式「${p.name}」缺少排序`)
    return { id: p.id, name: p.name, type: p.type as PaymentType, isActive: p.isActive, sortOrder: p.sortOrder }
  })
  checkUnique(paymentMethods, '付款方式')

  // D-15: the restored data must leave the app usable.
  for (const t of TX_TYPES) {
    if (!categories.some((c) => c.type === t && c.isActive)) fail(`備份檔沒有可用的${t === 'expense' ? '支出' : '收入'}分類`)
  }
  if (!paymentMethods.some((p) => p.isActive)) fail('備份檔沒有可用的付款方式')

  const catById = new Map(categories.map((c) => [c.id, c]))
  const payIds = new Set(paymentMethods.map((p) => p.id))

  const transactions = (raw.transactions as unknown[]).map((t, i): Transaction => {
    const n = i + 1
    if (!isObj(t) || !isStr(t.id) || !t.id) fail(`第 ${n} 筆交易缺少編號`)
    if (!TX_TYPES.includes(t.type as TxType)) fail(`第 ${n} 筆交易的類型不正確`)
    if (!isValidAmount(t.amount)) fail(`第 ${n} 筆交易的金額不正確`)
    if (!isStr(t.categoryId) || catById.get(t.categoryId)?.type !== t.type) fail(`第 ${n} 筆交易的分類不存在`)
    if (!isStr(t.paymentMethodId) || !payIds.has(t.paymentMethodId)) fail(`第 ${n} 筆交易的付款方式不存在`)
    if (!isIso(t.occurredAt) || !isIso(t.createdAt) || !isIso(t.updatedAt)) fail(`第 ${n} 筆交易的時間不正確`)
    if (!isStr(t.merchant) || !isStr(t.note) || !isStr(t.source)) fail(`第 ${n} 筆交易的文字欄位不正確`)
    if (t.externalId !== null && !isStr(t.externalId)) fail(`第 ${n} 筆交易的外部編號不正確`)
    return {
      id: t.id,
      type: t.type as TxType,
      amount: t.amount as number,
      merchant: t.merchant,
      categoryId: t.categoryId,
      paymentMethodId: t.paymentMethodId,
      occurredAt: t.occurredAt,
      note: t.note,
      source: t.source,
      externalId: t.externalId as string | null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }
  })
  checkUnique(transactions, '交易')

  const settings = (raw.settings as unknown[]).map((s, i): Setting => {
    if (!isObj(s) || !isStr(s.key) || !('value' in s)) fail(`第 ${i + 1} 個設定不正確`)
    return { key: s.key, value: s.value }
  })

  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    schemaVersion: raw.schemaVersion,
    exportedAt: raw.exportedAt,
    transactions,
    categories,
    paymentMethods,
    settings: settings.filter((s) => !DEVICE_SETTING_KEYS.has(s.key)),
  }
}

/* ---------------- CSV (D-42) ---------------- */

export const CSV_HEADER = ['日期', '時間', '類型', '金額', '分類', '付款方式', '商家', '備註']

function csvCell(v: string): string {
  // Spreadsheet apps run cells that start with = + - @ as formulas; keep them as text.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(
  transactions: readonly Transaction[],
  names: { category: (id: string) => string; payment: (id: string) => string },
): string {
  const rows = [...transactions]
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0))
    .map((t) => {
      const d = new Date(t.occurredAt)
      return [
        toYmd(d),
        timeLabel(d),
        t.type === 'income' ? '收入' : '支出',
        String(t.amount),
        names.category(t.categoryId),
        names.payment(t.paymentMethodId),
        t.merchant,
        t.note,
      ]
        .map(csvCell)
        .join(',')
    })
  // BOM so Excel opens UTF-8 Chinese correctly; CRLF line endings for spreadsheet apps.
  return '﻿' + [CSV_HEADER.join(','), ...rows].join('\r\n') + '\r\n'
}
