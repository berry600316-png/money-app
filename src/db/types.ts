/** Income and expense: the two kinds that count in totals and have categories. */
export type CategoryType = 'expense' | 'income'
/** D-117: 'transfer' (互轉) moves money between the user's own accounts; never income or expense. */
export type TxType = CategoryType | 'transfer'

/** Fields follow spec 0.8, plus the account links of D-117. Timestamps are UTC ISO 8601 strings. */
export interface Transaction {
  id: string
  type: TxType
  /** Positive integer NTD. */
  amount: number
  merchant: string
  /** '' for transfers (they have no category). */
  categoryId: string
  /**
   * The account or payment method: where an expense was paid from, where income went, or the
   * transfer's source account (D-117).
   */
  paymentMethodId: string
  /** Transfers only: the account the money went to (a credit card here = paying its bill, D-119). */
  toAccountId?: string
  /** Expenses paid with 轉帳 / 行動支付 / 其他: the account the money actually left (D-120, D-125). */
  sourceAccountId?: string
  /**
   * D-125 / D-132: expenses paid with a 行動支付 / 其他: the card actually used. A credit card: the spending
   * waits as its 預扣 (and shows on its bill). A debit card: the money leaves its bank account at once.
   * Set when recorded; a later binding change keeps it.
   */
  cardId?: string
  /** A transfer's fee, recorded as its own expense: the transfer it belongs to (D-121). */
  feeOf?: string
  occurredAt: string
  note: string
  /** 'manual' for entries typed in the app; reserved for future imports. */
  source: string
  /** Reserved for de-duplicating future imports. */
  externalId: string | null
  createdAt: string
  updatedAt: string
  /**
   * D-100: how sure the time is. Absent = exact (typed by the user, or printed in a notification).
   * 'notification' = when the notification arrived; 'date' = only the date is known (time stored as 12:00).
   */
  timeSource?: TimeSource
}

export type TimeSource = 'notification' | 'date'

export interface Category {
  id: string
  name: string
  type: CategoryType
  /** Kept for backups and older versions; not shown since D-122. */
  icon: string
  isActive: boolean
  /** Display order within its type (decisions.md, 資料模型補充). */
  sortOrder: number
}

export type PaymentType = 'bank' | 'cash' | 'credit_card' | 'debit_card' | 'stored_value' | 'mobile' | 'transfer' | 'other'

/**
 * D-117 / D-125: one list for accounts and payment methods. bank / cash / stored_value are accounts that
 * hold money. The rest are ways to pay that belong to an account: a credit card belongs to its bank (its
 * spending waits there as 預扣 until the bill is paid); a 行動支付 / 其他 is bound to a card or an account;
 * 轉帳 is offered under every bank account; a debit card (D-129) belongs to a bank and takes money from it at once.
 */
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
  /**
   * D-118: the instant (UTC ISO) from which records count, with `openingBalance` the balance at that
   * instant (a card: 預扣 still unpaid). "Today's balance" starts at the moment it was entered, so records
   * already reflected in it are never counted twice; an earlier date starts at that day's local
   * midnight. Both absent = "尚未設定餘額": nothing is counted.
   */
  balanceFrom?: string
  openingBalance?: number
  /**
   * Credit cards (D-119, D-125): the bank account it belongs to; its 預扣 shows there and its bill is paid
   * from it. Debit cards (D-129): the bank account it takes money from at once.
   */
  payFromId?: string
  /**
   * 行動支付 / 其他 only (D-132): the cards it holds (credit or debit), e.g. Apple Pay with 台新信用卡 and
   * 台新金融卡. Paying with it uses one of them (the one used last time, unless changed). Empty / absent =
   * holds no card yet (counts in no account).
   */
  cards?: string[]
  /**
   * D-140 / Q136 B: a card deleted together with its bank keeps that bank's id, so restoring the bank
   * restores the card too. Absent for anything deleted on its own (or in use).
   */
  deletedWith?: string
}

/** D-118: a correction of one account's balance; never income, expense or a transfer. */
export interface BalanceAdjustment {
  id: string
  accountId: string
  occurredAt: string
  /** The computed balance before, the real one after, and after − before. */
  before: number
  after: number
  delta: number
  note: string
  createdAt: string
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
  /** D-141: the user's note for this item this month ("10/3、10/12 加班"), up to 50 characters. */
  note?: string
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
  /** D-100: absent = exact. */
  timeSource?: TimeSource
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
  /**
   * D-131: a fingerprint of the content, so a second notification arriving with the same captureId but
   * different text is caught instead of silently skipped. Absent on records from before it existed.
   */
  fingerprint?: string
  /** D-130: the payment source was shown to the user, who imported it (a default is a preference, not proof). */
  sourceConfirmed?: boolean
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
  bank: '銀行',
  cash: '現金',
  stored_value: '儲值',
  credit_card: '信用卡',
  debit_card: '金融卡',
  mobile: '行動支付',
  transfer: '轉帳',
  other: '其他',
}

/** Accounts that hold money (D-117). */
export const isAssetType = (t: PaymentType) => t === 'bank' || t === 'cash' || t === 'stored_value'
/** Ways to pay that are not themselves an account; an expense asks where the money left (D-120). */
export const isMethodType = (t: PaymentType) => t === 'mobile' || t === 'transfer' || t === 'other' || t === 'debit_card'

/* ---------------- monthly planning (D-105..D-112) ---------------- */

/** One month's plan. Never a transaction: only numbers for the estimate. */
export interface MonthlyPlan {
  /** "YYYY-MM", primary key. */
  month: string
  /** A: estimated total income of the month; null until the user sets it (D-110). */
  income: number | null
  /** D: amount set aside for saving (estimate only). */
  saving: number
  createdAt: string
  updatedAt: string
}

/** A fixed monthly expense the plans are built from (D-107). */
export interface PlanTemplate {
  id: string
  name: string
  amount: number
  /** 1–31 (clamped to the month's last day, D-111). */
  day: number
  categoryId: string
  paymentMethodId: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/**
 * One month's planned expense: a snapshot, so later template changes never rewrite past months.
 * Recorded = `transactionId` points at an expense of the same month (checked live, D-108).
 */
export interface PlannedExpense {
  id: string
  month: string
  /** null for an expense added for this month only. */
  templateId: string | null
  name: string
  amount: number
  day: number
  categoryId: string
  paymentMethodId: string
  status: 'pending' | 'skipped'
  transactionId: string | null
  /** Changed by hand for this month: no longer follows its template (D-107). */
  edited: boolean
  createdAt: string
  updatedAt: string
}
