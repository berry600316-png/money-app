import { useEffect, useRef, useState } from 'react'
import { db } from '../../db/db'
import { usePayslips, useSalaryItems } from '../../db/hooks'
import { MoneyError } from '../../db/repo'
import { COMPANY_MAX, deletePayslip, payslipTotals, restorePayslip, savePayslip } from '../../db/salary'
import type { SalaryKind } from '../../db/types'
import { toYmd } from '../../lib/dates'
import { fmt } from '../../lib/money'
import { currentMonthKey, monthKeyLabel } from '../../lib/months'
import { draftToLines, editPayslipDraft, newPayslipDraft, payDateFor, payMonthOffset, type PayslipDraft } from '../../lib/salaryHistory'
import { useRefData } from '../../ui/refData'
import { isAsset } from '../../lib/accounts'
import { useToast } from '../../ui/Toast'
import { useCloseGuard, useDirtyCheck } from '../../ui/discard'

export type PayslipEditorTarget = { payslipId: string } | { month: string }

/** Full-screen editor for a payslip (D-61..D-66). */
export function PayslipEditor({
  target,
  onClose,
  onDeleted,
  onOpenExisting,
}: {
  target: PayslipEditorTarget | null
  onClose: () => void
  onDeleted: (id: string) => void
  onOpenExisting: (id: string) => void
}) {
  const ref = useRefData()
  const toast = useToast()
  const slips = usePayslips()
  const items = useSalaryItems()
  const [draft, setDraft] = useState<PayslipDraft | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [shown, setShown] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const open = target !== null
  // D-101: compare with the draft as it was opened.
  const opened = useRef('')
  useDirtyCheck('payslipEditor', open, () => !!draft && !saving && JSON.stringify(draft) !== opened.current)
  const guard = useCloseGuard('payslipEditor')
  const requestClose = () => guard(onClose)

  // D-117 / Q85: a new payslip goes into the account the latest one used; else the first bank, then any account.
  const fallbackPayment = () => {
    const latest = [...(slips ?? [])].sort((a, b) => (a.month < b.month ? 1 : -1))[0]
    const ok = (id?: string) => !!id && ref.payments.some((p) => p.id === id && p.isActive && isAsset(p))
    if (latest && ok(latest.paymentMethodId)) return latest.paymentMethodId
    const bank = ref.payments.find((p) => p.isActive && p.type === 'bank')
    return bank?.id ?? ref.payments.find((p) => p.isActive && isAsset(p))?.id ?? ref.payments.find((p) => p.isActive)?.id ?? 'cash'
  }

  // Build the draft each time the editor opens.
  useEffect(() => {
    if (!target || !slips || !items) return
    setSaving(false)
    if ('payslipId' in target) {
      const s = slips.find((x) => x.id === target.payslipId)
      if (!s) return
      setEditId(s.id)
      const dr = editPayslipDraft(s, items)
      opened.current = JSON.stringify(dr)
      setDraft(dr)
    } else {
      setEditId(null)
      const base = newPayslipDraft(target.month, slips, items, fallbackPayment())
      // An older payslip may have used 轉帳 (a way to pay, not an account): start in a real account instead.
      const dr = ref.payments.some((p) => p.id === base.paymentMethodId && p.isActive && isAsset(p)) ? base : { ...base, paymentMethodId: fallbackPayment() }
      opened.current = JSON.stringify(dr)
      setDraft(dr)
    }
    bodyRef.current?.scrollTo({ top: 0 })
    // Only when a new target arrives; live updates must not reset what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, !!slips, !!items])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => setShown(true), 20)
    return () => window.clearTimeout(t)
  }, [open])
  useEffect(() => {
    if (!open) setShown(false)
  }, [open])

  if (!items || !slips) return null
  const isNew = editId === null
  const kindOf = (id: string) => items.find((i) => i.id === id)?.kind
  const totals = draft ? payslipTotals(draftToLines(draft, true), kindOf) : { earning: 0, deduction: 0, net: 0 }
  // Income goes into an account that holds money (D-117); an older payslip's choice still shows.
  const payOptions = ref.payments.filter((p) => (p.isActive && isAsset(p)) || p.id === draft?.paymentMethodId)
  const today = toYmd(new Date())

  const patch = (p: Partial<PayslipDraft>) => setDraft((d) => (d ? { ...d, ...p } : d))
  const setAmount = (itemId: string, raw: string) => {
    const v = raw.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '').slice(0, 8)
    setDraft((d) => (d ? { ...d, lines: d.lines.map((l) => (l.itemId === itemId ? { ...l, amount: v } : l)) } : d))
  }

  const changeMonth = (month: string) => {
    if (!draft || !month) return
    const existing = slips.find((s) => s.month === month && s.id !== editId)
    if (existing) {
      toast(`${monthKeyLabel(month)}已有薪資單，已為你打開`)
      onOpenExisting(existing.id)
      return
    }
    // Keep typed amounts; move the pay date with the month, keeping its offset and day (never in the future).
    const offset = Math.max(0, payMonthOffset(draft.month, draft.payDate))
    patch({ month, payDate: payDateFor(month, offset, Number(draft.payDate.slice(8))) })
  }

  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    try {
      const s = await savePayslip(editId, {
        month: draft.month,
        payDate: draft.payDate,
        company: draft.company,
        paymentMethodId: draft.paymentMethodId,
        lines: draftToLines(draft, isNew),
      })
      const net = payslipTotals(s.lines, kindOf).net
      toast(net > 0 ? `已儲存，收入記入 NT$${fmt(net)}` : '已儲存（實領為 0，不記入收入）')
      onClose()
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '沒有存到，請再試一次', { kind: 'error' })
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!editId || saving) return
    setSaving(true)
    try {
      const saved = await deletePayslip(editId)
      onClose()
      onDeleted(editId)
      toast(`已刪除 ${monthKeyLabel(saved.payslip.month)}薪資單`, {
        undo: () => {
          restorePayslip(saved).then(
            () => toast('已復原'),
            (e) => toast(e instanceof MoneyError ? e.message : '復原失敗，請再試一次', { kind: 'error' }),
          )
        },
      })
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '刪除失敗，請再試一次', { kind: 'error' })
      setSaving(false)
    }
  }

  const rows = (kind: SalaryKind) =>
    draft?.lines
      .filter((l) => kindOf(l.itemId) === kind)
      .map((l) => {
        const it = items.find((i) => i.id === l.itemId)!
        const id = `pl-${l.itemId}`
        return (
          <div className="frow" key={l.itemId}>
            <label htmlFor={id} className="fl">
              {it.name}
              <small>
                {it.nature === 'fixed' ? (isNew ? '固定・沿用上一張' : '固定') : '變動'}
                {!it.isActive && '・已停用'}
              </small>
            </label>
            <input
              id={id}
              className="amt-in"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              enterKeyHint="next"
              placeholder={!isNew && !l.onSlip ? '—' : '0'}
              value={l.amount}
              onChange={(e) => setAmount(l.itemId, e.target.value)}
            />
          </div>
        )
      })

  return (
    <section className={'editor' + (open && shown ? ' open' : '')} role="dialog" aria-modal="true" aria-labelledby="slip-ed-title" aria-hidden={!open} inert={!open}>
      <div className="page-head">
        <button type="button" className="txt-btn" onClick={requestClose}>
          取消
        </button>
        <h1 id="slip-ed-title">{isNew ? '新增薪資單' : '編輯薪資單'}</h1>
        <span />
      </div>
      {draft && (
        <>
          <div className="ed-body" ref={bodyRef}>
            <div className="field-card">
              <div className="frow">
                <label htmlFor="slip-month">所屬月份</label>
                <input id="slip-month" type="month" value={draft.month} max={currentMonthKey()} onChange={(e) => changeMonth(e.target.value)} />
              </div>
              <div className="frow">
                <label htmlFor="slip-paydate">發薪日</label>
                <input id="slip-paydate" type="date" value={draft.payDate} max={today} onChange={(e) => e.target.value && patch({ payDate: e.target.value })} />
              </div>
              <div className="frow">
                <label htmlFor="slip-company">公司名稱</label>
                <input
                  id="slip-company"
                  type="text"
                  placeholder="選填"
                  maxLength={COMPANY_MAX}
                  autoComplete="organization"
                  value={draft.company}
                  onChange={(e) => patch({ company: e.target.value })}
                />
              </div>
              <div className="frow">
                <label htmlFor="slip-pay">存入帳戶</label>
                <select id="slip-pay" value={draft.paymentMethodId} onChange={(e) => patch({ paymentMethodId: e.target.value })}>
                  {payOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="ed-sec">
              <span>應發</span>
              <span className="num">{fmt(totals.earning)}</span>
            </div>
            <div className="field-card">{rows('earning')}</div>
            <div className="ed-sec">
              <span>應扣</span>
              <span className="num">{fmt(totals.deduction)}</span>
            </div>
            <div className="field-card">{rows('deduction')}</div>
            <p className="set-foot">
              {isNew
                ? '固定項目沿用上一張的金額，變動項目從 0 開始，只要填這個月實際有的。'
                : '這張原本沒有的項目留空就不會加進去；要記為 0 元請輸入 0。'}
            </p>
            {!isNew && (
              <button type="button" className="btn-del" onClick={remove} disabled={saving}>
                刪除這張薪資單
              </button>
            )}
          </div>
          <div className="ed-foot">
            <div className="ed-total">
              <span>實領（應發 − 應扣）</span>
              <span className={'net' + (totals.net <= 0 ? ' neg' : '')}>NT${fmt(totals.net)}</span>
            </div>
            {totals.net <= 0 && <div className="ed-warn">實領為 0 或負數，儲存後不會記入收入</div>}
            <button type="button" className="btn-primary" onClick={save} disabled={saving}>
              儲存
            </button>
          </div>
        </>
      )}
    </section>
  )
}

/** Look up the payslip that created a transaction (D-73). */
export async function payslipIdForTransaction(txId: string): Promise<string | null> {
  const tx = await db.transactions.get(txId)
  if (!tx || tx.source !== 'payslip' || !tx.externalId) return null
  return (await db.payslips.get(tx.externalId)) ? tx.externalId : null
}
