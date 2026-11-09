import type { Reconciliation, Transaction } from '../db/types'
import { chargedTo } from '../lib/accounts'
import { toYmd } from '../lib/dates'

export const txDate = (t: Transaction) => toYmd(new Date(t.occurredAt))

/** Is a saved decision still true to the transaction as it is now? */
export function pairStillValid(recon: Reconciliation, tx: Transaction | undefined): string | null {
  if (!tx) return '這筆記帳已被刪除'
  const s = recon.snapshot
  if (!s) return null
  if (s.amount !== tx.amount) return '記帳金額在核對後被修改'
  if (s.date !== txDate(tx)) return '記帳日期在核對後被修改'
  if (s.paymentMethodId !== chargedTo(tx)) return '記帳的付款方式在核對後被修改'
  if ('sourceAccountId' in s && s.sourceAccountId !== tx.sourceAccountId) return '記帳的扣款帳戶在核對後被修改'
  if ('cardId' in s && s.cardId !== tx.cardId) return '記帳的卡片在核對後被修改'
  if ('toAccountId' in s && s.toAccountId !== tx.toAccountId) return '記帳的轉入帳戶在核對後被修改'
  return null
}
