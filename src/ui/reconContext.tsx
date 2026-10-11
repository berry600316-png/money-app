import { useLiveQuery } from 'dexie-react-hooks'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { db } from '../db/db'
import type { Reconciliation, Transaction } from '../db/types'
import { toYmd } from '../lib/dates'

type Snap = NonNullable<Reconciliation['snapshot']>
const Ctx = createContext<Map<string, Snap>>(new Map())

/** Transactions paired with a statement entry, with the values they were paired at (D-92, D-93). */
export function ReconProvider({ children }: { children: ReactNode }) {
  const recons = useLiveQuery(() => db.reconciliations.toArray(), [])
  const map = useMemo(() => {
    const m = new Map<string, Snap>()
    for (const r of recons ?? []) if (r.status === 'matched' && r.transactionId && r.entryId && r.snapshot) m.set(r.transactionId, r.snapshot)
    return m
  }, [recons])
  return <Ctx.Provider value={map}>{children}</Ctx.Provider>
}

/** True only while the pair still matches the record as it is now; no mark otherwise (no statement ≠ problem). */
export function useIsReconciled(tx: Transaction): boolean {
  const s = useContext(Ctx).get(tx.id)
  return !!s && s.amount === tx.amount && s.paymentMethodId === tx.paymentMethodId && s.date === toYmd(new Date(tx.occurredAt))
}
