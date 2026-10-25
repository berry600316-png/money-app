import { useEffect, useRef, useState } from 'react'
import { addOneOffExpense, addPlanTemplate, editPlannedExpense, PLAN_NAME_MAX, updatePlanTemplate, type PlanItemInput } from '../../db/planRepo'
import { MoneyError } from '../../db/repo'
import type { PlannedExpense, PlanTemplate } from '../../db/types'
import { looksLikeCardBill } from '../../lib/plan'
import { BottomSheet } from '../../ui/BottomSheet'
import { Seg } from '../../ui/Seg'
import { useCloseGuard, useDirtyCheck } from '../../ui/discard'
import { Overlay } from '../../ui/overlay'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'

export type PlanEditorTarget =
  | { kind: 'new'; month: string }
  | { kind: 'item'; month: string; item: PlannedExpense }
  | { kind: 'template'; template: PlanTemplate | null; fromMonth: string }

interface Draft {
  name: string
  amount: string
  day: string
  /** D-144 */
  dateMode: DateMode
  categoryId: string
  paymentMethodId: string
  /** New item only: also a fixed monthly item (D-107). */
  everyMonth: boolean
}

type DateMode = 'fixed' | 'any'
const DATE_MODES = [
  { value: 'fixed', label: '固定' },
  { value: 'any', label: '不固定' },
] as const

