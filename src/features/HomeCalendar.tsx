import { useMemo } from 'react'
import { addMonths, sameYm, ymOf, type YearMonth } from '../lib/dates'
import { calendarMonth, type CalDay } from '../lib/calendar'
import { fmt } from '../lib/money'
import type { Transaction } from '../db/types'
import { Icon } from '../ui/Icon'

const WEEK = '日一二三四五六'

/** D-115: shade = how much was spent that day; tap a day to show it below. */
export function HomeCalendar({
  ym,
  onYm,
  list,
  selected,
  onSelect,
}: {
  ym: YearMonth
  onYm: (ym: YearMonth) => void
  /** That month's transactions. */
  list: readonly Transaction[]
  selected: string
  onSelect: (ymd: string) => void
}) {
  const now = new Date()
  const cal = useMemo(() => calendarMonth(list, ym, now), [list, ym.y, ym.m, now.getDate()]) // eslint-disable-line react-hooks/exhaustive-deps
  const isCurrent = sameYm(ym, ymOf(now))

  const cell = (d: CalDay) => {
    const dow = (cal.lead + d.day - 1) % 7
    const label = `${ym.m + 1}月${d.day}日 週${WEEK[dow]}` + (d.future ? '，還沒到' : `，支出 ${fmt(d.expense)} 元${d.income ? '，有收入' : ''}`)
    return (
      <button
        type="button"
        key={d.ymd}
        className={'cday' + (d.today ? ' today' : '') + (d.ymd === selected ? ' sel' : '') + (d.future ? ' future' : '') + (d.heat > 0.55 ? ' dark' : '')}
        disabled={d.future}
        aria-pressed={d.ymd === selected}
        aria-label={label}
        onClick={() => onSelect(d.ymd)}
      >
        <i className="tint" style={{ opacity: d.heat ? (0.12 + d.heat * 0.78).toFixed(2) : 0 }} aria-hidden="true" />
        <span className="d">{d.day}</span>
        {d.income > 0 && <i className="inc" aria-hidden="true" />}
      </button>
    )
  }

  return (
    <section className="hcal" aria-label="月曆">
      <div className="hcal-head">
        <div className="hcal-sw">
          <button type="button" aria-label="上個月" onClick={() => onYm(addMonths(ym, -1))}>
            <Icon name="left" />
          </button>
          <h2 aria-live="polite">
            {ym.y === now.getFullYear() ? '' : `${ym.y}年`}
            {ym.m + 1}月
          </h2>
          <button type="button" aria-label="下個月" disabled={isCurrent} onClick={() => onYm(addMonths(ym, 1))}>
            <Icon name="right" />
          </button>
        </div>
        <span className="hcal-avg">
          日均 <b className="num">{fmt(cal.avg)}</b>
        </span>
      </div>
      <div className="hcal-wk" aria-hidden="true">
        {[...WEEK].map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="hcal-grid">
        {Array.from({ length: cal.lead }, (_, i) => (
          <span key={'pad' + i} className="cday pad" aria-hidden="true" />
        ))}
        {cal.days.map(cell)}
        {Array.from({ length: (7 - ((cal.lead + cal.days.length) % 7)) % 7 }, (_, i) => (
          <span key={'tail' + i} className="cday pad" aria-hidden="true" />
        ))}
      </div>
      <div className="hcal-legend" aria-hidden="true">
        少<i style={{ opacity: 0.15 }} />
        <i style={{ opacity: 0.45 }} />
        <i style={{ opacity: 0.9 }} />多
      </div>
    </section>
  )
}
