import { useEffect, useMemo, useState } from 'react'
import { useAllTx } from '../db/hooks'
import { toYmd, type YearMonth } from '../lib/dates'
import { ALL_CARDS, filterTx, type DateMode, type TxFilter } from '../lib/stats'
import { BottomSheet } from '../ui/BottomSheet'
import { Overlay } from '../ui/overlay'
import { useRefData } from '../ui/refData'
import { Seg } from '../ui/Seg'

const DATE_OPTIONS = [
  { value: 'month', label: '指定月份' },
  { value: 'range', label: '自訂區間' },
  { value: 'all', label: '全部日期' },
] as const
const TYPE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
] as const

/** D-103: every list filter in one sheet; nothing changes until 「顯示 N 筆」. */
export function FilterSheet({
  open,
  value,
  month,
  onClose,
  onApply,
}: {
  open: boolean
  value: TxFilter
  month: YearMonth
  onClose: () => void
  onApply: (f: TxFilter) => void
}) {
  const ref = useRefData()
  const [d, setD] = useState<TxFilter>(value)
  const all = useAllTx(open)
  const today = toYmd(new Date())

  useEffect(() => {
    if (!open) return
    // A first custom range starts at the shown month's first day and ends today (or that month's end).
    const first = toYmd(new Date(month.y, month.m, 1))
    const last = toYmd(new Date(month.y, month.m + 1, 0))
    setD({ ...value, from: value.from || first, to: value.to || (last < today ? last : today) })
    // Only when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const badRange = d.dateMode === 'range' && (!d.from || !d.to || d.from > d.to)
  const ctx = useMemo(
    () => ({
      month,
      isCard: (id: string) => ref.payments.find((p) => p.id === id)?.type === 'credit_card',
      names: { category: (id: string) => ref.category(id).name, payment: (id: string) => ref.payment(id).name },
    }),
    [month, ref],
  )
  const count = all && !badRange ? filterTx(all, d, ctx).length : null
  const set = (p: Partial<TxFilter>) => setD((x) => ({ ...x, ...p }))
  const cats = ref.categories.filter((c) => (d.type === 'all' || c.type === d.type) && (c.isActive || d.categoryIds.includes(c.id)))
  const hasCards = ref.payments.some((p) => p.type === 'credit_card')

  return (
    <Overlay>
      <BottomSheet
        open={open}
        onClose={onClose}
        labelledBy="filter-title"
        className="filter-sheet"
        head={
          <div className="sheet-bar">
            <button type="button" className="txt-btn" onClick={() => setD({ ...d, type: 'all', categoryIds: [], payment: null, dateMode: 'month' })}>
              清除
            </button>
            <h2 id="filter-title">篩選</h2>
            <button type="button" className="txt-btn" onClick={onClose}>
              取消
            </button>
          </div>
        }
      >
        <div className="filter-body">
          <h3 className="f-sec">期間</h3>
          <Seg label="期間" options={DATE_OPTIONS} value={d.dateMode} onChange={(dateMode: DateMode) => set({ dateMode })} />
          {d.dateMode === 'month' && <p className="f-note">{`${month.y} 年 ${month.m + 1} 月（在明細上方切換月份）`}</p>}
          {d.dateMode === 'range' && (
            <>
              <div className="range-inputs">
                <label>
                  <span>開始</span>
                  <input type="date" value={d.from} max={today} onChange={(e) => e.target.value && set({ from: e.target.value })} />
                </label>
                <span aria-hidden="true">至</span>
                <label>
                  <span>結束</span>
                  <input type="date" value={d.to} max={today} onChange={(e) => e.target.value && set({ to: e.target.value > today ? today : e.target.value })} />
                </label>
              </div>
              {badRange && <p className="f-err">開始日期不能晚於結束日期</p>}
              <p className="f-note">包含開始與結束那兩天。</p>
            </>
          )}

          <h3 className="f-sec">類型</h3>
          <Seg
            label="類型"
            options={TYPE_OPTIONS}
            value={d.type}
            onChange={(type) => {
              // Keep only the chosen categories that still fit the type.
              const keep = d.categoryIds.filter((id) => type === 'all' || ref.category(id).type === type)
              set({ type, categoryIds: keep })
            }}
          />

          <h3 className="f-sec">付款方式</h3>
          <div className="opt-set">
            <button type="button" className="opt" aria-pressed={d.payment === null} onClick={() => set({ payment: null })}>
              不限
            </button>
            {hasCards && (
              <button type="button" className="opt" aria-pressed={d.payment === ALL_CARDS} onClick={() => set({ payment: ALL_CARDS })}>
                所有信用卡
              </button>
            )}
            {ref.payments.map((p) => (
              <button type="button" key={p.id} className="opt" aria-pressed={d.payment === p.id} onClick={() => set({ payment: p.id })}>
                {p.name}
                {p.cardLast4 && <small>{p.cardLast4}</small>}
                {!p.isActive && <small>已停用</small>}
              </button>
            ))}
          </div>

          <h3 className="f-sec">分類（可複選，不選＝全部）</h3>
          <div className="opt-set">
            {cats.map((c) => {
              const on = d.categoryIds.includes(c.id)
              return (
                <button
                  type="button"
                  key={c.id}
                  className="opt"
                  aria-pressed={on}
                  onClick={() => set({ categoryIds: on ? d.categoryIds.filter((x) => x !== c.id) : [...d.categoryIds, c.id] })}
                >
                  {c.name}
                </button>
              )
            })}
          </div>
        </div>
        <div className="filter-foot">
          <button
            type="button"
            className="btn-primary"
            disabled={badRange}
            onClick={() => {
              onApply(d)
              onClose()
            }}
          >
            {count === null ? '套用' : `顯示 ${count} 筆結果`}
          </button>
        </div>
      </BottomSheet>
    </Overlay>
  )
}
