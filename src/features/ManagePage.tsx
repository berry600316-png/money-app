import { useSalaryItems } from '../db/hooks'
import type { SalaryKind, TxType } from '../db/types'
import { PAYMENT_TYPE_LABELS } from '../db/types'
import { Icon } from '../ui/Icon'
import { useRefData } from '../ui/refData'

export type ManageKind = 'category' | 'payment' | 'salary'

export type EditorTarget =
  | { kind: 'category'; id: string | null; type: TxType }
  | { kind: 'payment'; id: string | null }
  | { kind: 'salary'; id: string | null; salaryKind: SalaryKind }

const TITLES: Record<ManageKind, string> = { category: '分類', payment: '付款方式', salary: '薪資項目' }

export function ManagePage({
  kind,
  open,
  onBack,
  onEdit,
}: {
  kind: ManageKind
  open: boolean
  onBack: () => void
  onEdit: (t: EditorTarget) => void
}) {
  const ref = useRefData()
  const salaryItems = useSalaryItems()
  const title = TITLES[kind]

  return (
    <section className={'page' + (open ? ' open' : '')} aria-label={title} aria-hidden={!open} inert={!open}>
      <div className="page-head">
        <button type="button" className="back" onClick={onBack}>
          <Icon name="left" />
          設定
        </button>
        <h1>{title}</h1>
        <span />
      </div>

      {kind === 'category' &&
        (['expense', 'income'] as const).map((type) => (
          <div className="set-sec" key={type}>
            <h2>{type === 'expense' ? '支出' : '收入'}</h2>
            <div className="set-card">
              {ref.categories
                .filter((c) => c.type === type)
                .map((c) => (
                  <button type="button" key={c.id} className={'srow has-ico' + (c.isActive ? '' : ' off')} onClick={() => onEdit({ kind: 'category', id: c.id, type })}>
                    <span className="ico">
                      <Icon name={c.icon} />
                    </span>
                    <span className="s-main">{c.name}</span>
                    {!c.isActive && <span className="s-val">已停用</span>}
                    <Icon name="chev" className="chev" />
                  </button>
                ))}
              <button type="button" className="srow add" onClick={() => onEdit({ kind: 'category', id: null, type })}>
                <span className="s-main">新增{type === 'expense' ? '支出' : '收入'}分類</span>
                <Icon name="plus" className="chev" />
              </button>
            </div>
          </div>
        ))}

      {kind === 'payment' && (
        <div className="set-sec">
          <div className="set-card">
            {ref.payments.map((p) => (
              <button type="button" key={p.id} className={'srow' + (p.isActive ? '' : ' off')} onClick={() => onEdit({ kind: 'payment', id: p.id })}>
                <span className="s-main">
                  {p.name}
                  <span className="s-sub">{PAYMENT_TYPE_LABELS[p.type]}</span>
                </span>
                {!p.isActive && <span className="s-val">已停用</span>}
                <Icon name="chev" className="chev" />
              </button>
            ))}
            <button type="button" className="srow add" onClick={() => onEdit({ kind: 'payment', id: null })}>
              <span className="s-main">新增付款方式</span>
              <Icon name="plus" className="chev" />
            </button>
          </div>
        </div>
      )}

      {kind === 'salary' &&
        (['earning', 'deduction'] as const).map((sk) => (
          <div className="set-sec" key={sk}>
            <h2>{sk === 'earning' ? '應發' : '應扣'}</h2>
            <div className="set-card">
              {(salaryItems ?? [])
                .filter((i) => i.kind === sk)
                .map((i) => (
                  <button type="button" key={i.id} className={'srow' + (i.isActive ? '' : ' off')} onClick={() => onEdit({ kind: 'salary', id: i.id, salaryKind: sk })}>
                    <span className="s-main">
                      {i.name}
                      <span className="s-sub">{i.nature === 'fixed' ? '固定：新薪資單沿用上月金額' : '變動：新薪資單從 0 開始'}</span>
                    </span>
                    {!i.isActive && <span className="s-val">已停用</span>}
                    <Icon name="chev" className="chev" />
                  </button>
                ))}
              <button type="button" className="srow add" onClick={() => onEdit({ kind: 'salary', id: null, salaryKind: sk })}>
                <span className="s-main">新增{sk === 'earning' ? '應發' : '應扣'}項目</span>
                <Icon name="plus" className="chev" />
              </button>
            </div>
          </div>
        ))}

      <p className="set-foot">
        {kind === 'salary'
          ? '停用後不會出現在新的薪資單，但過去的薪資單與項目歷史都會保留。應發或應扣在新增時決定，之後不能更改。'
          : '停用後不會出現在新增畫面，但過去的紀錄和統計都會保留。'}
      </p>
    </section>
  )
}
