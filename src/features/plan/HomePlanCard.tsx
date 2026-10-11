import { usePlanSummary } from '../../db/hooks'
import { currentMonthKey } from '../../lib/months'
import { fmt } from '../../lib/money'
import { AnimatedNumber } from '../../ui/AnimatedNumber'

/** D-113: the home screen's "本月規劃" summary, under the month overview. */
export function HomePlanCard({ onOpen }: { onOpen: () => void }) {
  const month = currentMonthKey()
  const s = usePlanSummary(month)
  if (!s) return <div className="plan-card ph" aria-hidden="true" />
  const m = Number(month.slice(5))

  if (!s.started || s.summary.spendable === null) {
    return (
      <div className="plan-card" role="group" aria-label="本月規劃">
        <div className="pc-top">
          <span className="eyebrow">本月規劃</span>
        </div>
        <div className="plan-empty">
          <p>{s.started ? '先設定本月預估收入，看看還能花多少。' : '先設定本月收入與必要支出，看看還能花多少。'}</p>
          <button type="button" className="pill-btn" onClick={onOpen}>
            {s.started ? '設定收入' : '開始規劃'}
          </button>
        </div>
      </div>
    )
  }

  const p = s.summary
  const over = (p.spendable ?? 0) < 0
  return (
    <button type="button" className="plan-card" onClick={onOpen}>
      <span className="pc-top">
        <span className="eyebrow">本月規劃</span>
        <span>預估 · {m} 月</span>
      </span>
      <span className={'pc-amt' + (over ? ' over' : '')}>
        <span className="cur">NT$</span>
        <AnimatedNumber value={p.spendable ?? 0} className="num" />
        <span className="cap">{over ? '已超出可運用金額' : '達成存錢目標還可花'}</span>
      </span>
      <span className="pc-meta">
        <span>
          必要支出 <b className="num">{fmt(p.recorded)}</b> / {fmt(p.necessary)}
        </span>
        <span>{p.pendingCount ? <><b>{p.pendingCount}</b> 筆待記帳</> : p.items.length ? '全部已記帳' : '沒有必要支出'}</span>
      </span>
      <span className="track" aria-hidden="true">
        <i style={{ transform: `scaleX(${p.necessary ? Math.min(1, p.recorded / p.necessary) : 0})` }} />
      </span>
    </button>
  )
}
