import { useMemo, useState, type RefObject } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useMonthsTx } from '../db/hooks'
import { addMonths, monthLabel, sameYm, type YearMonth } from '../lib/dates'
import { compact, fmt } from '../lib/money'
import { byCategory, filterMonth, monthOverMonth, summarize, trend, yearByMonth, yearTotals } from '../lib/stats'
import { Seg } from '../ui/Seg'
import { Icon } from '../ui/Icon'
import { MonthSwitch } from '../ui/MonthSwitch'
import { useRefData } from '../ui/refData'

/* Category colours (D-116): one tonal family derived from the brand cobalt, with amber as the second hue. */
const PALETTE = ['#0B3B8C', '#3D6FC4', '#86A6DA', '#E0901F', '#F2C67A', '#1E2E55', '#B4C4DA', '#DCE4F0', '#5B83C8', '#B0782A']

export function StatsScreen({
  active,
  scrollRef,
  month,
  onMonth,
  onCategory,
  onPayslips,
}: {
  onPayslips: () => void
  active: boolean
  scrollRef: RefObject<HTMLElement | null>
  month: YearMonth
  onMonth: (ym: YearMonth) => void
  onCategory: (categoryId: string) => void
}) {
  const ref = useRefData()
  const [mode, setMode] = useState<'month' | 'year'>('month')
  const [year, setYear] = useState(() => month.y)
  const tx = useMonthsTx(month, 6)
  const payslipCount = useLiveQuery(() => db.payslips.count(), [])

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
    // "比上月同期" depends on today's date, so recompute when the day changes.
  }, [tx, month, ref.categories, new Date().getDate()]) // eslint-disable-line react-hooks/exhaustive-deps

  const maxCat = v.exp[0]?.amount ?? 1
  const maxTrend = Math.max(1, ...v.trend.map((t) => t.expense))

  return (
    <section ref={scrollRef} className={'screen' + (active ? ' active' : '')} aria-label="統計" aria-hidden={!active} inert={!active}>
      <div className="title-row">
        <h1 className="large-title">統計</h1>
        <Seg
          label="統計範圍"
          className="stats-mode"
          options={MODE_OPTIONS}
          value={mode}
          onChange={(m) => {
            if (m === 'year') setYear(month.y)
            setMode(m)
          }}
        />
      </div>
      {mode === 'year' ? (
        <YearView
          year={year}
          onYear={setYear}
          onMonth={(ym) => {
            // Q65: a month in the yearly view opens that month's statistics.
            onMonth(ym)
            setMode('month')
            scrollRef.current?.scrollTo({ top: 0 })
          }}
        />
      ) : (
        <>
      <div className="stats-switch">
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

      {/* Always reachable, even in a month without salary income yet (D-73). */}
      <section className="panel">
        <button type="button" className="crow" onClick={onPayslips}>
          <span className="ico">
            <Icon name="receipt" />
          </span>
          <span className="crow-main">
            <span className="crow-top">
              <span className="crow-name">薪資單與項目歷史</span>
              <span className="crow-name">
                <small>{payslipCount ? `${payslipCount} 張` : '尚未建立'}</small>
              </span>
            </span>
          </span>
          <Icon name="chev" className="chev" />
        </button>
      </section>
        </>
      )}
    </section>
  )
}

const MODE_OPTIONS = [
  { value: 'month', label: '月度' },
  { value: 'year', label: '年度' },
] as const

/** D-104: real income and expense of one year; months that have not started show no numbers. */
function YearView({ year, onYear, onMonth }: { year: number; onYear: (y: number) => void; onMonth: (ym: YearMonth) => void }) {
  const tx = useMonthsTx({ y: year, m: 11 }, 12)
  const first = useLiveQuery(() => db.transactions.orderBy('occurredAt').first(), [])
  const now = new Date()
  const minYear = Math.min(now.getFullYear(), first ? new Date(first.occurredAt).getFullYear() : now.getFullYear())
  const months = useMemo(() => yearByMonth(tx ?? [], year), [tx, year, now.getMonth()]) // eslint-disable-line react-hooks/exhaustive-deps
  const t = yearTotals(months)
  const max = Math.max(1, ...months.map((m) => Math.max(m.income, m.expense)))

  return (
    <>
      <div className="stats-switch">
        <div className="month-sw" role="group" aria-label="年份">
          <button type="button" aria-label="前一年" disabled={year <= minYear} onClick={() => onYear(year - 1)}>
            <Icon name="left" />
          </button>
          <span className="m-label" aria-live="polite">{year}年</span>
          <button type="button" aria-label="後一年" disabled={year >= now.getFullYear()} onClick={() => onYear(year + 1)}>
            <Icon name="right" />
          </button>
        </div>
      </div>
      <div className="trio big" style={{ marginTop: 14 }}>
        <div>
          <span className="lbl">全年收入</span>
          <span className="v num pos">{fmt(t.income)}</span>
        </div>
        <div>
          <span className="lbl">全年支出</span>
          <span className="v num">{fmt(t.expense)}</span>
        </div>
        <div>
          <span className="lbl">全年結餘</span>
          <span className={'v num' + (t.balance < 0 ? ' neg' : '')}>{fmt(t.balance)}</span>
        </div>
      </div>
      <p className="delta">只算已記帳的實際收支，不含每月規劃的預估。</p>

      <section className="panel">
        <h2>
          每月收支<span>點月份看當月</span>
        </h2>
        <div className="ylegend" aria-hidden="true">
          <span>
            <i className="in" />
            收入
          </span>
          <span>
            <i className="out" />
            支出
          </span>
        </div>
        <div className="ybars">
          {months.map((m, i) =>
            m.future ? (
              <span key={m.ym.m} className="ycol future" aria-label={`${m.ym.m + 1}月尚未到`}>
                <span className="ypair" />
                <span className="ym">{m.ym.m + 1}</span>
              </span>
            ) : (
              <button
                type="button"
                key={m.ym.m}
                className="ycol"
                aria-label={`${m.ym.m + 1}月 收入 ${fmt(m.income)} 元，支出 ${fmt(m.expense)} 元`}
                onClick={() => onMonth(m.ym)}
              >
                <span className="ypair">
                  <i className="in" style={{ height: `${((m.income / max) * 100).toFixed(1)}%`, animationDelay: `${i * 18}ms` }} />
                  <i className="out" style={{ height: `${((m.expense / max) * 100).toFixed(1)}%`, animationDelay: `${i * 18}ms` }} />
                </span>
                <span className="ym">{m.ym.m + 1}</span>
              </button>
            ),
          )}
        </div>
      </section>

      <section className="panel ytable">
        <div className="yhead" aria-hidden="true">
          <span>月份</span>
          <span>收入</span>
          <span>支出</span>
          <span>結餘</span>
        </div>
        {months.map((m) =>
          m.future ? (
            <div key={m.ym.m} className="yrow future">
              <span>{m.ym.m + 1} 月</span>
              <span>—</span>
              <span>—</span>
              <span>—</span>
            </div>
          ) : (
            <button type="button" key={m.ym.m} className="yrow" onClick={() => onMonth(m.ym)}>
              <span>{m.ym.m + 1} 月</span>
              <span className="num">{fmt(m.income)}</span>
              <span className="num">{fmt(m.expense)}</span>
              <span className={'num' + (m.balance < 0 ? ' neg' : '')}>
                {m.balance < 0 ? '−' : ''}
                {fmt(Math.abs(m.balance))}
              </span>
            </button>
          ),
        )}
      </section>
    </>
  )
}
