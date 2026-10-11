import { useMemo, useState, type RefObject } from 'react'
import { useAllTx, useMonthTx, useRangeTx } from '../db/hooks'
import { fromYmd, type YearMonth } from '../lib/dates'
import { fmt } from '../lib/money'
import { ALL_CARDS, effectiveDateMode, filterTx, isFiltered, summarize, type TxFilter } from '../lib/stats'
import { Icon } from '../ui/Icon'
import { MonthSwitch } from '../ui/MonthSwitch'
import { useRefData } from '../ui/refData'
import { TxGroups } from '../ui/TxRows'
import { FilterSheet } from './FilterSheet'

export type ListFilters = TxFilter

/** "This month, everything": the state the list opens in. */
export function emptyFilters(patch: Partial<TxFilter> = {}): TxFilter {
  return { q: '', type: 'all', categoryIds: [], payment: null, dateMode: 'month', from: '', to: '', ...patch }
}

const RENDER_LIMIT = 300

/** "2026/9/15" (year only when it differs from this year, or the range spans two years). */
function rangeLabel(from: string, to: string): string {
  const a = fromYmd(from)
  const b = fromYmd(to)
  const thisYear = new Date().getFullYear()
  const withYear = a.getFullYear() !== b.getFullYear() || a.getFullYear() !== thisYear
  const one = (d: Date) => `${withYear ? d.getFullYear() + '/' : ''}${d.getMonth() + 1}/${d.getDate()}`
  return `${one(a)} – ${one(b)}`
}

