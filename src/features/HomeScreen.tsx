import { useMemo, type RefObject } from 'react'
import { useMonthTx, useRecentTx } from '../db/hooks'
import { daysInMonth, sameLocalDay, ymOf } from '../lib/dates'
import { fmt } from '../lib/money'
import { dailyExpense, summarize } from '../lib/stats'
import { Icon } from '../ui/Icon'
import { TxGroups } from '../ui/TxRows'

export function HomeScreen({
  active,
  scrollRef,
  onOpenTx,
  onAdd,
  onSeeAll,
  onSettings,
}: {
  active: boolean
  scrollRef: RefObject<HTMLElement | null>
  onOpenTx: (id: string) => void
  onAdd: () => void
  onSeeAll: () => void
  onSettings: () => void
}) {
  const now = new Date()
  const ym = ymOf(now)
  const monthTx = useMonthTx(ym)
  const recent = useRecentTx(8)

  const view = useMemo(() => {
    const list = monthTx ?? []
    const s = summarize(list)
    const today = summarize(list.filter((t) => sameLocalDay(new Date(t.occurredAt), now))).expense
    const per = dailyExpense(list, ym)
    const td = now.getDate()
    // Scale bars to the 85th percentile so one big purchase doesn't flatten the month.
    const past = per.slice(0, td).sort((a, b) => a - b)
    const cap = Math.max(200, (past[Math.floor((past.length - 1) * 0.85)] ?? 0) * 1.25)
    return { ...s, today, per, td, cap, avg: td ? Math.round(s.expense / td) : 0 }
    // `now` changes every render; only the calendar day it represents matters.
  }, [monthTx, ym.y, ym.m, now.getDate()]) // eslint-disable-line react-hooks/exhaustive-deps

  const dim = daysInMonth(ym)

  return (
    <section ref={scrollRef} className={'screen' + (active ? ' active' : '')} aria-label="首頁" aria-hidden={!active} inert={!active}>
      <header className="home-head">
        <span className="home-date">
          {ym.y} 年 {ym.m + 1} 月
        </span>
        <button type="button" className="icon-btn" aria-label="設定" onClick={onSettings}>
          <Icon name="gear" />
        </button>
      </header>

      <section className="hero">
        <div className="eyebrow">本月支出</div>
        <div className="hero-amt num">
          <span className="cur">NT$</span>
          <span>{fmt(view.expense)}</span>
        </div>
        <dl className="trio">
          <div>
            <dt>今天</dt>
            <dd className="num">{fmt(view.today)}</dd>
          </div>
          <div>
            <dt>收入</dt>
            <dd className="num pos">{fmt(view.income)}</dd>
          </div>
          <div>
            <dt>結餘</dt>
            <dd className={'num' + (view.balance < 0 ? ' neg' : '')}>{fmt(view.balance)}</dd>
          </div>
        </dl>
      </section>

      <section className="daily">
        <div className="bars" role="img" aria-label={`本月每日支出，日均 ${fmt(view.avg)} 元`}>
          {view.per.map((v, i) => {
            if (i + 1 > view.td) return <i key={i} className="bar future" style={{ height: 2 }} />
            const h = v === 0 ? 2 : Math.max(4, Math.min(1, v / view.cap) * 100) + '%'
            return (
              <i
                key={i}
                className={'bar' + (i + 1 === view.td ? ' today' : '') + (v === 0 ? ' zero' : '')}
                style={{ height: h, animationDelay: `${i * 12}ms` }}
              />
            )
          })}
        </div>
        <div className="daily-foot">
          <span>
            {ym.m + 1}/1
          </span>
          <span>
            日均 <b>NT$ {fmt(view.avg)}</b>
          </span>
          <span>
            {ym.m + 1}/{dim}
          </span>
        </div>
      </section>

      <div className="sec-head">
        <h2>最近紀錄</h2>
        {recent && recent.length > 0 && (
          <button type="button" className="link" onClick={onSeeAll}>
            全部明細
          </button>
        )}
      </div>
      {recent && recent.length > 0 && <TxGroups list={recent} onOpen={onOpenTx} />}
      {recent && recent.length === 0 && (
        <div className="empty">
          <strong>還沒有任何紀錄</strong>點右下的 ＋ 記下第一筆。
          <br />
          <button type="button" className="btn-soft" onClick={onAdd}>
            記一筆
          </button>
        </div>
      )}
    </section>
  )
}
