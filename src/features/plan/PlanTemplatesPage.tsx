import { useState } from 'react'
import { usePlanTemplates } from '../../db/hooks'
import { setPlanTemplateActive } from '../../db/planRepo'
import { MoneyError } from '../../db/repo'
import { currentMonthKey } from '../../lib/months'
import { fmt } from '../../lib/money'
import { Icon } from '../../ui/Icon'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'
import { PlanItemEditor, type PlanEditorTarget } from './PlanItemEditor'

/** D-107: the fixed monthly items. No sorting, no complex repeat rules (spec 15.5). */
export function PlanTemplatesPage({ backLabel, onBack }: { backLabel: string; onBack: () => void }) {
  const templates = usePlanTemplates()
  const ref = useRefData()
  const toast = useToast()
  const [editor, setEditor] = useState<PlanEditorTarget | null>(null)
  const cur = currentMonthKey()

  const toggle = (id: string, active: boolean, name: string) =>
    setPlanTemplateActive(id, active).then(
      () => toast(active ? `「${name}」恢復使用` : `「${name}」已停用，之後的月份不再加入`),
      (e) => toast(e instanceof MoneyError ? e.message : '沒有成功，請再試一次', { kind: 'error' }),
    )

  const active = (templates ?? []).filter((t) => t.isActive)
  const stopped = (templates ?? []).filter((t) => !t.isActive)
  const row = (t: NonNullable<typeof templates>[number]) => (
    <div className="row tpl-row" key={t.id}>
      <button type="button" className="row-main as-btn" onClick={() => setEditor({ kind: 'template', template: t, fromMonth: cur })}>
        <span className="row-title">{t.name}</span>
        <span className="row-sub">
          每月 {t.day} 日 · {ref.category(t.categoryId).name} · {ref.payment(t.paymentMethodId).name}
        </span>
      </button>
      <span className="row-amt num">{fmt(t.amount)}</span>
      <button type="button" className="mini-btn" onClick={() => void toggle(t.id, !t.isActive, t.name)}>
        {t.isActive ? '停用' : '恢復'}
      </button>
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
          <div className="sec-head">
            <h2>已停用</h2>
            <span>過去月份的紀錄保留</span>
          </div>
          <div className="card muted-card">{stopped.map(row)}</div>
        </>
      )}
      <PlanItemEditor target={editor} onClose={() => setEditor(null)} />
    </>
  )
}
