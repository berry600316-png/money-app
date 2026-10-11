export type TxType = 'expense' | 'income'

/** Fields follow spec 0.8 exactly. Timestamps are UTC ISO 8601 strings. */
export interface Transaction {
  id: string
  type: TxType
  /** Positive integer NTD. */
  amount: number
  merchant: string
  categoryId: string
  paymentMethodId: string
  occurredAt: string
  note: string
  /** 'manual' for entries typed in the app; reserved for future imports. */
  source: string
  /** Reserved for de-duplicating future imports. */
  externalId: string | null
  createdAt: string
  updatedAt: string
}

export interface Category {
  id: string
  name: string
  type: TxType
  icon: string
  isActive: boolean
  /** Display order within its type (decisions.md, 資料模型補充). */
  sortOrder: number
}

export type PaymentType = 'cash' | 'credit_card' | 'stored_value' | 'mobile' | 'transfer' | 'other'

export interface PaymentMethod {
  id: string
  name: string
  type: PaymentType
  isActive: boolean
  sortOrder: number
  /** Credit cards only (D-80): issuing bank, e.g. "台新". */
  bank?: string
  /** Credit cards only (D-80): last four digits, used to match notifications and statements. */
  cardLast4?: string
}

export interface Setting {
  key: string
  value: unknown
}

/* ---------------- salary (D-60..D-75) ---------------- */

export type SalaryKind = 'earning' | 'deduction'
export type SalaryNature = 'fixed' | 'variable'

export interface SalaryItem {
  /** Stable id; history is linked by id, never by name (spec §7). */
  id: string
  name: string
  kind: SalaryKind
  nature: SalaryNature
  isActive: boolean
  sortOrder: number
}

export interface PayslipLine {
  itemId: string
  /** Item name at the time this payslip was saved (D-69). */
  name: string
  /** Integer NTD, 0 or more; deductions are positive too (D-66). */
  amount: number
}

export interface Payslip {
  id: string
  /** "YYYY-MM" the salary belongs to; one payslip per month (D-61). */
  month: string
  /** "YYYY-MM-DD" local date the money arrived; date of the linked income (D-62). */
  payDate: string
  company: string
  paymentMethodId: string
  lines: PayslipLine[]
  /** The income transaction created from this payslip; null when net pay ≤ 0 (D-64). */
  transactionId: string | null
  createdAt: string
  updatedAt: string
}

/* ---------------- credit card module (D-80..D-95) ---------------- */

export interface ParsedSpend {
  /** Integer NTD. */
  amount: number
  merchant: string
  /** ISO time of the purchase if the notification states it. */
  occurredAt: string | null
  cardLast4: string | null
}

export type NotificationStatus = 'imported' | 'duplicate' | 'skipped' | 'not_spending' | 'unparsed'

/** One captured notification and what happened to it on import (dedupe by captureId, D-83). */
export interface ImportedNotification {
  id: string
  captureId: string
  sourceApp: string
  sourceType: string
  title: string | null
  subtitle: string | null
  body: string | null
  notificationTime: string | null
  capturedAt: string | null
  status: NotificationStatus
  parsed: ParsedSpend | null
  transactionId: string | null
  batchId: string
  importedAt: string
}

export interface ImportBatch {
  id: string
  kind: 'notifications' | 'statement'
  createdAt: string
  files: number
  imported: number
  duplicates: number
  skipped: number
  failed: number
}

export type EntryKind = 'purchase' | 'refund' | 'fee' | 'installment' | 'payment' | 'adjustment' | 'other'

export interface CardStatement {
  id: string
  paymentMethodId: string
  bank: string
  /** "YYYY-MM" the statement is for. */
  statementMonth: string
  /** Billing cycle (local dates); null until known (D-91). */
  periodStart: string | null
  periodEnd: string | null
  dueDate: string | null
  /** SHA-256 of the PDF; the PDF itself is not kept (Q60, D-88). */
  fileHash: string
  fileName: string
  /** D-87: generic parsing is "needs_review" until the user confirms it. */
  parseStatus: 'needs_review' | 'confirmed'
  adapter: string
  batchId: string
  createdAt: string
  updatedAt: string
}

export interface StatementEntry {
  id: string
  statementId: string
  /** Purchase date as printed ("YYYY-MM-DD"). */
  txDate: string | null
  /** Posting date as printed, if any. Never confused with txDate or the statement month. */
  postDate: string | null
  merchant: string
  /** Integer NTD; negative for credits (refunds, payments). */
  amount: number
  currency: string
  /** Original foreign amount text, if printed. */
  foreign: string | null
  reference: string | null
  kind: EntryKind
  /** Original text line, kept for review. */
  raw: string
  order: number
}

export type ReconStatus = 'matched' | 'deferred' | 'explained'

/** A decision in reconciliation: a pair (matched) or a note on one side (deferred / explained). */
export interface Reconciliation {
  id: string
  statementId: string
  entryId: string | null
  transactionId: string | null
  status: ReconStatus
  method: 'auto' | 'manual' | 'created'
  /** Transaction values when the pair was made; any later change invalidates it (D-92). */
  snapshot: { amount: number; date: string; paymentMethodId: string } | null
  note: string
  createdAt: string
}

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  cash: '現金',
  credit_card: '信用卡',
  stored_value: '電子票證',
  mobile: '行動支付',
  transfer: '轉帳',
  other: '其他',
}
