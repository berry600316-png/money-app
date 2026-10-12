import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useMonthTx } from '../db/hooks'
import { dayLabel, fromYmd, sameLocalDay, sameYm, toYmd, ymOf, type YearMonth } from '../lib/dates'
import { fmt } from '../lib/money'
import { sortDesc, summarize } from '../lib/stats'
import { useToday } from '../lib/useToday'
import { Icon } from '../ui/Icon'
import { TxRow } from '../ui/TxRows'
import { BackupBanner } from './BackupBanner'
import { HomeCalendar } from './HomeCalendar'
import { HomePlanCard } from './plan/HomePlanCard'

const WEEK = '日一二三四五六'

/** D-116: a numbered rule between the home screen's sections (decoration only). */
function SecRule({ n, label }: { n: string; label: string }) {
  return (
    <div className="sec-rule" aria-hidden="true">
      <b>{n}</b>
      {label}
      <i />
    </div>
  )
}

/** The day a month opens on: today in the current month, else that month's last day. */
function defaultDay(ym: YearMonth, today: string): string {
  const t = fromYmd(today)
  return sameYm(ym, ymOf(t)) ? today : toYmd(new Date(ym.y, ym.m + 1, 0))
}

export function HomeScreen({
  active,
  scrollRef,
  onOpenTx,
  onAddOn,
  onSeeDay,
  onSettings,
  onBackup,
  onPlan,
}: {
  onBackup: () => void
  /** D-113: the month plan, under the month overview. */
  onPlan: () => void
  active: boolean
  scrollRef: RefObject<HTMLElement | null>
  onOpenTx: (id: string) => void
  /** D-115: a new entry on this day ("YYYY-MM-DD"). */
  onAddOn: (ymd: string) => void
  /** D-115: the list, filtered to this day. */
  onSeeDay: (ymd: string) => void
  onSettings: () => void
}) {
  const today = useToday()
  const now = new Date()
  const ym = ymOf(now)
  const monthTx = useMonthTx(ym)

  // The overview always describes the current month (D-115: the calendar may show another one).
  const view = useMemo(() => {
    const list = monthTx ?? []
    const s = summarize(list)
    const todayOut = summarize(list.filter((t) => sameLocalDay(new Date(t.occurredAt), now))).expense
    return { ...s, today: todayOut }
    // `now` changes every render; only the calendar day it represents matters.
  }, [monthTx, today]) // eslint-disable-line react-hooks/exhaustive-deps

  const [calYm, setCalYm] = useState<YearMonth>(ym)
  const [selected, setSelected] = useState(today)
  const calTx = useMonthTx(calYm)

  // Past midnight: a calendar left on "today" follows to the new day (and month). Any other choice
  // stays exactly where it is, month included, so the list below always matches the calendar.
  const shownToday = useRef(today)
  useEffect(() => {
    const prev = shownToday.current
    shownToday.current = today
    if (prev === today || selected !== prev) return
    setSelected(today)
    setCalYm(ymOf(fromYmd(today)))
    // Only when the date changes; `selected` is read as it is at that moment.
  }, [today]) // eslint-disable-line react-hooks/exhaustive-deps

  const changeMonth = (next: YearMonth) => {
    setCalYm(next)
    setSelected(defaultDay(next, today))
  }

  const dayList = useMemo(() => sortDesc((calTx ?? []).filter((t) => toYmd(new Date(t.occurredAt)) === selected)), [calTx, selected])
  const dayTotals = summarize(dayList)
  const selDate = fromYmd(selected)
  const isToday = selected === today
  const title = dayLabel(selDate, { short: true })

  return (
    <section ref={scrollRef} className={'screen' + (active ? ' active' : '')} aria-label="首頁" aria-hidden={!active} inert={!active}>
      {/* D-116: the header and the month overview sit on the blue band. */}
      <div className="home-top">
        <header className="home-head">
          <span className="home-date">
            <small>Cai Jie</small>
            {ym.y} 年 {ym.m + 1} 月
          </span>
          <button type="button" className="icon-btn" aria-label="設定" onClick={onSettings}>
            <Icon name="gear" />
          </button>
        </header>
        <BackupBanner onBackup={onBackup} />

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
      </div>

      <SecRule n="01" label="PLAN" />
      <HomePlanCard onOpen={onPlan} />

      <SecRule n="02" label="CALENDAR" />
      <HomeCalendar ym={calYm} onYm={changeMonth} list={calTx ?? []} selected={selected} onSelect={setSelected} />

      <SecRule n="03" label="RECORDS" />
      <section className="dayp" aria-label={`${title}的紀錄`}>
        <div className="dayp-head">
          <div className="dayp-title">
            <h2>
              {title}
              <span>週{WEEK[selDate.getDay()]}</span>
            </h2>
            <div className="dayp-tot" aria-live="polite">
              <span>
                支出 <b className="num">{fmt(dayTotals.expense)}</b>
              </span>
              <span>
                收入 <b className={'num' + (dayTotals.income ? ' pos' : '')}>{fmt(dayTotals.income)}</b>
              </span>
              <span>{dayList.length} 筆</span>
            </div>
          </div>
          <button type="button" className="add-day" onClick={() => onAddOn(selected)}>
            <Icon name="plus" />
            {isToday ? '記一筆' : '這天'}
          </button>
        </div>
        {dayList.length > 0 ? (
          <div className="card day-card" key={selected}>
            {dayList.map((t) => (
              <TxRow key={t.id} tx={t} onOpen={onOpenTx} showTime />
            ))}
          </div>
        ) : (
          <div className="card day-card" key={selected}>
            <div className="empty-day">
              <strong>{isToday ? '今天還沒有紀錄' : '這天沒有紀錄'}</strong>
              {isToday ? '點「記一筆」或右下的＋記下今天的收支。' : `按「＋ 這天」補記，日期會設成 ${selDate.getMonth() + 1}月${selDate.getDate()}日。`}
            </div>
          </div>
        )}
        <button type="button" className="more-link" onClick={() => onSeeDay(selected)}>
          在明細看這天 ›
        </button>
      </section>
    </section>
  )
}
