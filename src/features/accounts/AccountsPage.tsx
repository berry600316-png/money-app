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
 * (Q88 A). D-125: cards are ways to pay, not rows of their own; a bank shows its cards' 預扣 and what is
 * left after paying them, with one 繳卡費 button.
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

  const looseCards = accounts.filter((p) => isCard(p) && shown(p) && !(p.payFromId && accounts.some((a) => a.id === p.payFromId && a.type === 'bank')))

  /** Under a bank: its cards' 預扣, what is left after paying them, and 繳卡費 for the card owing most. */
  const pendingLine = (a: PaymentMethod, b: number | undefined) => {
    const { cards, pending } = cardsPaidFrom(a.id, accounts, balances ?? new Map())
    const live = cards.filter(shown)
    if (!live.length) return null
    const owing = [...live].sort((x, y) => (balances?.get(y.id) ?? 0) - (balances?.get(x.id) ?? 0))[0]
    return (
      <div className="acc-pend">
        <span className="acc-pend-t">
          {pending > 0 ? (
            <>
              卡費預扣 <b className="num">{fmt(pending)}</b>
              {b !== undefined && (
                <>
                  {' · '}扣完剩 <b className="num">{fmt(b - pending)}</b>
                </>
              )}
            </>
          ) : (
            '信用卡已繳清'
          )}
        </span>
        {pending > 0 && (
          <button type="button" className="chip-btn" onClick={() => onPayCard(owing, balances?.get(owing.id) ?? 0)}>
            繳卡費
          </button>
        )}
      </div>
    )
  }

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
                return (
                  <div key={a.id} className="acc-group">
                    <button type="button" className={'srow acc-row' + (a.isActive ? '' : ' off')} onClick={() => onOpen(a.id)}>
                      <span className="s-main">
                        {a.name}
                        <span className="s-sub">{b === undefined ? '尚未設定餘額' : a.balanceFrom ? startLabel(a.balanceFrom) : ''}</span>
                      </span>
                      {b === undefined ? <span className="s-val acc-set">設定 ›</span> : <span className={'acc-v num' + (b < 0 ? ' neg' : '')}>{fmt(b)}</span>}
                    </button>
                    {a.type === 'bank' && pendingLine(a, b)}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {looseCards.length > 0 && (
        <div className="set-sec">
          <h2>信用卡・還沒指定銀行</h2>
          <div className="set-card">{looseCards.map(cardRow)}</div>
          <p className="set-foot">到設定把卡指定給一個銀行帳戶，刷卡的預扣就會算在那個帳戶；第一次從銀行繳這張卡的卡費時也會自動記住。</p>
        </div>
      )}

      <button type="button" className="add-line" onClick={onAdd}>
        <Icon name="plus" />
        新增帳戶
      </button>
      <p className="set-foot">信用卡、金融卡、行動支付、轉帳是付款方式，掛在帳戶底下：刷信用卡先記為那個銀行的預扣，繳卡費時才真的扣款；金融卡直接扣。點銀行可看每張卡的預扣。</p>

      <SetupSheet open={setup} accounts={ov?.unset ?? []} onClose={() => setSetup(false)} />
    </>
  )
}
