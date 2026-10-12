/*
 * Backup file format (spec 0.9, decisions D-40/D-42). Pure functions only: no database access,
 * so every rule here is covered by unit tests.
 */
import type {
  BalanceAdjustment,
  CardStatement,
  CategoryType,
  Category,
  EntryKind,
  ImportBatch,
  ImportedNotification,
  MonthlyPlan,
  NotificationStatus,
  PaymentMethod,
  PlannedExpense,
  PlanTemplate,
  PaymentType,
  Payslip,
  Reconciliation,
  SalaryItem,
  SalaryKind,
  SalaryNature,
  Setting,
  StatementEntry,
  Transaction,
  TxType,
} from '../db/types'
import { isAssetType, PAYMENT_TYPE_LABELS } from '../db/types'
import { SCHEMA_VERSION } from '../db/db'
import { DEFAULT_SALARY_ITEMS } from '../db/defaults'
import { isValidAmount, MAX_AMOUNT } from '../lib/money'
import { fromYmd, timeLabel, toYmd } from '../lib/dates'
import { isMonthKey } from '../lib/months'

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
  /** Schema v2 (D-74). Backups from schema v1 have neither; they restore as defaults / none. */
  salaryItems: SalaryItem[]
  payslips: Payslip[]
  /** Schema v3 (D-94). Older backups restore with none. */
  importedNotifications: ImportedNotification[]
  importBatches: ImportBatch[]
  cardStatements: CardStatement[]
  statementEntries: StatementEntry[]
  reconciliations: Reconciliation[]
  /** Schema v4 (D-114). Older backups restore with none. */
  monthlyPlans: MonthlyPlan[]
  planTemplates: PlanTemplate[]
  plannedExpenses: PlannedExpense[]
  /** Schema v5 (D-124): balance corrections. Older backups restore with none. */
  adjustments: BalanceAdjustment[]
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
    salaryItems: data.salaryItems,
    payslips: [...data.payslips].sort((a, b) => (a.month < b.month ? -1 : 1)),
    importedNotifications: data.importedNotifications,
    importBatches: data.importBatches,
    cardStatements: data.cardStatements,
    statementEntries: data.statementEntries,
    reconciliations: data.reconciliations,
    monthlyPlans: [...(data.monthlyPlans ?? [])].sort((a, b) => (a.month < b.month ? -1 : 1)),
    planTemplates: data.planTemplates ?? [],
    plannedExpenses: data.plannedExpenses ?? [],
    adjustments: [...(data.adjustments ?? [])].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1)),
  }
}

function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function backupFileName(now = new Date()): string {
  return `caijie-backup-${stamp(now)}.json`
}

export function csvFileName(now = new Date()): string {
  return `caijie-transactions-${stamp(now)}.csv`
}

