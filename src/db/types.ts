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

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  cash: '現金',
  credit_card: '信用卡',
  stored_value: '電子票證',
  mobile: '行動支付',
  transfer: '轉帳',
  other: '其他',
}
