import { useState } from 'react'
import { useSalaryItems } from '../db/hooks'
import { MoneyError, moveCategory, movePaymentMethod } from '../db/repo'
import { restoreCategory, restorePaymentMethod, restoreSalaryItem } from '../db/deletion'
import type { CategoryType, PaymentMethod, PaymentType, SalaryKind } from '../db/types'
import { PAYMENT_TYPE_LABELS } from '../db/types'
import { isAsset, isCard } from '../lib/accounts'
import { Icon } from '../ui/Icon'
import { useRefData } from '../ui/refData'
import { useToast } from '../ui/Toast'

export type ManageKind = 'category' | 'payment' | 'salary'

export type EditorTarget =
  | { kind: 'category'; id: string | null; type: CategoryType }
  /**
   * `newType`: the kind a new account starts as (D-123: 新增帳戶 starts as a bank account).
   * `under`: a new card or 行動支付 added from a bank's page starts belonging to that bank (D-125).
   */
  | { kind: 'payment'; id: string | null; newType?: PaymentType; under?: string }
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
  const toast = useToast()
  /** D-140 / Q137: which 已刪除 lists are open. */
  const [openDeleted, setOpenDeleted] = useState<Record<string, boolean>>({})
  const title = TITLES[kind]

  /** Q137: the items in 已刪除, folded at the bottom of their list, each with 恢復. */
  const deletedList = (key: string, items: { id: string; name: string; sub?: string }[], restore: (id: string) => Promise<string[] | void>) =>
    items.length > 0 && (
      <div className="set-sec del-sec">
        <button type="button" className="summary-toggle" aria-expanded={!!openDeleted[key]} onClick={() => setOpenDeleted((o) => ({ ...o, [key]: !o[key] }))}>
          <span>已刪除 {items.length} 個</span>
          <Icon name="chev" />
        </button>
        {openDeleted[key] && (
          <div className="set-card">
            {items.map((it) => (
              <div className="srow off" key={it.id}>
                <span className="s-main">
                  {it.name}
                  {it.sub && <span className="s-sub">{it.sub}</span>}
                </span>
                <button
                  type="button"
                  className="mini-btn"
                  aria-label={`恢復「${it.name}」`}
                  onClick={() =>
                    restore(it.id).then(
                      (also) => toast(`已恢復「${it.name}」${also && also.length ? `，${also.join('、')} 也一起恢復` : ''}`),
                      (e) => toast(e instanceof MoneyError ? e.message : '沒有成功，請再試一次', { kind: 'error' }),
                    )
                  }
                >
                  恢復
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  const canOrder = kind !== 'salary'

  // D-125 / D-132: accounts, each with its credit and debit cards; 行動支付 (which may hold cards of several
  // banks), 轉帳 and the rest last.
  const byId = (id?: string) => ref.payments.find((p) => p.id === id)
  const homeOf = (p: PaymentMethod): string | undefined => {
    if (isCard(p) || p.type === 'debit_card') return p.payFromId && byId(p.payFromId)?.type === 'bank' && byId(p.payFromId)!.isActive ? p.payFromId : undefined
    return undefined
  }
  // D-140: what is in use; the rest is in 已刪除.
  const livePays = ref.payments.filter((p) => p.isActive)
  const accounts = livePays.filter(isAsset)
  const payTree = [
    ...accounts.map((a) => ({ account: a as PaymentMethod | null, items: livePays.filter((p) => !isAsset(p) && homeOf(p) === a.id) })),
    { account: null, items: livePays.filter((p) => !isAsset(p) && !homeOf(p)) },
  ].filter((g) => g.account || g.items.length)
  const bankGone = (p: PaymentMethod) => (isCard(p) || p.type === 'debit_card') && !!p.payFromId && byId(p.payFromId)?.type === 'bank' && !byId(p.payFromId)!.isActive
  const payRow = (p: PaymentMethod, nested: boolean) => {
    // Cards in 已刪除 are not offered when paying, so they are not listed as held either.
    const held = (p.cards ?? []).map((id) => byId(id)).filter((c) => c?.isActive).map((c) => c!.name)
    const sub = [
      PAYMENT_TYPE_LABELS[p.type],
      p.cardLast4 ? `末四碼 ${p.cardLast4}` : '',
      p.type === 'mobile' || p.type === 'other' ? (held.length ? `綁 ${held.join('、')}` : '還沒綁卡') : '',
      p.type === 'transfer' ? '每個銀行底下都可選' : '',
      p.type === 'debit_card' && homeOf(p) ? '直接扣' : '',
      (isCard(p) || p.type === 'debit_card') && !homeOf(p) ? (bankGone(p) ? '所屬銀行已刪除' : '還沒指定銀行') : '',
    ].filter(Boolean)
    return (
      <button type="button" key={p.id} className={'srow' + (nested ? ' sub' : '') + (p.isActive ? '' : ' off')} onClick={() => onEdit({ kind: 'payment', id: p.id })}>
        <span className="s-main">
          {p.name}
          <span className="s-sub">{sub.join(' · ')}</span>
        </span>
        <Icon name="chev" className="chev" />
      </button>
    )
  }

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
          const list = ref.categories.filter((c) => c.type === type && c.isActive)
          const gone = ref.categories.filter((c) => c.type === type && !c.isActive)
          return (
            <div key={type}>
              <div className="set-sec">
                <h2>{type === 'expense' ? '支出' : '收入'}</h2>
                <div className="set-card">
                  {list.map((c, i) =>
                    ordering ? (
                      <div key={c.id} className="srow has-ico">
                        <span className="ico">
                          <Icon name={c.icon} />
                        </span>
                        <span className="s-main">{c.name}</span>
                        <MoveButtons name={c.name} first={i === 0} last={i === list.length - 1} onMove={(dir) => void moveCategory(c.id, dir)} />
                      </div>
                    ) : (
                      <button type="button" key={c.id} className="srow has-ico" onClick={() => onEdit({ kind: 'category', id: c.id, type })}>
                        <span className="ico">
                          <Icon name={c.icon} />
                        </span>
                        <span className="s-main">{c.name}</span>
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
              {!ordering && deletedList(`cat-${type}`, gone, restoreCategory)}
            </div>
          )
        })}

      {kind === 'payment' && !ordering && (
        <>
          {/* D-125: each account with the ways to pay that belong to it. */}
          {payTree.map(({ account, items }) => (
            <div className="set-sec" key={account?.id ?? 'other'}>
              {!account && <h2>行動支付與其他</h2>}
              <div className="set-card">
                {account && payRow(account, false)}
                {items.map((p) => payRow(p, !!account))}
                {account?.type === 'bank' && (
                  <button type="button" className="srow add sub" onClick={() => onEdit({ kind: 'payment', id: null, newType: 'credit_card', under: account.id })}>
                    <span className="s-main">新增 {account.name} 的信用卡</span>
                    <Icon name="plus" className="chev" />
                  </button>
                )}
              </div>
            </div>
          ))}
          <div className="set-sec">
            <div className="set-card">
              <button type="button" className="srow add" onClick={() => onEdit({ kind: 'payment', id: null, newType: 'bank' })}>
                <span className="s-main">新增帳戶或付款方式</span>
                <Icon name="plus" className="chev" />
              </button>
            </div>
          </div>
          {deletedList(
            'pay',
            ref.payments.filter((p) => !p.isActive).map((p) => ({ id: p.id, name: p.name, sub: PAYMENT_TYPE_LABELS[p.type] + (p.cardLast4 ? ` · 末四碼 ${p.cardLast4}` : '') })),
            restorePaymentMethod,
          )}
        </>
      )}
      {kind === 'payment' && ordering && (
        <div className="set-sec">
          <div className="set-card">
            {livePays.map((p, i) => {
              const sub = (
                <span className="s-sub">
                  {PAYMENT_TYPE_LABELS[p.type]}
                  {p.bank ? ` · ${p.bank}` : ''}
                  {p.cardLast4 ? ` · 末四碼 ${p.cardLast4}` : ''}
                </span>
              )
              return ordering ? (
                <div key={p.id} className="srow">
                  <span className="s-main">
                    {p.name}
                    {sub}
                  </span>
                  <MoveButtons name={p.name} first={i === 0} last={i === livePays.length - 1} onMove={(dir) => void movePaymentMethod(p.id, dir)} />
                </div>
              ) : (
                <button type="button" key={p.id} className="srow" onClick={() => onEdit({ kind: 'payment', id: p.id })}>
                  <span className="s-main">
                    {p.name}
                    {sub}
                  </span>
                  <Icon name="chev" className="chev" />
                </button>
              )
            })}
          </div>
        </div>
      )}

      {kind === 'salary' &&
        (['earning', 'deduction'] as const).map((sk) => (
          <div key={sk}>
            <div className="set-sec">
              <h2>{sk === 'earning' ? '應發' : '應扣'}</h2>
              <div className="set-card">
                {(salaryItems ?? [])
                  .filter((i) => i.kind === sk && i.isActive)
                  .map((i) => (
                    <button type="button" key={i.id} className="srow" onClick={() => onEdit({ kind: 'salary', id: i.id, salaryKind: sk })}>
                      <span className="s-main">
                        {i.name}
                        <span className="s-sub">{i.nature === 'fixed' ? '固定：新薪資單沿用上月金額' : '變動：新薪資單從 0 開始'}</span>
                      </span>
                      <Icon name="chev" className="chev" />
                    </button>
                  ))}
                <button type="button" className="srow add" onClick={() => onEdit({ kind: 'salary', id: null, salaryKind: sk })}>
                  <span className="s-main">新增{sk === 'earning' ? '應發' : '應扣'}項目</span>
                  <Icon name="plus" className="chev" />
                </button>
              </div>
            </div>
            {deletedList(
              `salary-${sk}`,
              (salaryItems ?? []).filter((i) => i.kind === sk && !i.isActive),
              restoreSalaryItem,
            )}
          </div>
        ))}

      <p className="set-foot">
        {kind === 'salary'
          ? '刪除後不會出現在新的薪資單；用過的項目收在「已刪除」，過去的薪資單與項目歷史都保留，也可以恢復。應發或應扣在新增時決定，之後不能更改。'
          : kind === 'payment'
            ? '銀行、現金、儲值是帳戶，會計算餘額。信用卡屬於一個銀行，刷卡先記為那個銀行的預扣；金融卡也屬於一個銀行，直接從那裡扣；行動支付、其他可以綁一張或多張卡（信用卡或金融卡），付款時用上次那張；轉帳在每個銀行底下都可選。刪除後不會出現在新增畫面；用過的收在「已刪除」，過去的紀錄都保留，也可以恢復。'
            : '刪除後不會出現在新增畫面；用過的分類收在「已刪除」，過去的紀錄和統計都保留，也可以恢復。順序也是記一筆時分類的排列順序。'}
      </p>
    </section>
  )
}