/* ---------------- validation ---------------- */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
/** Exactly the form Date#toISOString writes; the round trip rejects impossible dates such as Feb 31. */
const isIso = (v: unknown): v is string => {
  if (!isStr(v) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return false
  const t = Date.parse(v)
  return !Number.isNaN(t) && new Date(t).toISOString() === v
}
const CAT_TYPES: CategoryType[] = ['expense', 'income']
const TX_TYPES: TxType[] = ['expense', 'income', 'transfer']
const PAY_TYPES = Object.keys(PAYMENT_TYPE_LABELS) as PaymentType[]

const isMoney0 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_AMOUNT
const isYmdStr = (v: unknown): v is string => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && toYmd(fromYmd(v)) === v

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
    fail('這不是 Cai Jie 的備份檔（無法讀取 JSON）')
  }
  if (!isObj(raw) || raw.app !== BACKUP_APP) fail('這不是 Cai Jie 的備份檔')
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
    if (!CAT_TYPES.includes(c.type as CategoryType)) fail(`分類「${c.name}」的類型不正確`)
    if (!isStr(c.icon)) fail(`分類「${c.name}」缺少圖示`)
    if (typeof c.isActive !== 'boolean') fail(`分類「${c.name}」缺少啟用狀態`)
    if (typeof c.sortOrder !== 'number' || !Number.isFinite(c.sortOrder)) fail(`分類「${c.name}」缺少排序`)
    return { id: c.id, name: c.name, type: c.type as CategoryType, icon: c.icon, isActive: c.isActive, sortOrder: c.sortOrder }
  })
  checkUnique(categories, '分類')

  const paymentMethods = (raw.paymentMethods as unknown[]).map((p, i): PaymentMethod => {
    const n = i + 1
    if (!isObj(p) || !isStr(p.id) || !p.id) fail(`第 ${n} 個付款方式缺少編號`)
    if (!isStr(p.name) || !p.name.trim()) fail(`第 ${n} 個付款方式缺少名稱`)
    if (!PAY_TYPES.includes(p.type as PaymentType)) fail(`付款方式「${p.name}」的類型不正確`)
    if (typeof p.isActive !== 'boolean') fail(`付款方式「${p.name}」缺少啟用狀態`)
    if (typeof p.sortOrder !== 'number' || !Number.isFinite(p.sortOrder)) fail(`付款方式「${p.name}」缺少排序`)
    if (p.bank !== undefined && !isStr(p.bank)) fail(`付款方式「${p.name}」的銀行不正確`)
    if (p.cardLast4 !== undefined && (!isStr(p.cardLast4) || !/^\d{4}$/.test(p.cardLast4))) fail(`付款方式「${p.name}」的末四碼不正確`)
    // D-118: a start date and an opening balance come together, or neither.
    const hasStart = p.balanceFrom !== undefined || p.openingBalance !== undefined
    if (hasStart && (!isIso(p.balanceFrom) || !isMoney0(p.openingBalance))) fail(`帳戶「${p.name}」的起始餘額不正確`)
    if (p.payFromId !== undefined && !isStr(p.payFromId)) fail(`信用卡「${p.name}」的繳款帳戶不正確`)
    if (p.boundTo !== undefined && !isStr(p.boundTo)) fail(`付款方式「${p.name}」的綁定不正確`)
    return {
      id: p.id,
      name: p.name,
      type: p.type as PaymentType,
      isActive: p.isActive,
      sortOrder: p.sortOrder,
      ...(isStr(p.bank) ? { bank: p.bank } : {}),
      ...(isStr(p.cardLast4) ? { cardLast4: p.cardLast4 } : {}),
      ...(hasStart ? { balanceFrom: p.balanceFrom as string, openingBalance: p.openingBalance as number } : {}),
      ...(isStr(p.payFromId) ? { payFromId: p.payFromId } : {}),
      ...(isStr(p.boundTo) ? { boundTo: p.boundTo } : {}),
    }
  })
  checkUnique(paymentMethods, '付款方式')
  // A card belongs to a bank account in the file, and a 行動支付 / 其他 is bound to a card or an account
  // in the file; otherwise the link is dropped and it simply counts in no account (D-119, D-125).
  const payById = new Map(paymentMethods.map((p) => [p.id, p]))
  for (const p of paymentMethods) {
    if (p.payFromId !== undefined && (p.type !== 'credit_card' || payById.get(p.payFromId)?.type !== 'bank')) delete p.payFromId
    if (p.boundTo === undefined) continue
    const target = payById.get(p.boundTo)
    if ((p.type !== 'mobile' && p.type !== 'other') || !target || p.boundTo === p.id || !(target.type === 'credit_card' || isAssetType(target.type))) delete p.boundTo
  }

  // D-15: the restored data must leave the app usable.
  for (const t of CAT_TYPES) {
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
    if (!isStr(t.paymentMethodId) || !payIds.has(t.paymentMethodId)) fail(`第 ${n} 筆交易的付款方式不存在`)
    if (t.type === 'transfer') {
      // D-117: a transfer is one record holding both sides, so it can never be restored half-way.
      if (t.categoryId !== '') fail(`第 ${n} 筆互轉不應該有分類`)
      if (!isStr(t.toAccountId) || !payIds.has(t.toAccountId) || t.toAccountId === t.paymentMethodId) fail(`第 ${n} 筆互轉的轉入帳戶不正確`)
    } else {
      if (!isStr(t.categoryId) || catById.get(t.categoryId)?.type !== t.type) fail(`第 ${n} 筆交易的分類不存在`)
      if (t.toAccountId !== undefined) fail(`第 ${n} 筆交易不是互轉，卻有轉入帳戶`)
    }
    if (t.sourceAccountId !== undefined && (t.type !== 'expense' || !isStr(t.sourceAccountId) || !payIds.has(t.sourceAccountId))) fail(`第 ${n} 筆交易的扣款帳戶不正確`)
    // D-125: a card charged through a bound 行動支付 / 其他.
    if (
      t.cardId !== undefined &&
      (t.type !== 'expense' || t.sourceAccountId !== undefined || !isStr(t.cardId) || payById.get(t.cardId)?.type !== 'credit_card' || !['mobile', 'other'].includes(payById.get(t.paymentMethodId as string)?.type ?? ''))
    ) {
      fail(`第 ${n} 筆交易的信用卡不正確`)
    }
    if (t.feeOf !== undefined && (t.type !== 'expense' || !isStr(t.feeOf))) fail(`第 ${n} 筆手續費的互轉連結不正確`)
    if (!isIso(t.occurredAt) || !isIso(t.createdAt) || !isIso(t.updatedAt)) fail(`第 ${n} 筆交易的時間不正確`)
    if (!isStr(t.merchant) || !isStr(t.note) || !isStr(t.source)) fail(`第 ${n} 筆交易的文字欄位不正確`)
    if (t.externalId !== null && !isStr(t.externalId)) fail(`第 ${n} 筆交易的外部編號不正確`)
    if (t.timeSource !== undefined && t.timeSource !== 'notification' && t.timeSource !== 'date') fail(`第 ${n} 筆交易的時間來源不正確`)
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
      ...(t.timeSource ? { timeSource: t.timeSource as Transaction['timeSource'] } : {}),
      ...(isStr(t.toAccountId) ? { toAccountId: t.toAccountId } : {}),
      ...(isStr(t.sourceAccountId) ? { sourceAccountId: t.sourceAccountId } : {}),
      ...(isStr(t.cardId) ? { cardId: t.cardId } : {}),
      ...(isStr(t.feeOf) ? { feeOf: t.feeOf } : {}),
    }
  })
  checkUnique(transactions, '交易')
  // A fee whose transfer is not in the file stays as an ordinary expense rather than pointing nowhere (D-121).
  const transferIds = new Set(transactions.filter((t) => t.type === 'transfer').map((t) => t.id))
  for (const t of transactions) if (t.feeOf && !transferIds.has(t.feeOf)) delete t.feeOf

  const settings = (raw.settings as unknown[]).map((s, i): Setting => {
    if (!isObj(s) || !isStr(s.key) || !('value' in s)) fail(`第 ${i + 1} 個設定不正確`)
    return { key: s.key, value: s.value }
  })

  // Salary data arrived with schema v2; older backups restore with the default items and no payslips.
  let salaryItems: SalaryItem[] = DEFAULT_SALARY_ITEMS.map((i) => ({ ...i }))
  let payslips: Payslip[] = []
  if (raw.schemaVersion >= 2) {
    if (!Array.isArray(raw.salaryItems) || !Array.isArray(raw.payslips)) fail('備份檔內容不完整')
    salaryItems = (raw.salaryItems as unknown[]).map((s, i): SalaryItem => {
      const n = i + 1
      if (!isObj(s) || !isStr(s.id) || !s.id) fail(`第 ${n} 個薪資項目缺少編號`)
      if (!isStr(s.name) || !s.name.trim()) fail(`第 ${n} 個薪資項目缺少名稱`)
      if (s.kind !== 'earning' && s.kind !== 'deduction') fail(`薪資項目「${s.name}」的應發／應扣不正確`)
      if (s.nature !== 'fixed' && s.nature !== 'variable') fail(`薪資項目「${s.name}」的固定／變動不正確`)
      if (typeof s.isActive !== 'boolean') fail(`薪資項目「${s.name}」缺少啟用狀態`)
      if (typeof s.sortOrder !== 'number' || !Number.isFinite(s.sortOrder)) fail(`薪資項目「${s.name}」缺少排序`)
      return { id: s.id, name: s.name, kind: s.kind as SalaryKind, nature: s.nature as SalaryNature, isActive: s.isActive, sortOrder: s.sortOrder }
    })
    checkUnique(salaryItems, '薪資項目')
    const itemIds = new Set(salaryItems.map((s) => s.id))
    const txIds = new Set(transactions.map((t) => t.id))
    payslips = (raw.payslips as unknown[]).map((p, i): Payslip => {
      const n = i + 1
      if (!isObj(p) || !isStr(p.id) || !p.id) fail(`第 ${n} 張薪資單缺少編號`)
      if (!isMonthKey(p.month)) fail(`第 ${n} 張薪資單的月份不正確`)
      if (!isStr(p.payDate) || !/^\d{4}-\d{2}-\d{2}$/.test(p.payDate) || toYmd(fromYmd(p.payDate)) !== p.payDate) fail(`第 ${n} 張薪資單的發薪日不正確`)
      if (!isStr(p.company)) fail(`第 ${n} 張薪資單的公司名稱不正確`)
      if (!isStr(p.paymentMethodId) || !payIds.has(p.paymentMethodId)) fail(`第 ${n} 張薪資單的入帳方式不存在`)
      if (!isIso(p.createdAt) || !isIso(p.updatedAt)) fail(`第 ${n} 張薪資單的時間不正確`)
      if (p.transactionId !== null && (!isStr(p.transactionId) || !txIds.has(p.transactionId))) fail(`第 ${n} 張薪資單的收入紀錄不存在`)
      if (!Array.isArray(p.lines)) fail(`第 ${n} 張薪資單缺少明細`)
      const seenItems = new Set<string>()
      const lines = (p.lines as unknown[]).map((l) => {
        if (!isObj(l) || !isStr(l.itemId) || !itemIds.has(l.itemId)) fail(`第 ${n} 張薪資單有不存在的薪資項目`)
        if (seenItems.has(l.itemId)) fail(`第 ${n} 張薪資單有重複的薪資項目`)
        seenItems.add(l.itemId)
        if (!isStr(l.name)) fail(`第 ${n} 張薪資單的項目名稱不正確`)
        const a = l.amount
        if (typeof a !== 'number' || !Number.isSafeInteger(a) || a < 0 || a > MAX_AMOUNT) fail(`第 ${n} 張薪資單的金額不正確`)
        return { itemId: l.itemId, name: l.name, amount: a }
      })
      return {
        id: p.id,
        month: p.month,
        payDate: p.payDate,
        company: p.company,
        paymentMethodId: p.paymentMethodId,
        lines,
        transactionId: p.transactionId as string | null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }
    })
    checkUnique(payslips, '薪資單')
    const seenMonths = new Set<string>()
    const seenTx = new Set<string>()
    const txById = new Map(transactions.map((t) => [t.id, t]))
    for (const p of payslips) {
      if (seenMonths.has(p.month)) fail(`備份檔中 ${p.month} 有兩張薪資單`)
      seenMonths.add(p.month)
      if (p.transactionId) {
        if (seenTx.has(p.transactionId)) fail(`備份檔中有兩張薪資單指向同一筆收入`)
        seenTx.add(p.transactionId)
        const t = txById.get(p.transactionId)!
        if (t.source !== 'payslip' || t.externalId !== p.id || t.type !== 'income') fail(`${p.month} 薪資單的收入紀錄不一致`)
      }
    }
  }

  const card = raw.schemaVersion >= 3 ? parseCardData(raw, new Set(transactions.map((t) => t.id)), new Set(paymentMethods.map((p) => p.id))) : emptyCard()
  const plans = raw.schemaVersion >= 4 ? parsePlanData(raw, catById, payIds) : { monthlyPlans: [], planTemplates: [], plannedExpenses: [] }
  const adjustments = raw.schemaVersion >= 5 ? parseAdjustments(raw, payIds) : []

  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    schemaVersion: raw.schemaVersion,
    exportedAt: raw.exportedAt,
    transactions,
    categories,
    paymentMethods,
    settings: settings.filter((s) => !DEVICE_SETTING_KEYS.has(s.key)),
    salaryItems,
    payslips,
    ...card,
    ...plans,
    adjustments,
  }
}

