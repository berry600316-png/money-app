import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useSalaryItems } from '../../db/hooks'
import { payslipTotals } from '../../db/salary'
import type { SalaryKind } from '../../db/types'
import { fmt } from '../../lib/money'
import { monthKeyLabel } from '../../lib/months'
import { Icon } from '../../ui/Icon'
import { useRefData } from '../../ui/refData'
import { PayslipNoteSheet } from './PayslipNoteSheet'

/** One payslip: net pay, totals, every line (tap → item history) with its note (D-141), and the income it created. */
export function PayslipPage({
  id,
  onBack,
  backLabel,
  onEdit,
  onHistory,
}: {
  id: string
  onBack: () => void
  backLabel: string
  onEdit: (id: string) => void
  onHistory: (itemId: string) => void
}) {
  const ref = useRefData()
  const slip = useLiveQuery(async () => (await db.payslips.get(id)) ?? null, [id])
  const items = useSalaryItems()
  const [notesOpen, setNotesOpen] = useState(false)

  const head = (title: string, editable: boolean) => (
    <div className="page-head">
      <button type="button" className="back" onClick={onBack}>
        <Icon name="left" />
        {backLabel}
      </button>
      <h1>{title}</h1>
      {editable ? (
        <button type="button" className="head-action" onClick={() => onEdit(id)}>
          編輯
        </button>
      ) : (
        <span />
      )}
    </div>
  )

  if (slip === undefined || !items) return head('薪資單', false)
  if (slip === null)
    return (
      <>
        {head('薪資單', false)}
        <div className="empty">
          <strong>這張薪資單已刪除</strong>
        </div>
      </>
    )

  const kindOf = (iid: string) => items.find((i) => i.id === iid)?.kind
  const t = payslipTotals(slip.lines, kindOf)
  const lines = (kind: SalaryKind) =>
    slip.lines
      .filter((l) => kindOf(l.itemId) === kind)
      .map((l) => {
        const it = items.find((i) => i.id === l.itemId)
        return (
          <button type="button" className="row" key={l.itemId} onClick={() => onHistory(l.itemId)}>
            <span className="row-main">
              <span className="line-name">{it?.name ?? l.name}</span>
              <span className="line-sub">
                {it?.nature === 'fixed' ? '固定' : '變動'}
                {it && it.name !== l.name ? `　當時：${l.name}` : ''}
              </span>
              {l.note && <span className="line-note">{l.note}</span>}
            </span>
            <span className={'line-amt num' + (l.amount === 0 ? ' zero' : '')}>{fmt(l.amount)}</span>
            <Icon name="chev" className="chev" />
          </button>
        )
      })
  const noteCount = slip.lines.filter((l) => l.note).length
  const earnLines = lines('earning')
  const dedLines = lines('deduction')

  return (
    <>
      {head(`${monthKeyLabel(slip.month)}薪資`, true)}
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="eyebrow">實領</div>
        <div className="hero-amt num">
          <span className="cur">NT$</span>
          <span>{fmt(t.net)}</span>
        </div>
        <div className="trio">
          <div>
            <span className="lbl">應發合計</span>
            <span className="v num">{fmt(t.earning)}</span>
          </div>
          <div>
            <span className="lbl">應扣合計</span>
            <span className="v num">{fmt(t.deduction)}</span>
          </div>
          <div>
            <span className="lbl">發薪日</span>
            <span className="v num">
              {Number(slip.payDate.slice(5, 7))}/{Number(slip.payDate.slice(8))}
            </span>
          </div>
        </div>
      </section>

      <div className="sec-head">
        <h2>應發</h2>
        <span className="eyebrow">點項目看歷史</span>
      </div>
      <div className="card">{earnLines.length ? earnLines : <div className="row row-sub">沒有應發項目</div>}</div>
      <div className="sec-head">
        <h2>應扣</h2>
      </div>
      <div className="card">{dedLines.length ? dedLines : <div className="row row-sub">沒有應扣項目</div>}</div>

      {slip.transactionId ? (
        <div className="linked">
          <Icon name="link" />
          <span>
            已記入收入：{Number(slip.payDate.slice(5, 7))}/{Number(slip.payDate.slice(8))} {slip.company || `${Number(slip.month.slice(5))}月薪資`} ·{' '}
            {ref.payment(slip.paymentMethodId).name} <b>+{fmt(t.net)}</b>
          </span>
        </div>
      ) : (
        <div className="linked off">實領金額為 0 或負數，不計入收入。</div>
      )}

      {/* D-141: one place to add, change or delete the notes of this payslip. */}
      <button type="button" className="add-line note-btn" onClick={() => setNotesOpen(true)}>
        <Icon name="note" />
        備註
        {noteCount > 0 && <small>· {noteCount} 則</small>}
      </button>
      <PayslipNoteSheet slip={slip} items={items} open={notesOpen} onClose={() => setNotesOpen(false)} />
    </>
  )
}
