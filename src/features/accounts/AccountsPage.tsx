import { useState } from 'react'
import { useBalances } from '../../db/hooks'
import type { PaymentMethod, PaymentType } from '../../db/types'
import { cardsPaidFrom, isCard, isMethod, overview } from '../../lib/accounts'
import { fmt } from '../../lib/money'
import { AnimatedNumber } from '../../ui/AnimatedNumber'
import { Icon } from '../../ui/Icon'
import { useRefData } from '../../ui/refData'
import { SetupSheet } from './AccountSheets'

const GROUPS: { type: PaymentType; label: string }[] = [
  { type: 'bank', label: '銀行' },
  { type: 'cash', label: '現金' },
  { type: 'stored_value', label: '儲值' },
]

const startLabel = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() + '/' : ''}${d.getMonth() + 1}/${d.getDate()} 起算`
}

/**
 * D-123: 我的帳戶. The total of bank / cash / stored value on top, card 預扣 in small print under it
 * (Q88 A); each card sits under the account that pays it (Q89 A).
 */
export function AccountsPage({
  backLabel,
  onBack,
  onOpen,
  onTransfer,
  onPayCard,
  onAdd,
}: {
  backLabel: string
  onBack: () => void
  onOpen: (id: string) => void
  onTransfer: () => void
  onPayCard: (card: PaymentMethod, pending: number) => void
  onAdd: () => void
}) {
  const ref = useRefData()
  const balances = useBalances()
  const [setup, setSetup] = useState(false)
  const accounts = ref.payments.filter((p) => !isMethod(p))
  const ov = balances ? overview(accounts, balances) : null
  const shown = (p: PaymentMethod) => p.isActive || balances?.has(p.id)

  const cardRow = (c: PaymentMethod) => {
    const pending = balances?.get(c.id)
    return (
      <div className="srow acc-card" key={c.id}>
        <button type="button" className="acc-card-main" onClick={() => onOpen(c.id)}>
          <span className="s-main">
            {c.name}
            {c.cardLast4 && <span className="tag">···{c.cardLast4}</span>}
            <span className="s-sub">{pending === undefined ? '尚未設定' : <>預扣 <span className="num">{fmt(pending)}</span></>}</span>
          </span>
        </button>
        {pending !== undefined && pending <= 0 ? (
          <span className="tag tag-brand">已繳清</span>
        ) : (
          <button type="button" className="chip-btn" onClick={() => onPayCard(c, pending ?? 0)}>
            繳卡費
          </button>
        )}
      </div>
    )
  }

  const looseCards = accounts.filter((p) => isCard(p) && shown(p) && !(p.payFromId && accounts.some((a) => a.id === p.payFromId)))

  return (
    <>
      <div className="page-head">
        <button type="button" className="back" onClick={onBack}>
          <Icon name="left" />
          {backLabel}
        </button>
        <h1>我的帳戶</h1>
        <span />
      </div>

      <section className="acc-hero p-in d1" aria-live="polite">
        <div className="eyebrow">帳戶合計</div>
        <div className="acc-amt num">
          <span className="cur">NT$</span>
          <AnimatedNumber value={ov?.total ?? 0} abs={false} />
        </div>
        {ov && ov.pending > 0 && (
          <p className="acc-line">
            卡費預扣 <b className="num">{fmt(ov.pending)}</b>　·　扣完剩 <b className="num">{fmt(ov.total - ov.pending)}</b>
          </p>
        )}
      </section>

      {ov && ov.unset.length > 0 && (
        <button type="button" className="acc-setup p-in d2" onClick={() => setSetup(true)}>
          <span>{ov.unset.length} 個帳戶尚未設定餘額</span>
          <span>一次設定 ›</span>
        </button>
      )}

      <div className="acc-acts p-in d2">
        <button type="button" onClick={onTransfer}>
          <Icon name="swap" />
          互轉
        </button>
      </div>

      {GROUPS.map((g) => {
        const list = accounts.filter((p) => p.type === g.type && shown(p))
        if (!list.length) return null
        return (
          <div className="set-sec p-in d3" key={g.type}>
            <h2>{g.label}</h2>
            <div className="set-card">
              {list.map((a) => {
                const b = balances?.get(a.id)
                const { cards } = cardsPaidFrom(a.id, accounts, balances ?? new Map())
                return (
                  <div key={a.id} className="acc-group">
                    <button type="button" className={'srow acc-row' + (a.isActive ? '' : ' off')} onClick={() => onOpen(a.id)}>
                      <span className="s-main">
                        {a.name}
                        <span className="s-sub">{b === undefined ? '尚未設定餘額' : a.balanceFrom ? startLabel(a.balanceFrom) : ''}</span>
                      </span>
                      {b === undefined ? <span className="s-val acc-set">設定 ›</span> : <span className={'acc-v num' + (b < 0 ? ' neg' : '')}>{fmt(b)}</span>}
                    </button>
                    {cards.filter(shown).map(cardRow)}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {looseCards.length > 0 && (
        <div className="set-sec">
          <h2>信用卡・未指定繳款帳戶</h2>
          <div className="set-card">{looseCards.map(cardRow)}</div>
          <p className="set-foot">第一次繳卡費時選的帳戶會被記住，之後這張卡就掛在那個帳戶下面。</p>
        </div>
      )}

      <button type="button" className="add-line" onClick={onAdd}>
        <Icon name="plus" />
        新增帳戶
      </button>
      <p className="set-foot">「轉帳」「行動支付」是付款方式，不是帳戶：記帳時選了它們，會再問錢從哪個帳戶出。</p>

      <SetupSheet open={setup} accounts={ov?.unset ?? []} onClose={() => setSetup(false)} />
    </>
  )
}