/** D-124: balance corrections; each must belong to an account in the same file. */
function parseAdjustments(raw: Record<string, unknown>, payIds: Set<string>): BalanceAdjustment[] {
  if (!Array.isArray(raw.adjustments)) fail('備份檔內容不完整')
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= MAX_AMOUNT
  const list = (raw.adjustments as unknown[]).map((o, i): BalanceAdjustment => {
    const what = `第 ${i + 1} 筆餘額調整`
    if (!isObj(o) || !isStr(o.id) || !o.id) fail(`${what}缺少編號`)
    if (!isStr(o.accountId) || !payIds.has(o.accountId)) fail(`${what}的帳戶不存在`)
    if (!isIso(o.occurredAt) || !isIso(o.createdAt)) fail(`${what}的時間不正確`)
    if (!isInt(o.before) || !isInt(o.after) || !isInt(o.delta) || o.after - o.before !== o.delta) fail(`${what}的金額不正確`)
    if (!isStr(o.note)) fail(`${what}的備註不正確`)
    return { id: o.id, accountId: o.accountId, occurredAt: o.occurredAt, before: o.before, after: o.after, delta: o.delta, note: o.note, createdAt: o.createdAt }
  })
  checkUnique(list, '餘額調整')
  return list
}

const isDay = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 31

