import { useMemo, type RefObject } from 'react'
import { useAllTx, useMonthTx } from '../db/hooks'
import type { TxType } from '../db/types'
import type { YearMonth } from '../lib/dates'
import { fmt } from '../lib/money'
import { searchTx, sortDesc, summarize } from '../lib/stats'
import { Icon } from '../ui/Icon'
import { MonthSwitch } from '../ui/MonthSwitch'
import { useRefData } from '../ui/refData'
import { Seg } from '../ui/Seg'
import { TxGroups } from '../ui/TxRows'

export type TypeFilter = 'all' | TxType

export interface ListFilters {
  q: string
  type: TypeFilter
  categoryId: string | null
}

const TYPE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
] as const

const RENDER_LIMIT = 300

export function ListScreen({
  active,
  month,
  onMonth,
  filters,
  onFilters,
  onOpenTx,
  onAdd,
  scrollRef,
}: {
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
  const searching = filters.q.trim() !== ''
  const monthTx = useMonthTx(month)
  const allTx = useAllTx(searching)
  const source = searching ? allTx : monthTx

  const list = useMemo(() => {
    if (!source) return undefined
    let l = searching ? searchTx(source, filters.q, { category: (id) => ref.category(id).name, payment: (id) => ref.payment(id).name }) : source
    if (filters.type !== 'all') l = l.filter((t) => t.type === filters.type)
    if (filters.categoryId) l = l.filter((t) => t.categoryId === filters.categoryId)
    return sortDesc(l)
  }, [source, searching, filters, ref])

  const totals = list && (searching || filters.categoryId) ? summarize(list) : null

  return (
    <section ref={scrollRef} className={'screen' + (active ? ' active' : '')} aria-label="明細" aria-hidden={!active} inert={!active}>
      <div className="title-row">
        <h1 className="large-title">明細</h1>
        <MonthSwitch value={month} onChange={onMonth} dim={searching} />
      </div>
      <div className="tools">
        <label className="search">
          <span className="sr">搜尋交易</span>
          <Icon name="search" />
          <input
            id="search"
            type="search"
            placeholder="搜尋商家、分類、備註或金額"
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
        <div className="tools-row">
          <Seg label="類型" options={TYPE_OPTIONS} value={filters.type} onChange={(type) => onFilters({ ...filters, type })} />
          {filters.categoryId && (
            <button
              type="button"
              className="cat-chip"
              aria-label={`取消分類篩選：${ref.category(filters.categoryId).name}`}
              onClick={() => onFilters({ ...filters, categoryId: null })}
            >
              {ref.category(filters.categoryId).name}
              <Icon name="x" />
            </button>
          )}
          {searching && <span className="search-note">搜尋全部月份</span>}
        </div>
      </div>

      {totals && list && list.length > 0 && (
        <div className="group-head" style={{ paddingTop: 6 }}>
          <span>
            {list.length} 筆
            {totals.expense > 0 && (
              <>
                　支出 <span className="num">{fmt(totals.expense)}</span>
              </>
            )}
            {totals.income > 0 && (
              <>
                　收入 <span className="num">{fmt(totals.income)}</span>
              </>
            )}
          </span>
        </div>
      )}

      {list && list.length > 0 && <TxGroups list={list.slice(0, RENDER_LIMIT)} onOpen={onOpenTx} />}
      {list && list.length > RENDER_LIMIT && <p className="empty">只顯示最近 {RENDER_LIMIT} 筆，請用搜尋或月份縮小範圍。</p>}

      {list && list.length === 0 &&
        (searching ? (
          <div className="empty">
            <strong>找不到「{filters.q.trim()}」</strong>試試商家名稱、分類或完整金額。
          </div>
        ) : filters.type !== 'all' || filters.categoryId ? (
          <div className="empty">
            <strong>這個月沒有符合條件的紀錄</strong>換個月份或取消篩選看看。
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
    </section>
  )
}
