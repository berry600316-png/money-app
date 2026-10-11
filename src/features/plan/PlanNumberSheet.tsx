import { useEffect, useRef, useState } from 'react'
import { setPlanNumbers } from '../../db/planRepo'
import { MoneyError } from '../../db/repo'
import { fmt } from '../../lib/money'
import type { PlanSummary } from '../../lib/plan'
import { BottomSheet } from '../../ui/BottomSheet'
import { useCloseGuard, useDirtyCheck } from '../../ui/discard'
import { Overlay } from '../../ui/overlay'
import { useToast } from '../../ui/Toast'

/** Estimated income (A) or saving goal (D) for one month (D-110, D-112). */
export function PlanNumberSheet({
  field,
  month,
  summary,
  suggestion,
  onClose,
}: {
  field: 'income' | 'saving' | null
  month: string
  summary: PlanSummary
  /** Latest payslip's net pay: offered for a first income, saved only when the user saves (D-110). */
  suggestion: number | null
  onClose: () => void
}) {
  const toast = useToast()
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const opened = useRef('')
  const [shown, setShown] = useState<'income' | 'saving'>('income')
  const m = Number(month.slice(5))

  useEffect(() => {
    if (!field) return
    setShown(field)
    setBusy(false)
    const cur = field === 'income' ? summary.income : summary.saving
    const start = cur === null ? (suggestion ? String(suggestion) : '') : String(cur)
    // A suggestion is pre-filled but not saved: it counts as a change only once the user saves.
    opened.current = cur === null ? '' : String(cur)
    setVal(start)
    // Only when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field])

  useDirtyCheck('planNumber', field !== null, () => !busy && val !== opened.current && !(opened.current === '' && suggestion !== null && val === String(suggestion)))
  const guard = useCloseGuard('planNumber')
  const requestClose = () => guard(onClose)

  const save = async () => {
    if (busy || !field) return
    const n = val === '' ? null : Number(val)
    if (field === 'saving' && n === null) {
      setVal('0')
      return
    }
    setBusy(true)
    try {
      await setPlanNumbers(month, field === 'income' ? { income: n } : { saving: n ?? 0 })
      opened.current = val
      toast(field === 'income' ? `已更新 ${m} 月預估收入` : `已更新 ${m} 月存錢目標`)
      onClose()
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '沒有存到，請再試一次', { kind: 'error' })
      setBusy(false)
    }
  }

  const isIncome = shown === 'income'
  return (
    <Overlay>
      <BottomSheet
        open={field !== null}
        onClose={requestClose}
        labelledBy="plan-num-title"
        head={
          <div className="sheet-bar">
            <button type="button" className="txt-btn" onClick={requestClose}>
              取消
            </button>
            <h2 id="plan-num-title">{isIncome ? '預估收入' : '存錢目標'}</h2>
            <button type="button" className="txt-btn strong" onClick={() => void save()} disabled={busy}>
              儲存
            </button>
          </div>
        }
      >
        <div className="it-body">
          <div className="fields">
            <label className="frow" htmlFor="plan-num">
              <span>{m} 月</span>
              <input
                id="plan-num"
                type="text"
                className="num"
                inputMode="numeric"
                autoComplete="off"
                placeholder={isIncome ? '例如 55000' : '0'}
                value={val}
                onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '').slice(0, 8))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save()
                }}
              />
            </label>
          </div>
          {isIncome ? (
            <p className="note">
              整個月預計收到的總收入（不是「還沒收到的部分」）。之後的月份開始規劃時，會預設沿用這個數字。
              {summary.income === null && suggestion !== null && <> 已先填入最近一張薪資單的實領 {fmt(suggestion)}，按儲存才會算數。</>}
            </p>
          ) : (
            <p className="note">只是試算時先預留，不會產生記帳或轉帳。可以設 0。</p>
          )}
        </div>
      </BottomSheet>
    </Overlay>
  )
}
