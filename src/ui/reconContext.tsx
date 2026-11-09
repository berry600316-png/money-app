import { useLiveQuery } from 'dexie-react-hooks'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { db } from '../db/db'
import type { Reconciliation, Transaction } from '../db/types'
import { chargedTo } from '../lib/accounts'
import { toYmd } from '../lib/dates'
import { Icon } from './Icon'

type Snap = NonNullable<Reconciliation['snapshot']>
const Ctx = createContext<Map<string, Snap>>(new Map())

/** Transactions paired with a statement entry, with the values they were paired at (D-92, D-93). */
export function ReconProvider({ children }: { children: ReactNode }) {
  const recons = useLiveQuery(() => db.reconciliations.toArray(), [])
  const map = useMemo(() => {
    const m = new Map<string, Snap>()
    for (const r of recons ?? []) if ((r.status === 'matched' || r.status === 'explained') && r.transactionId && r.snapshot) m.set(r.transactionId, r.snapshot)
    return m
  }, [recons])
  return <Ctx.Provider value={map}>{children}</Ctx.Provider>
}

/** True only while the pair still matches the record as it is now; no mark otherwise (no statement ≠ problem). */
export function useIsReconciled(tx: Transaction): boolean {
  const s = useContext(Ctx).get(tx.id)
  // D-125: compared with the card charged, so a 行動支付 bound to the card shows its mark too.
  return !!s && s.amount === tx.amount && s.paymentMethodId === chargedTo(tx) && s.date === toYmd(new Date(tx.occurredAt))
    && (!('sourceAccountId' in s) || s.sourceAccountId === tx.sourceAccountId)
    && (!('cardId' in s) || s.cardId === tx.cardId)
    && (!('toAccountId' in s) || s.toAccountId === tx.toAccountId)
}

/** Reuse the same mark in account flows and ordinary transaction lists. */
export function ReconCheck({ tx }: { tx: Transaction }) {
  return useIsReconciled(tx) ? <span className="tx-ok" aria-label="已和銀行帳單核對"><Icon name="check" /></span> : null
}
