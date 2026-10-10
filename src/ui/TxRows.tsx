import type { Transaction } from '../db/types'
import { dayLabel } from '../lib/dates'
import { fmt } from '../lib/money'
import { groupByDay } from '../lib/stats'
import { Icon } from './Icon'
import { useRefData } from './refData'

export function TxRow({ tx, onOpen }: { tx: Transaction; onOpen: (id: string) => void }) {
  const { category, payment } = useRefData()
  const c = category(tx.categoryId)
  const sub = [c.name, payment(tx.paymentMethodId).name, tx.note].filter(Boolean).join(' · ')
  const income = tx.type === 'income'
  return (
    <button type="button" className="row" onClick={() => onOpen(tx.id)}>
      <span className="ico">
        <Icon name={c.icon} />
      </span>
      <span className="row-main">
        <span className="row-title">{tx.merchant || c.name}</span>
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
