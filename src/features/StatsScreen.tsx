import { useMemo, type RefObject } from 'react'
import { useMonthsTx } from '../db/hooks'
import { addMonths, monthLabel, sameYm, type YearMonth } from '../lib/dates'
import { compact, fmt } from '../lib/money'
import { byCategory, filterMonth, monthOverMonth, summarize, trend } from '../lib/stats'
import { Icon } from '../ui/Icon'
import { MonthSwitch } from '../ui/MonthSwitch'
import { useRefData } from '../ui/refData'

/* Category colours: one tonal family derived from the brand green and a warm sand. */
const PALETTE = ['#284E43', '#5A8475', '#93B1A4', '#B49C70', '#D6C8A8', '#5F665A', '#B7C2BB', '#D9DCD5', '#7C9A8C', '#A88F63']

export function StatsScreen({
  active,
  scrollRef,
  month,
  onMonth,
  onCategory,
}: {
  active: boolean
  scrollRef: RefObject<HTMLElement | null>
  month: YearMonth
  onMonth: (ym: YearMonth) => void
  onCategory: (categoryId: string) => void
}) {
  const ref = useRefData()
  const tx = useMonthsTx(month, 6)

  const v = useMemo(() => {
    const all = tx ?? []
    const cur = filterMonth(all, month)
    const prev = filterMonth(all, addMonths(month, -1))
    const s = summarize(cur)
    const exp = byCategory(cur, 'expense')
    // Colour follows the category's place in the settings order, so it stays stable month to month.
    const order = ref.categories.filter((c) => c.type === 'expense').map((c) => c.id)
    const color = (id: string) => {
      const i = order.indexOf(id)
      return PALETTE[(i < 0 ? order.length : i) % PALETTE.length]
    }
    return {
      s,
      mom: monthOverMonth(cur, prev, month),
      exp: exp.map((e) => ({ ...e, color: color(e.categoryId) })),
      inc: byCategory(cur, 'income'),
      trend: trend(all, month, 6),
    }
  }, [tx, month, ref.categories])

  const maxCat = v.exp[0]?.amount ?? 1
  const maxTrend = Math.max(1, ...v.trend.map((t) => t.expense))

  return (
    <section ref={scrollRef} className={'screen' + (active ? ' active' : '')} aria-label="統計" aria-hidden={!active} inert={!active}>
      <div className="title-row">
        <h1 className="large-title">統計</h1>
        <MonthSwitch value={month} onChange={onMonth} />
      </div>

      <div className="trio big" style={{ marginTop: 14 }}>
        <div>
          <span className="lbl">支出</span>
          <span className="v num">{fmt(v.s.expense)}</span>
        </div>
        <div>
          <span className="lbl">收入</span>
          <span className="v num pos">{fmt(v.s.income)}</span>
        </div>
        <div>
          <span className="lbl">結餘</span>
          <span className={'v num' + (v.s.balance < 0 ? ' neg' : '')}>{fmt(v.s.balance)}</span>
        </div>
      </div>
      {v.mom && (
        <div className="delta">
          {v.mom.sameRange ? '比上月同期' : '比上月'}
          {v.mom.pct === 0 ? (
            <b>持平</b>
          ) : (
            <>
              {v.mom.pct < 0 ? '少 ' : '多 '}
              <b>{Math.abs(v.mom.pct)}%</b>
            </>
          )}
          （上月{v.mom.sameRange ? '同期' : ''} NT$ {fmt(v.mom.previous)}）
        </div>
      )}

      {v.exp.length > 0 ? (
        <section className="panel">
          <h2>
            支出分類<span>點分類看明細</span>
          </h2>
          <div className="stack" aria-hidden="true">
            {v.exp.map((e, i) => (
              <i key={e.categoryId} style={{ flex: e.amount, background: e.color, animationDelay: `${i * 40}ms` }} />
            ))}
          </div>
          {v.exp.map((e, i) => {
            const c = ref.category(e.categoryId)
            const pct = Math.round((e.amount / v.s.expense) * 100)
            return (
              <button type="button" className="crow" key={e.categoryId} onClick={() => onCategory(e.categoryId)}>
                <span className="ico">
                  <Icon name={c.icon} />
                </span>
                <span className="crow-main">
                  <span className="crow-top">
                    <span className="crow-name">
                      {c.name}
                      <small>{pct < 1 ? '<1' : pct}%</small>
                    </span>
                    <span className="crow-amt num">{fmt(e.amount)}</span>
                  </span>
                  <span className="crow-bar">
                    <i style={{ width: `${((e.amount / maxCat) * 100).toFixed(1)}%`, background: e.color, animationDelay: `${i * 40}ms` }} />
                  </span>
                </span>
                <Icon name="chev" className="chev" />
              </button>
            )
          })}
        </section>
      ) : (
        <div className="empty">
          <strong>{monthLabel(month)}沒有支出</strong>有支出紀錄後，這裡會顯示各分類的比例。
        </div>
      )}

      {v.inc.length > 0 && (
        <section className="panel">
          <h2>收入來源</h2>
          {v.inc.map((e) => {
            const c = ref.category(e.categoryId)
            return (
              <button type="button" className="crow" key={e.categoryId} onClick={() => onCategory(e.categoryId)}>
                <span className="ico">
                  <Icon name={c.icon} />
                </span>
                <span className="crow-main">
                  <span className="crow-top">
                    <span className="crow-name">{c.name}</span>
                    <span className="crow-amt num">{fmt(e.amount)}</span>
                  </span>
                </span>
                <Icon name="chev" className="chev" />
              </button>
            )
          })}
        </section>
      )}

      <section className="panel">
        <h2>
          近六個月支出<span>點月份切換</span>
        </h2>
        <div className="trend">
          {v.trend.map((t, i) => {
            const cur = sameYm(t.ym, month)
            return (
              <button
                type="button"
                key={`${t.ym.y}-${t.ym.m}`}
                className={'tcol' + (cur ? ' cur' : '')}
                aria-label={`${t.ym.m + 1}月支出 ${fmt(t.expense)} 元`}
                aria-pressed={cur}
                onClick={() => onMonth(t.ym)}
              >
                <span className="tv num">{t.expense ? compact(t.expense) : '—'}</span>
                <span className="tb" style={{ height: `${Math.max(2, (t.expense / maxTrend) * 78).toFixed(1)}%`, animationDelay: `${i * 40}ms` }} />
                <span className="tm">{t.ym.m + 1}月</span>
              </button>
            )
          })}
        </div>
      </section>
    </section>
  )
}
