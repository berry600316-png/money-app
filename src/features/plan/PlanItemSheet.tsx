import { useState } from 'react'
import { useMonthTx } from '../../db/hooks'
import { linkPlannedExpense, removeOneOffExpense, skipPlannedExpense, unlinkPlannedExpense, unskipPlannedExpense } from '../../db/planRepo'
import { MoneyError } from '../../db/repo'
import { dayLabel, timeLabel } from '../../lib/dates'
import { fmt } from '../../lib/money'
import { linkCandidates, planDayLabel, type PlanItemView } from '../../lib/plan'
import { BottomSheet } from '../../ui/BottomSheet'
import { Icon } from '../../ui/Icon'
import { Overlay } from '../../ui/overlay'
import { useToast } from '../../ui/Toast'

/** D-109: one planned expense: record it, link an existing entry, change this month, or skip. */
export function PlanItemSheet({
  view,
  month,
  onClose,
  onRecord,
  onEditTx,
  onEdit,
  catName,
  payName,
  taken,
}: {
  /** Transactions already backing another item of this month (Q73). */
  taken: ReadonlySet<string>
  view: PlanItemView | null
  month: string
  onClose: () => void
  onRecord: (v: PlanItemView) => void
  onEditTx: (txId: string) => void
  onEdit: (v: PlanItemView) => void
  catName: (id: string) => string
  payName: (id: string) => string
}) {
  const toast = useToast()
  const [mode, setMode] = useState<'main' | 'link'>('main')
  const [pick, setPick] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<PlanItemView | null>(null)
  if (view && view !== last) {
    // New item opened (or the same one re-rendered after a write): reset the local view state once.
    if (!last || last.item.id !== view.item.id) {
      setMode('main')
      setPick(null)
    }
    setLast(view)
  }
  const v = view ?? last
  const [y, m] = month.split('-').map(Number)
  const monthTx = useMonthTx({ y, m: m - 1 })

  const run = async (f: () => Promise<unknown>, done: string, close = true) => {
    if (busy) return
    setBusy(true)
    try {
      await f()
      toast(done)
      if (close) onClose()
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '沒有成功，請再試一次', { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const link = v && monthTx ? linkCandidates(v.item, monthTx, taken) : null

  return (
    <Overlay>
      <BottomSheet
        open={view !== null}
        onClose={onClose}
        labelledBy="plan-item-title"
        head={
          <div className="sheet-bar">
            {mode === 'link' ? (
              <button type="button" className="txt-btn" onClick={() => setMode('main')}>
                返回
              </button>
            ) : (
              <span />
            )}
            <h2 id="plan-item-title">{mode === 'link' ? '關聯既有記帳' : v?.item.name}</h2>
            <button type="button" className="txt-btn strong" onClick={onClose}>
              完成
            </button>
          </div>
        }
      >
        {v && mode === 'main' && (
          <div className="it-body">
            <div className="it-hero">
              <p className="s">
                {planDayLabel(v.item)} · {catName(v.item.categoryId)} · {payName(v.item.paymentMethodId)} ·{' '}
                {v.state === 'linked' ? '已記帳' : v.state === 'skipped' ? '本月略過' : '待記帳'}
              </p>
              <span className={'num big' + (v.state === 'skipped' ? ' muted' : '')}>NT$ {fmt(v.state === 'linked' ? v.value : v.item.amount)}</span>
              {v.state === 'pending' && <p className="s">{m} 月預估</p>}
              {v.broken && (
                <p className="warn-inline s">
                  {v.broken.kind === 'deleted'
                    ? '原本對應的記帳已刪除，請重新記錄或對應。'
                    : v.broken.kind === 'moved'
                      ? `原本對應的記帳日期已改到 ${Number(v.broken.month.slice(5))} 月，不算在這個月。`
                      : '原本對應的記帳已改成收入，不算在必要支出。'}
                </p>
              )}
            </div>

            {v.state === 'linked' && v.tx && (
              <>
                <div className="cmp-grid">
                  <div>
                    <small>預估</small>
                    <b className="num">{fmt(v.item.amount)}</b>
                  </div>
                  <div>
                    <small>實際</small>
                    <b className="num">{fmt(v.tx.amount)}</b>
                  </div>
                  <div>
                    <small>差額</small>
                    <b className={'num' + (v.diff && v.diff > 0 ? ' neg' : '')}>
                      {!v.diff ? '0' : `${v.diff > 0 ? '+' : '−'}${fmt(Math.abs(v.diff))}`}
                    </b>
                  </div>
                </div>
                <button type="button" className="row linked-tx" onClick={() => onEditTx(v.tx!.id)}>
                  <span className="row-main">
                    <span className="row-title">{v.tx.merchant || catName(v.tx.categoryId)}</span>
                    <span className="row-sub">
                      {dayLabel(new Date(v.tx.occurredAt), { short: true })} {timeLabel(new Date(v.tx.occurredAt))} · {payName(v.tx.paymentMethodId)}
                    </span>
                  </span>
                  <span className="row-amt num">−{fmt(v.tx.amount)}</span>
                  <Icon name="chev" className="chev" />
                </button>
                <p className="note">試算用實際金額 {fmt(v.tx.amount)}，不會再另外扣預估的 {fmt(v.item.amount)}。</p>
                <div className="acts">
                  <button type="button" className="btn-sec" disabled={busy} onClick={() => run(() => unlinkPlannedExpense(v.item.id), '已取消對應，記帳保留')}>
                    取消對應（記帳本身保留）
                  </button>
                </div>
              </>
            )}

            {v.state === 'skipped' && (
              <>
                <p className="note center">這個月不會發生，不計入必要支出。</p>
                <div className="acts">
                  <button type="button" className="btn-sec" disabled={busy} onClick={() => run(() => unskipPlannedExpense(v.item.id), '已恢復這個月的規劃')}>
                    恢復這個月的規劃
                  </button>
                </div>
              </>
            )}

            {v.state === 'pending' && (
              <>
                <div className="acts">
                  <button type="button" className="btn-primary" onClick={() => onRecord(v)}>
                    記錄這筆支出
                  </button>
                  <button
                    type="button"
                    className="btn-sec"
                    onClick={() => {
                      setPick(link?.best?.id ?? null)
                      setMode('link')
                    }}
                  >
                    關聯既有記帳
                  </button>
                </div>
                <div className="acts-row">
                  <button type="button" className="btn-text" onClick={() => onEdit(v)}>
                    修改本月內容
                  </button>
                  {v.item.templateId ? (
                    <button type="button" className="btn-text" disabled={busy} onClick={() => run(() => skipPlannedExpense(v.item.id), `「${v.item.name}」本月略過`)}>
                      本月略過
                    </button>
                  ) : (
                    <button type="button" className="btn-text" disabled={busy} onClick={() => run(() => removeOneOffExpense(v.item.id), `已移除「${v.item.name}」`)}>
                      移除這筆
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {v && mode === 'link' && (
          <div className="it-body">
            <p className="note first">
              「{v.item.name}」預估 {fmt(v.item.amount)}。只列出 {m} 月還沒對應其他必要支出的支出，依分類、商家、金額與付款方式排序；對應後不會新增記帳。
            </p>
            {link && link.candidates.length > 0 ? (
              <div className="card">
                {link.candidates.map(({ tx }) => (
                  <button type="button" key={tx.id} className="row cand-row" aria-pressed={pick === tx.id} onClick={() => setPick(tx.id)}>
                    <span className="st" aria-hidden="true">
                      <Icon name="check" />
                    </span>
                    <span className="row-main">
                      <span className="row-title">
                        {tx.merchant || catName(tx.categoryId)}
                        {link.best?.id === tx.id && <span className="best">最可能</span>}
                      </span>
                      <span className="row-sub">
                        {dayLabel(new Date(tx.occurredAt), { short: true })} {timeLabel(new Date(tx.occurredAt))} · {catName(tx.categoryId)} · {payName(tx.paymentMethodId)}
                      </span>
                    </span>
                    <span className="row-amt num">{fmt(tx.amount)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty">
                <strong>{m} 月沒有看起來相符的支出</strong>可以改用「記錄這筆支出」。
              </div>
            )}
            <div className="acts">
              <button
                type="button"
                className="btn-primary"
                disabled={!pick || busy}
                onClick={() => pick && run(() => linkPlannedExpense(v.item.id, pick), '已對應，沒有新增記帳')}
              >
                對應這筆記帳
              </button>
            </div>
          </div>
        )}
      </BottomSheet>
    </Overlay>
  )
}
