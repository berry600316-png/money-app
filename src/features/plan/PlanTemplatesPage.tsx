import { useState } from 'react'
import { usePlanTemplates } from '../../db/hooks'
import { deletePlanTemplate, planTemplateDeleteImpact, setPlanTemplateActive } from '../../db/planRepo'
import { deleteMessage, type DeleteImpact } from '../../db/deletion'
import { ActionSheet } from '../../ui/ActionSheet'
import { Overlay } from '../../ui/overlay'
import { MoneyError } from '../../db/repo'
import { currentMonthKey } from '../../lib/months'
import { fmt } from '../../lib/money'
import { planDayLabel } from '../../lib/plan'
import { Icon } from '../../ui/Icon'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'
import { PlanItemEditor, type PlanEditorTarget } from './PlanItemEditor'

/** D-107: the fixed monthly items. No sorting, no complex repeat rules (spec 15.5). D-140: 刪除 / 已刪除. */
export function PlanTemplatesPage({ backLabel, onBack }: { backLabel: string; onBack: () => void }) {
  const templates = usePlanTemplates()
  const ref = useRefData()
  const toast = useToast()
  const [editor, setEditor] = useState<PlanEditorTarget | null>(null)
  const [asking, setAsking] = useState<{ id: string; name: string; impact: DeleteImpact } | null>(null)
  const [showDeleted, setShowDeleted] = useState(false)
  const cur = currentMonthKey()
  const fail = (e: unknown) => toast(e instanceof MoneyError ? e.message : '沒有成功，請再試一次', { kind: 'error' })

  const askDelete = (id: string, name: string) => planTemplateDeleteImpact(id).then((impact) => setAsking({ id, name, impact }), fail)
  const doDelete = () => {
    if (!asking) return
    const { id, name } = asking
    setAsking(null)
    deletePlanTemplate(id).then(
      (r) => toast(r.mode === 'hard' ? `已刪除「${name}」` : `已刪除「${name}」，之後的月份不再加入；可以在「已刪除」恢復`),
      fail,
    )
  }
  const restore = (id: string, name: string) => setPlanTemplateActive(id, true).then(() => toast(`已恢復「${name}」`), fail)

  const active = (templates ?? []).filter((t) => t.isActive)
  const stopped = (templates ?? []).filter((t) => !t.isActive)
  const row = (t: NonNullable<typeof templates>[number]) => (
    <div className="row tpl-row" key={t.id}>
      <button type="button" className="row-main as-btn" onClick={() => setEditor({ kind: 'template', template: t, fromMonth: cur })}>
        <span className="row-title">{t.name}</span>
        <span className="row-sub">
          {planDayLabel(t)} · {ref.category(t.categoryId).name} · {ref.payment(t.paymentMethodId).name}
        </span>
      </button>
      <span className="row-amt num">{fmt(t.amount)}</span>
      {t.isActive ? (
        <button type="button" className="mini-btn" aria-label={`刪除「${t.name}」`} onClick={() => void askDelete(t.id, t.name)}>
          刪除
        </button>
      ) : (
        <button type="button" className="mini-btn" aria-label={`恢復「${t.name}」`} onClick={() => void restore(t.id, t.name)}>
          恢復
        </button>
      )}
    </div>
  )

  return (
    <>
      <div className="page-head">
        <button type="button" className="back" onClick={onBack}>
          <Icon name="left" />
          {backLabel}
        </button>
        <h1>固定項目</h1>
        <span />
      </div>
      <p className="note first">每個月都會有的必要支出。新的月份開始規劃時，會依這裡建立當月的項目；每個月仍可單獨修改。</p>
      <button type="button" className="add-line" onClick={() => setEditor({ kind: 'template', template: null, fromMonth: cur })}>
        <Icon name="plus" />
        新增固定項目
      </button>
      {templates && templates.length === 0 && <div className="empty">還沒有固定項目</div>}
      {active.length > 0 && (
        <>
          <div className="sec-head">
            <h2>使用中</h2>
            <span>{active.length} 個</span>
          </div>
          <div className="card">{active.map(row)}</div>
        </>
      )}
      {stopped.length > 0 && (
        <>
          <button type="button" className="summary-toggle" aria-expanded={showDeleted} onClick={() => setShowDeleted(!showDeleted)}>
            <span>已刪除 {stopped.length} 個（過去月份的紀錄保留）</span>
            <Icon name="chev" />
          </button>
          {showDeleted && <div className="card muted-card">{stopped.map(row)}</div>}
        </>
      )}
      <PlanItemEditor target={editor} onClose={() => setEditor(null)} />
      <Overlay>
        <ActionSheet
          open={asking !== null}
          onClose={() => setAsking(null)}
          title={`刪除「${asking?.name ?? ''}」？`}
          message={asking ? `本月起還沒記帳、沒改過的這一項會拿掉。${deleteMessage(asking.impact, 'other')}` : ''}
          actions={[{ label: '刪除', danger: true, onClick: doDelete }]}
        />
      </Overlay>
    </>
  )
}