/**
 * D-114: monthly planning. Links to transactions may point at a record that is not in the file:
 * they are kept and simply count as "not recorded" (D-108), like after a deletion.
 */
function parsePlanData(raw: Record<string, unknown>, catById: Map<string, Category>, payIds: Set<string>) {
  for (const k of ['monthlyPlans', 'planTemplates', 'plannedExpenses']) {
    if (!Array.isArray(raw[k])) fail('備份檔內容不完整')
  }
  const monthlyPlans = (raw.monthlyPlans as unknown[]).map((o, i): MonthlyPlan => {
    const n = i + 1
    if (!isObj(o) || !isMonthKey(o.month)) fail(`第 ${n} 個每月規劃的月份不正確`)
    if (!(o.income === null || isMoney0(o.income)) || !isMoney0(o.saving)) fail(`第 ${n} 個每月規劃的金額不正確`)
    if (!isIso(o.createdAt) || !isIso(o.updatedAt)) fail(`第 ${n} 個每月規劃的時間不正確`)
    return { month: o.month, income: o.income as number | null, saving: o.saving as number, createdAt: o.createdAt, updatedAt: o.updatedAt }
  })
  checkUnique(monthlyPlans.map((p) => ({ id: p.month })), '每月規劃')

  const fields = (o: Record<string, unknown>, what: string) => {
    if (!isStr(o.name) || !o.name.trim()) fail(`${what}缺少名稱`)
    if (!isValidAmount(o.amount)) fail(`${what}的金額不正確`)
    if (!isDay(o.day)) fail(`${what}的每月日期不正確`)
    if (!isStr(o.categoryId) || catById.get(o.categoryId)?.type !== 'expense') fail(`${what}的分類不存在`)
    if (!isStr(o.paymentMethodId) || !payIds.has(o.paymentMethodId)) fail(`${what}的付款方式不存在`)
    if (!isIso(o.createdAt) || !isIso(o.updatedAt)) fail(`${what}的時間不正確`)
    return { name: o.name, amount: o.amount as number, day: o.day as number, categoryId: o.categoryId, paymentMethodId: o.paymentMethodId, createdAt: o.createdAt, updatedAt: o.updatedAt }
  }

  const planTemplates = (raw.planTemplates as unknown[]).map((o, i): PlanTemplate => {
    const what = `第 ${i + 1} 個固定項目`
    if (!isObj(o) || !isStr(o.id) || !o.id) fail(`${what}缺少編號`)
    if (typeof o.isActive !== 'boolean') fail(`${what}的使用狀態不正確`)
    return { id: o.id, ...fields(o, what), isActive: o.isActive }
  })
  checkUnique(planTemplates, '固定項目')
  const tplIds = new Set(planTemplates.map((t) => t.id))

  const plannedExpenses = (raw.plannedExpenses as unknown[]).map((o, i): PlannedExpense => {
    const what = `第 ${i + 1} 筆必要支出`
    if (!isObj(o) || !isStr(o.id) || !o.id) fail(`${what}缺少編號`)
    if (!isMonthKey(o.month)) fail(`${what}的月份不正確`)
    if (!(o.templateId === null || (isStr(o.templateId) && tplIds.has(o.templateId)))) fail(`${what}的固定項目不存在`)
    if (o.status !== 'pending' && o.status !== 'skipped') fail(`${what}的狀態不正確`)
    if (!(o.transactionId === null || (isStr(o.transactionId) && o.transactionId))) fail(`${what}的記帳關聯不正確`)
    if (typeof o.edited !== 'boolean') fail(`${what}的內容不正確`)
    return {
      id: o.id,
      month: o.month,
      templateId: o.templateId as string | null,
      ...fields(o, what),
      status: o.status,
      transactionId: o.transactionId as string | null,
      edited: o.edited,
    }
  })
  checkUnique(plannedExpenses, '必要支出')
  checkUnique(
    plannedExpenses.filter((x) => x.templateId).map((x) => ({ id: `${x.month}|${x.templateId}` })),
    '同月份的固定項目',
  )
  return { monthlyPlans, planTemplates, plannedExpenses }
}

