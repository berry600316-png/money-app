import type { Category, PaymentMethod } from './types'

/** D-10. Ids are stable so backups from any install line up. */
export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'food', name: '餐飲', type: 'expense', icon: 'food', isActive: true, sortOrder: 0 },
  { id: 'transport', name: '交通', type: 'expense', icon: 'transport', isActive: true, sortOrder: 1 },
  { id: 'daily', name: '日常', type: 'expense', icon: 'daily', isActive: true, sortOrder: 2 },
  { id: 'shopping', name: '購物', type: 'expense', icon: 'shopping', isActive: true, sortOrder: 3 },
  { id: 'fun', name: '娛樂', type: 'expense', icon: 'fun', isActive: true, sortOrder: 4 },
  { id: 'home', name: '居家', type: 'expense', icon: 'home', isActive: true, sortOrder: 5 },
  { id: 'medical', name: '醫療', type: 'expense', icon: 'medical', isActive: true, sortOrder: 6 },
  { id: 'other', name: '其他', type: 'expense', icon: 'other', isActive: true, sortOrder: 7 },
  { id: 'salary', name: '薪資', type: 'income', icon: 'salary', isActive: true, sortOrder: 0 },
  { id: 'bonus', name: '獎金', type: 'income', icon: 'bonus', isActive: true, sortOrder: 1 },
  { id: 'other_income', name: '其他收入', type: 'income', icon: 'plusCircle', isActive: true, sortOrder: 2 },
]

/** D-13 */
export const DEFAULT_PAYMENT_METHODS: PaymentMethod[] = [
  { id: 'cash', name: '現金', type: 'cash', isActive: true, sortOrder: 0 },
  { id: 'card', name: '信用卡', type: 'credit_card', isActive: true, sortOrder: 1 },
  { id: 'easycard', name: '悠遊卡', type: 'stored_value', isActive: true, sortOrder: 2 },
  { id: 'mobile', name: '行動支付', type: 'mobile', isActive: true, sortOrder: 3 },
  { id: 'transfer', name: '轉帳', type: 'transfer', isActive: true, sortOrder: 4 },
]

/** D-20: fixed default category per type. */
export const DEFAULT_CATEGORY_ID = { expense: 'food', income: 'salary' } as const
export const DEFAULT_PAYMENT_METHOD_ID = 'card'
