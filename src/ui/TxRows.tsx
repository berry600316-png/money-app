import { PAYSLIP_SOURCE } from '../db/defaults'
import type { Transaction } from '../db/types'
import { describePay, isCard } from '../lib/accounts'
import { dayLabel, timeLabel } from '../lib/dates'
import { fmt } from '../lib/money'
import { groupByDay } from '../lib/stats'
import { Icon } from './Icon'
import { useIsReconciled } from './reconContext'
import { useRefData } from './refData'

/** `showTime`: the day panel (D-115) lists one day, so the time leads the second line. */
export function TxRow({ tx, onOpen, showTime = false }: { tx: Transaction; onOpen: (id: string) => void; showTime?: boolean }) {
  const { category, payment, payments } = useRefData()
  const reconciled = useIsReconciled(tx)
  const time = showTime ? timeLabel(new Date(tx.occurredAt)) : ''

  // D-117: a transfer reads "from → to", has no sign and is never counted as income or expense.
  if (tx.type === 'transfer') {
    const to = payment(tx.toAccountId ?? '')
    const sub = [time, isCard(to) ? '繳卡費' : '互轉', tx.note].filter(Boolean).join(' · ')
    return (
      <button type="button" className="row" onClick={() => onOpen(tx.id)}>
        <span className="row-main">
          <span className="row-title">
            {payment(tx.paymentMethodId).name} → {to.name}
          </span>
          <span className="row-sub">{sub}</span>
        </span>
        <span className="row-amt num transfer">
          <span className="sr">互轉，不算收支</span>
          {fmt(tx.amount)}
        </span>
      </button>
    )
  }

  const c = category(tx.categoryId)
  // D-120 / D-125: the way to pay, with the account it draws on: "信用卡（台新 Richart）".
  const how = tx.type === 'expense' ? describePay(tx, (id) => payments.find((p) => p.id === id)) : null
  const pay = how ? how.name + (how.account ? `（${how.account}）` : '') : payment(tx.paymentMethodId).name
  const sub = [time, c.name, pay, tx.note].filter(Boolean).join(' · ')
  const income = tx.type === 'income'
  return (
    <button type="button" className="row" onClick={() => onOpen(tx.id)}>
      <span className="row-main">
        <span className="row-title">
          {tx.merchant || c.name}
          {tx.source === PAYSLIP_SOURCE && <span className="tag tag-brand">薪資單</span>}
          {reconciled && (
            <span className="tx-ok" aria-label="已和銀行帳單核對">
              <Icon name="check" />
            </span>
          )}
        </span>
        <span className="row-sub">{sub}</span>
      </span>
      <span className={'row-amt num ' + tx.type}>
        <span className="sr">{income ? '收入' : '支出'}</span>
        {income ? '+' : '−'}
        {fmt(tx.amount)}
      </span>
    </button>
  )
}

/** Day-grouped list. `list` must already be sorted newest first. */
export function TxGroups({ list, onOpen }: { list: readonly Transaction[]; onOpen: (id: string) => void }) {
  return (
    <>
      {groupByDay(list).map((g) => (
        <section className="group" key={g.ymd}>
          <div className="group-head">
            <span>{dayLabel(g.date)}</span>
            <span>
              {g.expense > 0 && (
                <>
                  支出 <span className="num">{fmt(g.expense)}</span>
                </>
              )}
              {g.expense > 0 && g.income > 0 && '　'}
              {g.income > 0 && (
                <>
                  收入 <span className="num">{fmt(g.income)}</span>
                </>
              )}
            </span>
          </div>
          <div className="card">
            {g.items.map((t) => (
              <TxRow key={t.id} tx={t} onOpen={onOpen} />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