export function ListScreen({
  active,
  month,
  onMonth,
  filters,
  onFilters,
  onOpenTx,
  onAdd,
  scrollRef,
  onImportCards,
  onReconcile,
}: {
  onImportCards: () => void
  onReconcile: () => void
  active: boolean
  month: YearMonth
  onMonth: (ym: YearMonth) => void
  filters: ListFilters
  onFilters: (f: ListFilters) => void
  onOpenTx: (id: string) => void
  onAdd: () => void
  scrollRef: RefObject<HTMLElement | null>
}) {
  const ref = useRefData()
  const [sheetOpen, setSheetOpen] = useState(false)
  const mode = effectiveDateMode(filters)
  const searching = filters.q.trim() !== ''
  const monthTx = useMonthTx(month)
  const rangeTx = useRangeTx(filters.from, filters.to, mode === 'range')
  const allTx = useAllTx(mode === 'all')
  const source = mode === 'month' ? monthTx : mode === 'range' ? rangeTx : allTx

  const ctx = useMemo(
    () => ({
      month,
      isCard: (id: string) => ref.payments.find((p) => p.id === id)?.type === 'credit_card',
      names: { category: (id: string) => ref.category(id).name, payment: (id: string) => ref.payment(id).name },
    }),
    [month, ref],
  )
  const list = useMemo(() => (source ? filterTx(source, filters, ctx) : undefined), [source, filters, ctx])
  // D-103: totals from every matching row, never just the rows on screen.
  const totals = list && isFiltered(filters) ? summarize(list) : null

  const chips: { key: string; label: string; clear: () => void }[] = []
  if (filters.type !== 'all') chips.push({ key: 'type', label: filters.type === 'expense' ? '支出' : '收入', clear: () => onFilters({ ...filters, type: 'all' }) })
  if (filters.payment) {
    const p = ref.payments.find((x) => x.id === filters.payment)
    const label = filters.payment === ALL_CARDS ? '所有信用卡' : p ? p.name + (p.cardLast4 ? ` ${p.cardLast4}` : '') : '付款方式'
    chips.push({ key: 'pay', label, clear: () => onFilters({ ...filters, payment: null }) })
  }
  for (const id of filters.categoryIds) {
    chips.push({ key: 'cat:' + id, label: ref.category(id).name, clear: () => onFilters({ ...filters, categoryIds: filters.categoryIds.filter((c) => c !== id) }) })
  }
  if (filters.dateMode !== 'month') {
    chips.push({
      key: 'date',
      label: filters.dateMode === 'all' ? '全部日期' : rangeLabel(filters.from, filters.to),
      clear: () => onFilters({ ...filters, dateMode: 'month' }),
    })
  }
  const narrowed = filters.type !== 'all' || filters.payment !== null || filters.categoryIds.length > 0 || filters.dateMode !== 'month'

  return (
    <section ref={scrollRef} className={'screen' + (active ? ' active' : '')} aria-label="明細" aria-hidden={!active} inert={!active}>
      <div className="title-row">
        <h1 className="large-title">明細</h1>
        {mode === 'month' ? (
          <MonthSwitch value={month} onChange={onMonth} />
        ) : (
          // Q63: never let a range or "all dates" look like a single month.
          <button type="button" className="mode-pill" onClick={() => setSheetOpen(true)}>
            {mode === 'all' ? '全部日期' : rangeLabel(filters.from, filters.to)}
            {searching && filters.dateMode === 'month' && <small>搜尋中</small>}
          </button>
        )}
      </div>
      {/* D-95: credit card entry points, no extra tab. */}
      <div className="card-entry">
        <button type="button" onClick={onImportCards}>
          <Icon name="inbox" />
          匯入刷卡紀錄
        </button>
        <button type="button" onClick={onReconcile}>
          <Icon name="reconcile" />
          信用卡核對
        </button>
      </div>
      <div className="tools">
        <div className="search-row">
          <label className="search">
            <span className="sr">搜尋交易</span>
            <Icon name="search" />
            <input
              id="search"
              type="search"
              placeholder="搜尋商家、備註或金額"
              autoComplete="off"
              enterKeyHint="search"
              value={filters.q}
              onChange={(e) => onFilters({ ...filters, q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
            {searching && (
              <button type="button" className="clear-q" aria-label="清除搜尋" onClick={() => onFilters({ ...filters, q: '' })}>
                <Icon name="x" />
              </button>
            )}
          </label>
          <button type="button" className={'filter-btn' + (narrowed ? ' on' : '')} onClick={() => setSheetOpen(true)}>
            <Icon name="filter" />
            篩選
          </button>
        </div>
        {searching && filters.dateMode === 'month' && <p className="search-note">搜尋全部日期；清除搜尋後回到 {month.m + 1} 月</p>}
        {chips.length > 0 && (
          <div className="f-chips">
            {chips.map((c) => (
              <button type="button" key={c.key} className="f-chip" aria-label={`取消篩選：${c.label}`} onClick={c.clear}>
                {c.label}
                <Icon name="x" />
              </button>
            ))}
            {chips.length > 1 && (
              <button type="button" className="f-clear" onClick={() => onFilters(emptyFilters({ q: filters.q, from: filters.from, to: filters.to }))}>
                清除篩選
              </button>
            )}
          </div>
        )}
      </div>

      {totals && list && (
        <div className="sumbar" aria-label="篩選結果小計">
          <span className="sum-n">{list.length} 筆</span>
          <span>
            <small>收入</small>
            <b className="num">{fmt(totals.income)}</b>
          </span>
          <span>
            <small>支出</small>
            <b className="num">{fmt(totals.expense)}</b>
          </span>
          <span>
            <small>結餘</small>
            <b className={'num' + (totals.balance < 0 ? ' neg' : '')}>
              {totals.balance < 0 ? '−' : ''}
              {fmt(Math.abs(totals.balance))}
            </b>
          </span>
        </div>
      )}

      {list && list.length > 0 && <TxGroups list={list.slice(0, RENDER_LIMIT)} onOpen={onOpenTx} />}
      {list && list.length > RENDER_LIMIT && <p className="empty">只顯示最近 {RENDER_LIMIT} 筆，小計已包含全部 {list.length} 筆；請用搜尋或篩選縮小範圍。</p>}

      {list && list.length === 0 &&
        (searching ? (
          <div className="empty">
            <strong>找不到「{filters.q.trim()}」</strong>試試商家名稱、分類或完整金額。
          </div>
        ) : narrowed ? (
          <div className="empty">
            <strong>{mode === 'month' ? '這個月' : mode === 'range' ? '這段期間' : ''}沒有符合條件的紀錄</strong>換個條件或清除篩選看看。
          </div>
        ) : (
          <div className="empty">
            <strong>這個月還沒有紀錄</strong>記下的每一筆都會出現在這裡。
            <br />
            <button type="button" className="btn-soft" onClick={onAdd}>
              記一筆
            </button>
          </div>
        ))}

      <FilterSheet open={sheetOpen} value={filters} month={month} onClose={() => setSheetOpen(false)} onApply={(f) => onFilters(f)} />
    </section>
  )
}
