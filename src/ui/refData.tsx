import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Category, PaymentMethod } from '../db/types'

export interface RefData {
  categories: Category[]
  payments: PaymentMethod[]
  category: (id: string) => Category
  payment: (id: string) => PaymentMethod
}

const MISSING_CATEGORY: Category = { id: '', name: '未分類', type: 'expense', icon: 'other', isActive: false, sortOrder: 999 }
const MISSING_PAYMENT: PaymentMethod = { id: '', name: '未指定', type: 'other', isActive: false, sortOrder: 999 }

const Ctx = createContext<RefData | null>(null)

export function RefDataProvider({ categories, payments, children }: { categories: Category[]; payments: PaymentMethod[]; children: ReactNode }) {
  const value = useMemo<RefData>(() => {
    const cm = new Map(categories.map((c) => [c.id, c]))
    const pm = new Map(payments.map((p) => [p.id, p]))
    return {
      categories,
      payments,
      category: (id) => cm.get(id) ?? MISSING_CATEGORY,
      payment: (id) => pm.get(id) ?? MISSING_PAYMENT,
    }
  }, [categories, payments])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRefData(): RefData {
  const v = useContext(Ctx)
  if (!v) throw new Error('RefDataProvider missing')
  return v
}
