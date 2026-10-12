import { useState } from 'react'
import { useSalaryItems } from '../db/hooks'
import { moveCategory, movePaymentMethod } from '../db/repo'
import type { CategoryType, PaymentType, SalaryKind } from '../db/types'
import { PAYMENT_TYPE_LABELS } from '../db/types'
import { Icon } from '../ui/Icon'
import { useRefData } from '../ui/refData'

export type ManageKind = 'category' | 'payment' | 'salary'

export type EditorTarget =
  | { kind: 'category'; id: string | null; type: CategoryType }
  /** `newType`: the kind a new account starts as (D-123: 新增帳戶 starts as a bank account). */
  | { kind: 'payment'; id: string | null; newType?: PaymentType }
  | { kind: 'salary'; id: string | null; salaryKind: SalaryKind }

const TITLES: Record<ManageKind, string> = { category: '分類', payment: '帳戶與付款方式', salary: '薪資項目' }

/** Up / down buttons shown while 調整順序 is on (D-122). */
function MoveButtons({ name, first, last, onMove }: { name: string; first: boolean; last: boolean; onMove: (dir: -1 | 1) => void }) {
  return (
    <span className="mv-btns">
      <button type="button" aria-label={`${name}往上移`} disabled={first} onClick={() => onMove(-1)}>
        <Icon name="up" />
      </button>
      <button type="button" aria-label={`${name}往下移`} disabled={last} onClick={() => onMove(1)}>
        <Icon name="down" />
      </button>
    </span>
  )
}

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
  const [ordering, setOrdering] = useState(false)
  const title = TITLES[kind]
  const canOrder = kind !== 'salary'

  return (
    <section className={'page' + (open ? ' open' : '')} aria-label={title} aria-hidden={!open} inert={!open}>
      <div className="page-head">
        <button
          type="button"
          className="back"
          onClick={() => {
            setOrdering(false)
            onBack()
          }}
        >
          <Icon name="left" />
          設定
        </button>
        <h1>{title}</h1>
        {canOrder ? (
          <button type="button" className="head-action" onClick={() => setOrdering((o) => !o)}>
            {ordering ? '完成' : '調整順序'}
          </button>
        ) : (
          <span />
        )}
      </div>

      {kind === 'category' &&
        (['expense', 'income'] as const).map((type) => {
          const list = ref.categories.filter((c) => c.type === type)
          return (
            <div className="set-sec" key={type}>
              <h2>{type === 'expense' ? '支出' : '收入'}</h2>
              <div className="set-card">
                {list.map((c, i) =>
                  ordering ? (
                    <div key={c.id} className={'srow' + (c.isActive ? '' : ' off')}>
                      <span className="s-main">{c.name}</span>
                      <MoveButtons name={c.name} first={i === 0} last={i === list.length - 1} onMove={(dir) => void moveCategory(c.id, dir)} />
                    </div>
                  ) : (
                    <button type="button" key={c.id} className={'srow' + (c.isActive ? '' : ' off')} onClick={() => onEdit({ kind: 'category', id: c.id, type })}>
                      <span className="s-main">{c.name}</span>
                      {!c.isActive && <span className="s-val">已停用</span>}
                      <Icon name="chev" className="chev" />
                    </button>
                  ),
                )}
                {!ordering && (
                  <button type="button" className="srow add" onClick={() => onEdit({ kind: 'category', id: null, type })}>
                    <span className="s-main">新增{type === 'expense' ? '支出' : '收入'}分類</span>
                    <Icon name="plus" className="chev" />
                  </button>
                )}
              </div>
            </div>
          )
        })}

      {kind === 'payment' && (
        <div className="set-sec">
          <div className="set-card">
            {ref.payments.map((p, i) => {
              const sub = (
                <span className="s-sub">
                  {PAYMENT_TYPE_LABELS[p.type]}
                  {p.bank ? ` · ${p.bank}` : ''}
                  {p.cardLast4 ? ` · 末四碼 ${p.cardLast4}` : ''}
                </span>
              )
              return ordering ? (
                <div key={p.id} className={'srow' + (p.isActive ? '' : ' off')}>
                  <span className="s-main">
                    {p.name}
                    {sub}
                  </span>
                  <MoveButtons name={p.name} first={i === 0} last={i === ref.payments.length - 1} onMove={(dir) => void movePaymentMethod(p.id, dir)} />
                </div>
              ) : (
                <button type="button" key={p.id} className={'srow' + (p.isActive ? '' : ' off')} onClick={() => onEdit({ kind: 'payment', id: p.id })}>
                  <span className="s-main">
                    {p.name}
                    {sub}
                  </span>
                  {!p.isActive && <span className="s-val">已停用</span>}
                  <Icon name="chev" className="chev" />
                </button>
              )
            })}
            {!ordering && (
              <button type="button" className="srow add" onClick={() => onEdit({ kind: 'payment', id: null, newType: 'bank' })}>
                <span className="s-main">新增帳戶或付款方式</span>
                <Icon name="plus" className="chev" />
              </button>
            )}
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
          : kind === 'payment'
            ? '銀行、現金、儲值、信用卡是帳戶，會計算餘額；轉帳、行動支付、其他是付款方式，記帳時會再問錢從哪個帳戶出。停用後不會出現在新增畫面，過去的紀錄都會保留。'
            : '停用後不會出現在新增畫面，但過去的紀錄和統計都會保留。順序也是記一筆時分類的排列順序。'}
      </p>
    </section>
  )
}