/** Add or change a planned expense (one month) or a fixed monthly item (D-105, D-107, D-111). */
export function PlanItemEditor({ target, onClose }: { target: PlanEditorTarget | null; onClose: () => void }) {
  const ref = useRefData()
  const toast = useToast()
  const [d, setD] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<PlanEditorTarget | null>(null)
  const opened = useRef('')

  useEffect(() => {
    if (!target) return
    setShown(target)
    setBusy(false)
    const firstCat = ref.categories.find((c) => c.type === 'expense' && c.id === 'home' && c.isActive) ?? ref.categories.find((c) => c.type === 'expense' && c.isActive)
    const firstPay = ref.payments.find((p) => p.id === 'transfer' && p.isActive) ?? ref.payments.find((p) => p.isActive)
    const src = target.kind === 'item' ? target.item : target.kind === 'template' ? target.template : null
    const next: Draft = src
      ? {
          name: src.name,
          amount: String(src.amount),
          day: String(src.day),
          dateMode: src.fixedDate ? 'fixed' : 'any',
          categoryId: src.categoryId,
          paymentMethodId: src.paymentMethodId,
          everyMonth: false,
        }
      : { name: '', amount: '', day: '1', dateMode: 'any', categoryId: firstCat?.id ?? '', paymentMethodId: firstPay?.id ?? '', everyMonth: true }
    opened.current = JSON.stringify(next)
    setD(next)
    // Only when a new target arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  useDirtyCheck('planItem', target !== null, () => !!d && !busy && JSON.stringify(d) !== opened.current)
  const guard = useCloseGuard('planItem')
  const requestClose = () => guard(onClose)

  const t = target ?? shown
  const title = !t ? '' : t.kind === 'new' ? '新增必要支出' : t.kind === 'item' ? `修改${Number(t.month.slice(5))}月的「${t.item.name}」` : t.template ? '編輯固定項目' : '新增固定項目'
  const set = (p: Partial<Draft>) => setD((x) => (x ? { ...x, ...p } : x))

  const save = async () => {
    if (!d || !t || busy) return
    const input: PlanItemInput = {
      name: d.name,
      amount: Number(d.amount || 0),
      day: Number(d.day || 0),
      fixedDate: d.dateMode === 'fixed',
      categoryId: d.categoryId,
      paymentMethodId: d.paymentMethodId,
    }
    setBusy(true)
    try {
      if (t.kind === 'new') {
        if (d.everyMonth) await addPlanTemplate(input, t.month)
        else await addOneOffExpense(t.month, input)
        toast(`已新增「${input.name.trim()}」`)
      } else if (t.kind === 'item') {
        await editPlannedExpense(t.item.id, input)
        toast('已更新這個月的內容')
      } else if (t.template) {
        await updatePlanTemplate(t.template.id, input)
        toast('已更新固定項目')
      } else {
        await addPlanTemplate(input, t.fromMonth)
        toast(`已新增固定項目「${input.name.trim()}」`)
      }
      opened.current = JSON.stringify(d)
      onClose()
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '沒有存到，請再試一次', { kind: 'error' })
      setBusy(false)
    }
  }

  const cats = ref.categories.filter((c) => c.type === 'expense' && (c.isActive || c.id === d?.categoryId))
  const pays = ref.payments.filter((p) => p.isActive || p.id === d?.paymentMethodId)

  return (
    <Overlay>
      <BottomSheet
        open={target !== null}
        onClose={requestClose}
        labelledBy="plan-ed-title"
        head={
          <div className="sheet-bar">
            <button type="button" className="txt-btn" onClick={requestClose}>
              取消
            </button>
            <h2 id="plan-ed-title">{title}</h2>
            <button type="button" className="txt-btn strong" onClick={() => void save()} disabled={busy}>
              儲存
            </button>
          </div>
        }
      >
        {d && t && (
          <div className="it-body">
            <div className="fields">
              <label className="frow" htmlFor="pe-name">
                <span>名稱</span>
                <input id="pe-name" type="text" maxLength={PLAN_NAME_MAX} placeholder="例如：房租" autoComplete="off" value={d.name} onChange={(e) => set({ name: e.target.value })} />
              </label>
              <label className="frow" htmlFor="pe-amount">
                <span>{t.kind === 'item' ? '本月金額' : t.kind === 'template' ? '預設每月金額' : '每月金額'}</span>
                <input
                  id="pe-amount"
                  type="text"
                  className="num"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="0"
                  value={d.amount}
                  onChange={(e) => set({ amount: e.target.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '').slice(0, 8) })}
                />
              </label>
              <div className="frow">
                <span>支出日期</span>
                <Seg label="支出日期" className="date-seg" options={DATE_MODES} value={d.dateMode} onChange={(dateMode) => set({ dateMode })} />
              </div>
              {d.dateMode === 'fixed' && (
                <label className="frow" htmlFor="pe-day">
                  <span>每月日期</span>
                  <select id="pe-day" value={d.day} onChange={(e) => set({ day: e.target.value })}>
                    {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((v) => (
                      <option key={v} value={v}>
                        {v} 日
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="frow" htmlFor="pe-cat">
                <span>分類</span>
                <select id="pe-cat" value={d.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="frow" htmlFor="pe-pay">
                <span>付款方式</span>
                <select id="pe-pay" value={d.paymentMethodId} onChange={(e) => set({ paymentMethodId: e.target.value })}>
                  {pays.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="note">
              {d.dateMode === 'fixed'
                ? `記錄這筆支出時，日期帶入每月 ${d.day} 日${Number(d.day) > 28 ? '（月份天數不夠時，算在該月最後一天）' : ''}；那天還沒到就帶今天。`
                : '記錄這筆支出時，日期帶入當天。'}
            </p>
            {looksLikeCardBill(d.name) && (
              <p className="note warn-inline">刷卡時已經記過每一筆消費，繳卡費不要再列為必要支出，否則會重複計算。</p>
            )}
            {t.kind === 'new' && (
              <label className="toggle-row" htmlFor="pe-every">
                <span>
                  每個月都有
                  <small>{d.everyMonth ? '加入固定項目，之後的月份開始規劃時自動帶入' : `只加在 ${Number(t.month.slice(5))} 月`}</small>
                </span>
                <input id="pe-every" type="checkbox" role="switch" checked={d.everyMonth} onChange={(e) => set({ everyMonth: e.target.checked })} />
              </label>
            )}
            {t.kind === 'item' && t.item.templateId && <p className="note">只改這個月；固定項目的預設值和其他月份都不受影響。</p>}
            {t.kind === 'template' && t.template && <p className="note">本月與之後還沒記帳、也沒單獨改過的月份會一起更新；已記帳或單獨改過的月份與過去月份不變。</p>}
          </div>
        )}
      </BottomSheet>
    </Overlay>
  )
}
