import { useEffect, useMemo, useRef, useState } from 'react'
import { usePayslips, useSalaryItems } from '../../db/hooks'
import { fmt } from '../../lib/money'
import { addMonthKey, currentMonthKey, monthKeyLabel, monthShort } from '../../lib/months'
import { cellFor, deltaOf, indexPayslips, latestValue, periodMonths, periodStats, previousValue, type Cell, type RangeOption } from '../../lib/salaryHistory'
import { Icon } from '../../ui/Icon'
import { Seg } from '../../ui/Seg'

const RANGE_OPTIONS = [
  { value: '3', label: '3 個月' },
  { value: '6', label: '6 個月' },
  { value: '12', label: '12 個月' },
  { value: 'custom', label: '自訂' },
] as const

function signed(n: number) {
  return n === 0 ? '0' : (n > 0 ? '+' : '−') + fmt(Math.abs(n))
}

/** Spec §2–§8: one history view shared by every salary item. */
export function ItemHistoryPage({ itemId, onBack, backLabel }: { itemId: string; onBack: () => void; backLabel: string }) {
  const slips = usePayslips()
  const items = useSalaryItems()
  const [range, setRange] = useState<RangeOption>('6') // D-72 default
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const view = useMemo(() => {
    if (!slips) return null
    const idx = indexPayslips(slips)
    const end = idx.months[idx.months.length - 1] ?? currentMonthKey()
    const customRange = custom ?? { from: periodMonths('6', idx)[0], to: end }
    const months = periodMonths(range, idx, customRange)
    const cells = months.map((m) => cellFor(itemId, m, idx))
    const latest = latestValue(itemId, idx)
    const delta = latest ? deltaOf(latest.amount, previousValue(itemId, latest.month, idx)) : null
    const rows = [...cells].reverse().map((c) => ({
      c,
      delta: c.state === 'value' ? deltaOf(c.amount, previousValue(itemId, c.month, idx)) : null,
    }))
    return { idx, months, cells, stats: periodStats(cells), latest, delta, rows, customRange, firstMonth: idx.months[0] ?? end, end }
  }, [slips, itemId, range, custom])

  // Long custom ranges scroll sideways; always start at the most recent month.
  const monthsKey = view?.months.join(',')
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [monthsKey])

  const item = items?.find((i) => i.id === itemId)
  const head = (
    <div className="page-head">
      <button type="button" className="back" onClick={onBack}>
        <Icon name="left" />
        {backLabel}
      </button>
      <h1>項目歷史</h1>
      <span />
    </div>
  )
  if (!view || !items) return head
  const { cells, stats, latest, delta, rows, customRange } = view
  const sel = selected && view.months.includes(selected) ? cells.find((c) => c.month === selected)! : null
  const pickText = (c: Cell) =>
    c.state === 'value' ? (
      <>
        {monthKeyLabel(c.month)}　<b>NT${fmt(c.amount)}</b>
      </>
    ) : (
      <>
        {monthKeyLabel(c.month)}　{c.state === 'gap' ? '尚無薪資單' : '尚未有此項目'}
      </>
    )

  return (
    <>
      {head}
      <div className="h-title">
        <h2>{item?.name ?? '已刪除的項目'}</h2>
        {item && (
          <span className="tag">
            {item.kind === 'earning' ? '應發' : '應扣'} · {item.nature === 'fixed' ? '固定' : '變動'}
            {!item.isActive && ' · 已停用'}
          </span>
        )}
      </div>

      {latest ? (
        <div className="h-latest">
          <div className="eyebrow">{monthKeyLabel(latest.month)}</div>
          <div className="hero-amt num">
            <span className="cur">NT$</span>
            <span>{fmt(latest.amount)}</span>
          </div>
          <div className="h-delta">
            {!delta ? (
              '這是第一筆紀錄'
            ) : delta.diff === 0 ? (
              <>較 {monthShort(delta.prevMonth)}持平</>
            ) : (
              <>
                較 {monthShort(delta.prevMonth)}
                {delta.diff > 0 ? '增加' : '減少'} <b>NT${fmt(Math.abs(delta.diff))}</b>
                {delta.pct !== null && `（${delta.pct > 0 ? '+' : '−'}${Math.abs(delta.pct).toFixed(1)}%）`}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="h-latest">
          <div className="h-delta">還沒有任何紀錄</div>
        </div>
      )}

      <Seg
        className="h-seg"
        label="期間"
        options={RANGE_OPTIONS}
        value={range}
        onChange={(v) => {
          setRange(v)
          setSelected(null)
          if (v === 'custom' && !custom) setCustom(customRange)
        }}
      />
      {range === 'custom' && (
        <div className="custom-range">
          <label className="sr" htmlFor="hist-from">
            開始月份
          </label>
          <input
            id="hist-from"
            type="month"
            value={customRange.from}
            min={view.firstMonth}
            max={customRange.to}
            onChange={(e) => e.target.value && setCustom({ ...customRange, from: e.target.value < view.firstMonth ? view.firstMonth : e.target.value })}
          />
          <span>到</span>
          <label className="sr" htmlFor="hist-to">
            結束月份
          </label>
          <input
            id="hist-to"
            type="month"
            value={customRange.to}
            min={customRange.from}
            max={view.end}
            onChange={(e) => e.target.value && setCustom({ ...customRange, to: e.target.value > view.end ? view.end : e.target.value })}
          />
        </div>
      )}

      <div className="chart-wrap">
        <div className="chart-pick" aria-live="polite">
          {sel ? pickText(sel) : '點直條看當月金額'}
        </div>
        <div className="chart-scroll" ref={scrollRef}>
          <div className={'chart' + (cells.length > 6 ? ' dense' : '')} role="group" aria-label={`${item?.name ?? ''}每月金額`}>
            {cells.map((c, i) => {
              let inner
              if (c.state === 'gap') inner = <span className="gapbox">無</span>
              else if (c.state === 'before') inner = <span className="before">—</span>
              else if (c.amount === 0) inner = <span className="hbar zero" />
              else
                inner = (
                  <span
                    className="hbar"
                    style={{ height: `${Math.max(3, (c.amount / Math.max(1, stats.max)) * 100).toFixed(1)}%`, animationDelay: `${i * 30}ms` }}
                  />
                )
              const showLabel = cells.length <= 6 || i % 2 === cells.length % 2 || c.month === selected
              const aria =
                monthKeyLabel(c.month) + (c.state === 'value' ? ` ${fmt(c.amount)} 元` : c.state === 'gap' ? ' 尚無薪資單' : ' 尚未有此項目')
              return (
                <button
                  type="button"
                  key={c.month}
                  className={'bcol' + (c.month === selected ? ' sel' : '')}
                  aria-label={aria}
                  aria-pressed={c.month === selected}
                  onClick={() => setSelected(c.month === selected ? null : c.month)}
                >
                  <span className="bbox">{inner}</span>
                  <span className="bm">{showLabel ? `${Number(c.month.slice(5))}月` : ' '}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="h-stats">
        <div>
          <span className="lbl">期間累計</span>
          <span className="v num">{fmt(stats.total)}</span>
        </div>
        <div>
          <span className="lbl">{stats.counted ? `${stats.counted} 個月平均` : '月平均'}</span>
          <span className="v num">{stats.average === null ? '—' : fmt(stats.average)}</span>
        </div>
      </div>
      {stats.gaps > 0 && <p className="set-foot">期間內有 {stats.gaps} 個月尚無薪資單，不列入累計與平均。</p>}

      <div className="sec-head">
        <h2>逐月紀錄</h2>
        <span className="eyebrow">較上次</span>
      </div>
      <div className="card">
        {rows.map(({ c, delta: d }) => {
          const m = `${c.month.slice(0, 4)}/${c.month.slice(5)}`
          if (c.state !== 'value')
            return (
              <div className="mrow empty" key={c.month}>
                <span className="m num">{m}</span>
                <span className="a">{c.state === 'gap' ? '尚無薪資單' : '—'}</span>
                <span className="dl" />
              </div>
            )
          return (
            <div className="mrow" key={c.month}>
              <span className="m num">{m}</span>
              <span className="a">{fmt(c.amount)}</span>
              <span className="dl">{d ? signed(d.diff) : '—'}</span>
              {/* D-70: name the month compared with when it isn't the month right before. */}
              {((d && d.prevMonth !== addMonthKey(c.month, -1)) || (c.name && item && c.name !== item.name)) && (
                <span className="was">
                  {d && d.prevMonth !== addMonthKey(c.month, -1) && `較 ${monthShort(d.prevMonth)}`}
                  {d && d.prevMonth !== addMonthKey(c.month, -1) && c.name && item && c.name !== item.name && '・'}
                  {c.name && item && c.name !== item.name && `當時：${c.name}`}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
