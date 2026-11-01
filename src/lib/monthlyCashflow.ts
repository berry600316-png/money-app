import type { BalanceAdjustment, PaymentMethod, Transaction } from '../db/types'
import { isInMonth, type YearMonth } from './dates'
import { effectsOf, isAsset, isCard } from './accounts'
import { summarize } from './stats'

export interface MonthlyMovement {
  id: string
  name: string
  income: number
  expense: number
  transfer: number
  /** Transaction movement; corrections are displayed separately. On cards, positive means more 預扣. */
  movement: number
  adjustment: number
  transactionIds: string[]
}

const row = (id: string, name: string): MonthlyMovement => ({ id, name, income: 0, expense: 0, transfer: 0, movement: 0, adjustment: 0, transactionIds: [] })

/** The selected month's activity, independent of opening balances and activity in later months. */
export function monthlyCashflow(
  month: YearMonth,
  methods: readonly PaymentMethod[],
  transactions: readonly Transaction[],
  adjustments: readonly BalanceAdjustment[],
) {
  const byId = new Map(methods.map((m) => [m.id, m]))
  const rows = new Map<string, MonthlyMovement>()
  const get = (id: string) => {
    let result = rows.get(id)
    if (!result) {
      result = row(id, byId.get(id)?.name ?? '已刪除的帳戶')
      rows.set(id, result)
    }
    return result
  }
  const unknown = row('', '未指定帳戶')
  const inMonth = transactions.filter((t) => isInMonth(t.occurredAt, month))
  for (const t of inMonth) {
    let assigned = false
    for (const effect of effectsOf(t, (id) => byId.get(id))) {
      const method = byId.get(effect.accountId)
      if (!isAsset(method) && !isCard(method)) continue
      assigned = true
      const target = get(effect.accountId)
      target[t.type] += effect.delta
      target.movement += effect.delta
      if (!target.transactionIds.includes(t.id)) target.transactionIds.push(t.id)
    }
    if (!assigned && t.type !== 'transfer') {
      const delta = t.type === 'income' ? t.amount : -t.amount
      unknown[t.type] += delta
      unknown.movement += delta
      unknown.transactionIds.push(t.id)
    }
  }
  for (const adjustment of adjustments) {
    if (isInMonth(adjustment.occurredAt, month)) get(adjustment.accountId).adjustment += adjustment.delta
  }
  const sorted = [...rows.values()].sort((a, b) => (byId.get(a.id)?.sortOrder ?? 0) - (byId.get(b.id)?.sortOrder ?? 0))
  return {
    totals: summarize(inMonth),
    accounts: sorted.filter((r) => isAsset(byId.get(r.id))),
    cards: sorted.filter((r) => isCard(byId.get(r.id))),
    unassigned: unknown,
  }
}