function emptyCard() {
  return { importedNotifications: [], importBatches: [], cardStatements: [], statementEntries: [], reconciliations: [] }
}

const isNullStr = (v: unknown): v is string | null => v === null || isStr(v)
const ENTRY_KINDS: EntryKind[] = ['purchase', 'refund', 'fee', 'installment', 'payment', 'adjustment', 'other']
const NOTIF_STATUS: NotificationStatus[] = ['imported', 'duplicate', 'skipped', 'not_spending', 'unparsed']

/** D-94: credit card data. Every link must point at something in the same file. */
function parseCardData(raw: Record<string, unknown>, txIds: Set<string>, payIds: Set<string>) {
  for (const k of ['importedNotifications', 'importBatches', 'cardStatements', 'statementEntries', 'reconciliations']) {
    if (!Array.isArray(raw[k])) fail('備份檔內容不完整')
  }
  const importBatches = (raw.importBatches as unknown[]).map((b, i): ImportBatch => {
    if (!isObj(b) || !isStr(b.id) || (b.kind !== 'notifications' && b.kind !== 'statement') || !isIso(b.createdAt)) fail(`第 ${i + 1} 個匯入批次不正確`)
    const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fail(`第 ${i + 1} 個匯入批次不正確`))
    return { id: b.id, kind: b.kind, createdAt: b.createdAt, files: num(b.files), imported: num(b.imported), duplicates: num(b.duplicates), skipped: num(b.skipped), failed: num(b.failed) }
  })
  checkUnique(importBatches, '匯入批次')

  const importedNotifications = (raw.importedNotifications as unknown[]).map((o, i): ImportedNotification => {
    const n = i + 1
    if (!isObj(o) || !isStr(o.id) || !isStr(o.captureId) || !o.captureId) fail(`第 ${n} 則刷卡通知缺少編號`)
    if (!isStr(o.sourceApp) || !isStr(o.sourceType) || !isStr(o.batchId) || !isIso(o.importedAt)) fail(`第 ${n} 則刷卡通知不正確`)
    if (!isNullStr(o.title) || !isNullStr(o.subtitle) || !isNullStr(o.body)) fail(`第 ${n} 則刷卡通知的內容不正確`)
    if ((o.notificationTime !== null && !isIso(o.notificationTime)) || (o.capturedAt !== null && !isIso(o.capturedAt))) fail(`第 ${n} 則刷卡通知的時間不正確`)
    if (!NOTIF_STATUS.includes(o.status as NotificationStatus)) fail(`第 ${n} 則刷卡通知的狀態不正確`)
    if (o.transactionId !== null && !isStr(o.transactionId)) fail(`第 ${n} 則刷卡通知的記帳連結不正確`)
    let parsed: ImportedNotification['parsed'] = null
    if (o.parsed !== null) {
      const p = o.parsed
      if (!isObj(p) || !isValidAmount(p.amount) || !isStr(p.merchant) || !isNullStr(p.cardLast4) || (p.occurredAt !== null && !isIso(p.occurredAt))) fail(`第 ${n} 則刷卡通知的解析結果不正確`)
      parsed = { amount: p.amount as number, merchant: p.merchant, occurredAt: p.occurredAt as string | null, cardLast4: p.cardLast4 }
    }
    return {
      id: o.id,
      captureId: o.captureId,
      sourceApp: o.sourceApp,
      sourceType: o.sourceType,
      title: o.title,
      subtitle: o.subtitle,
      body: o.body,
      notificationTime: o.notificationTime as string | null,
      capturedAt: o.capturedAt as string | null,
      status: o.status as NotificationStatus,
      parsed,
      // A link to a transaction that is not in this file is dropped, never kept dangling.
      transactionId: isStr(o.transactionId) && txIds.has(o.transactionId) ? o.transactionId : null,
      batchId: o.batchId,
      importedAt: o.importedAt,
    }
  })
  checkUnique(importedNotifications, '刷卡通知')
  const caps = new Set<string>()
  for (const n of importedNotifications) {
    if (caps.has(n.captureId)) fail('備份檔中有重複的刷卡通知')
    caps.add(n.captureId)
  }

  const cardStatements = (raw.cardStatements as unknown[]).map((s, i): CardStatement => {
    const n = i + 1
    if (!isObj(s) || !isStr(s.id) || !isStr(s.paymentMethodId) || !payIds.has(s.paymentMethodId)) fail(`第 ${n} 份帳單的信用卡不存在`)
    if (!isMonthKey(s.statementMonth)) fail(`第 ${n} 份帳單的月份不正確`)
    for (const k of ['periodStart', 'periodEnd', 'dueDate'] as const) if (s[k] !== null && !isYmdStr(s[k])) fail(`第 ${n} 份帳單的日期不正確`)
    if (!isStr(s.bank) || !isStr(s.fileHash) || !s.fileHash || !isStr(s.fileName) || !isStr(s.adapter) || !isStr(s.batchId)) fail(`第 ${n} 份帳單不正確`)
    if (s.parseStatus !== 'needs_review' && s.parseStatus !== 'confirmed') fail(`第 ${n} 份帳單的解析狀態不正確`)
    if (!isIso(s.createdAt) || !isIso(s.updatedAt)) fail(`第 ${n} 份帳單的時間不正確`)
    return {
      id: s.id,
      paymentMethodId: s.paymentMethodId,
      bank: s.bank,
      statementMonth: s.statementMonth,
      periodStart: s.periodStart as string | null,
      periodEnd: s.periodEnd as string | null,
      dueDate: s.dueDate as string | null,
      fileHash: s.fileHash,
      fileName: s.fileName,
      parseStatus: s.parseStatus,
      adapter: s.adapter,
      batchId: s.batchId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }
  })
  checkUnique(cardStatements, '帳單')
  const hashes = new Set<string>()
  for (const s of cardStatements) {
    if (hashes.has(s.fileHash)) fail('備份檔中有重複的帳單')
    hashes.add(s.fileHash)
  }
  const stIds = new Set(cardStatements.map((s) => s.id))

  const statementEntries = (raw.statementEntries as unknown[]).map((e, i): StatementEntry => {
    const n = i + 1
    if (!isObj(e) || !isStr(e.id) || !isStr(e.statementId) || !stIds.has(e.statementId)) fail(`第 ${n} 筆帳單明細沒有對應的帳單`)
    if ((e.txDate !== null && !isYmdStr(e.txDate)) || (e.postDate !== null && !isYmdStr(e.postDate)) || (!e.txDate && !e.postDate)) fail(`第 ${n} 筆帳單明細的日期不正確`)
    const a = e.amount
    if (typeof a !== 'number' || !Number.isSafeInteger(a) || a === 0 || Math.abs(a) > MAX_AMOUNT) fail(`第 ${n} 筆帳單明細的金額不正確`)
    if (!isStr(e.merchant) || !isStr(e.currency) || !isNullStr(e.foreign) || !isNullStr(e.reference) || !isStr(e.raw)) fail(`第 ${n} 筆帳單明細不正確`)
    if (!ENTRY_KINDS.includes(e.kind as EntryKind) || typeof e.order !== 'number') fail(`第 ${n} 筆帳單明細的類型不正確`)
    return {
      id: e.id,
      statementId: e.statementId,
      txDate: e.txDate as string | null,
      postDate: e.postDate as string | null,
      merchant: e.merchant,
      amount: a,
      currency: e.currency,
      foreign: e.foreign,
      reference: e.reference,
      kind: e.kind as EntryKind,
      raw: e.raw,
      order: e.order,
    }
  })
  checkUnique(statementEntries, '帳單明細')
  const entryStatement = new Map(statementEntries.map((e) => [e.id, e.statementId]))

  const reconciliations = (raw.reconciliations as unknown[]).flatMap((r, i): Reconciliation[] => {
    const n = i + 1
    if (!isObj(r) || !isStr(r.id) || !isStr(r.statementId) || !stIds.has(r.statementId)) fail(`第 ${n} 筆核對紀錄沒有對應的帳單`)
    if (r.status !== 'matched' && r.status !== 'deferred' && r.status !== 'explained') fail(`第 ${n} 筆核對紀錄的狀態不正確`)
    if (r.method !== 'auto' && r.method !== 'manual' && r.method !== 'created') fail(`第 ${n} 筆核對紀錄不正確`)
    if (r.entryId !== null && (!isStr(r.entryId) || entryStatement.get(r.entryId) !== r.statementId)) fail(`第 ${n} 筆核對紀錄的帳單明細不存在`)
    if (r.transactionId !== null && !isStr(r.transactionId)) fail(`第 ${n} 筆核對紀錄的記帳不正確`)
    // D-92: a pair whose record was deleted is kept on purpose (it shows as "需要確認"), so a backup
    // taken afterwards must restore. A note on a record that no longer exists is simply dropped.
    if (isStr(r.transactionId) && !txIds.has(r.transactionId) && r.status !== 'matched') return []
    if (r.status === 'matched' && (!r.entryId || !r.transactionId)) fail(`第 ${n} 筆核對紀錄缺少配對的一方`)
    if (!r.entryId && !r.transactionId) fail(`第 ${n} 筆核對紀錄是空的`)
    let snapshot: Reconciliation['snapshot'] = null
    if (r.snapshot !== null) {
      const s = r.snapshot
      if (!isObj(s) || typeof s.amount !== 'number' || !isYmdStr(s.date) || !isStr(s.paymentMethodId)) fail(`第 ${n} 筆核對紀錄不正確`)
      snapshot = { amount: s.amount, date: s.date, paymentMethodId: s.paymentMethodId }
    }
    if (!isStr(r.note) || !isIso(r.createdAt)) fail(`第 ${n} 筆核對紀錄不正確`)
    return [
      {
        id: r.id,
        statementId: r.statementId,
        entryId: r.entryId as string | null,
        transactionId: r.transactionId as string | null,
        status: r.status,
        method: r.method,
        snapshot,
        note: r.note,
        createdAt: r.createdAt,
      },
    ]
  })
  checkUnique(reconciliations, '核對紀錄')
  // One-to-one (D-90): no entry or transaction in two pairs.
  const pe = new Set<string>()
  const pt = new Set<string>()
  for (const r of reconciliations) {
    if (r.status !== 'matched') continue
    if (pe.has(r.entryId!) || pt.has(r.transactionId!)) fail('備份檔中有重複的核對配對')
    pe.add(r.entryId!)
    pt.add(r.transactionId!)
  }
  return { importedNotifications, importBatches, cardStatements, statementEntries, reconciliations }
}

/* ---------------- CSV (D-42) ---------------- */

/** D-124: 帳戶 and 轉入帳戶 are appended, so older spreadsheets keep working. */
export const CSV_HEADER = ['日期', '時間', '類型', '金額', '分類', '付款方式', '商家', '備註', '帳戶', '轉入帳戶']

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
        t.type === 'income' ? '收入' : t.type === 'transfer' ? '互轉' : '支出',
        String(t.amount),
        t.type === 'transfer' ? '' : names.category(t.categoryId),
        names.payment(t.paymentMethodId),
        t.merchant,
        t.note,
        // The account the money actually moved in: for 轉帳 / 行動支付 the account it left (D-120), or the
        // card it was charged to through a bound 行動支付 (D-125).
        names.payment(t.sourceAccountId ?? t.cardId ?? t.paymentMethodId),
        t.toAccountId ? names.payment(t.toAccountId) : '',
      ]
        .map(csvCell)
        .join(',')
    })
  // BOM so Excel opens UTF-8 Chinese correctly; CRLF line endings for spreadsheet apps.
  return '﻿' + [CSV_HEADER.join(','), ...rows].join('\r\n') + '\r\n'
}
