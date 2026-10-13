import { useState } from 'react'
import { useAccountFlow, useBalances } from '../../db/hooks'
import { deleteAdjustment, restoreAdjustment } from '../../db/repo'
import type { BalanceAdjustment, PaymentMethod } from '../../db/types'
import { PAYMENT_TYPE_LABELS } from '../../db/types'
import { cardsPaidFrom, isCard, type FlowRow } from '../../lib/accounts'
import { dayLabel, fromYmd, timeLabel, toYmd } from '../../lib/dates'
import { fmt } from '../../lib/money'
import { ActionSheet } from '../../ui/ActionSheet'
import { AnimatedNumber } from '../../ui/AnimatedNumber'
import { Icon } from '../../ui/Icon'
import { Overlay } from '../../ui/overlay'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'
import { AdjustSheet, SetupSheet } from './AccountSheets'

/**
 * D-123: one account (or card) — balance, the cards it pays, and its history since the start date.
 * Kept short on purpose: no bank-statement columns, just what moved and why.
 */
export function AccountPage({
  id,
  backLabel,
  onBack,
  onEdit,
  onOpenTx,
  onTransferFrom,
  onPayCard,
  onOpenAccount,
}: {
  id: string
  backLabel: string
  onBack: () => void
  onEdit: (id: string) => void
  onOpenTx: (txId: string) => void
  onTransferFrom: (accountId: string) => void
  onPayCard: (card: PaymentMethod, pending: number) => void
  onOpenAccount: (id: string) => void
}) {
  const ref = useRefData()
  const toast = useToast()
  const balances = useBalances()
  const flow = useAccountFlow(id)
  const [adjusting, setAdjusting] = useState(false)
  const [setup, setSetup] = useState(false)
  const [adjRow, setAdjRow] = useState<BalanceAdjustment | null>(null)
  const acc = ref.payments.find((p) => p.id === id)
  const head = (
    <div className="page-head">
      <button type="button" className="back" onClick={onBack}>
        <Icon name="left" />
        {backLabel}
      </button>
      <h1>{acc?.name ?? '帳戶'}</h1>
      {acc ? (
        <button type="button" className="head-action" onClick={() => onEdit(acc.id)}>
          編輯
        </button>
      ) : (
        <span />
      )}
    </div>
  )
  if (!acc) return head

  const card = isCard(acc)
  const bal = balances?.get(acc.id)
  const paid = cardsPaidFrom(acc.id, ref.payments, balances ?? new Map())
  const payer = card && acc.payFromId ? ref.payments.find((p) => p.id === acc.payFromId) : undefined

  if (bal === undefined) {
    return (
      <>
        {head}
        <section className="acc-hero p-in d1">
          <div className="eyebrow">{PAYMENT_TYPE_LABELS[acc.type]}　·　尚未設定{card ? '預扣' : '餘額'}</div>
          <p className="acc-intro">
            填「今天{card ? '還沒繳的卡費' : '實際有多少'}」之後，之後的收支、互轉{card ? '和繳卡費' : ''}都會算進這個{card ? '卡' : '帳戶'}。今天以前的紀錄照樣在明細和統計裡，只是不算進{card ? '預扣' : '餘額'}。
          </p>
          <button type="button" className="btn-primary" onClick={() => setSetup(true)}>
            設定目前{card ? '預扣' : '餘額'}
          </button>
        </section>
        <SetupSheet open={setup} accounts={[acc]} onClose={() => setSetup(false)} />
      </>
    )
  }

  const describe = (r: FlowRow): { title: string; sub: string } => {
    if (r.kind === 'adjustment') {
      const a = r.adjustment!
      return { title: '餘額調整', sub: `${a.note || '校正金額'}（${fmt(a.before)} → ${fmt(a.after)}）` }
    }
    const t = r.tx!
    const time = timeLabel(new Date(t.occurredAt))
    if (t.type === 'transfer') {
      const toCard = isCard(ref.payment(t.toAccountId ?? ''))
      const other = t.paymentMethodId === acc.id ? `→ ${ref.payment(t.toAccountId ?? '').name}` : `← ${ref.payment(t.paymentMethodId).name}`
      return { title: `${toCard ? '繳卡費' : '互轉'} ${other}`, sub: [time, t.note].filter(Boolean).join(' · ') }
    }
    const cat = ref.category(t.categoryId).name
    // How it was paid when that is not this account itself: 轉帳, 信用卡, Apple Pay… (D-125).
    const via = t.paymentMethodId !== acc.id ? ref.payment(t.paymentMethodId).name : ''
    return { title: t.merchant || cat, sub: [time, cat, via, t.note].filter(Boolean).join(' · ') }
  }

  // Group the history by local day, newest first.
  const days: { ymd: string; rows: FlowRow[] }[] = []
  for (const r of flow ?? []) {
    const k = toYmd(new Date(r.at))
    const last = days[days.length - 1]
    if (last && last.ymd === k) last.rows.push(r)
    else days.push({ ymd: k, rows: [r] })
  }

  return (
    <>
      {head}
      <section className="acc-hero p-in d1" aria-live="polite">
        <div className="eyebrow">
          {card ? `信用卡${acc.cardLast4 ? ' ···' + acc.cardLast4 : ''}　·　預扣（還沒繳）` : `${PAYMENT_TYPE_LABELS[acc.type]}　·　目前餘額`}
        </div>
        <div className="acc-amt num">
          <span className="cur">NT$</span>
          <AnimatedNumber value={bal} abs={false} />
        </div>
        {card ? (
          <p className="acc-line">
            {payer ? <>由 <b>{payer.name}</b> 繳款。</> : '還沒指定繳款帳戶，第一次繳卡費時會記住。'}刷卡算本月支出，繳卡費時才從銀行扣。
          </p>
        ) : paid.pending > 0 ? (
          <p className="acc-line">
            卡費預扣 <b className="num">{fmt(paid.pending)}</b>　·　扣完剩 <b className="num">{fmt(bal - paid.pending)}</b>
          </p>
        ) : (
          <p className="acc-line">
            {acc.balanceFrom && `${new Date(acc.balanceFrom).getMonth() + 1}月${new Date(acc.balanceFrom).getDate()}日起算，起始 ${fmt(acc.openingBalance ?? 0)}`}
          </p>
        )}
      </section>

      <div className="acc-acts p-in d2" style={{ ['--n' as string]: card ? 2 : paid.cards.length ? 3 : 2 }}>
        {card ? (
          <button type="button" disabled={bal <= 0} onClick={() => onPayCard(acc, bal)}>
            <Icon name="card" />
            繳卡費
          </button>
        ) : (
          <>
            <button type="button" onClick={() => onTransferFrom(acc.id)}>
              <Icon name="swap" />
              互轉
            </button>
            {paid.cards.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const c = paid.cards.find((x) => (balances?.get(x.id) ?? 0) > 0) ?? paid.cards[0]
                  onPayCard(c, balances?.get(c.id) ?? 0)
                }}
              >
                <Icon name="card" />
                繳卡費
              </button>
            )}
          </>
        )}
        <button type="button" onClick={() => setAdjusting(true)}>
          <Icon name="adjust" />
          調整{card ? '預扣' : '餘額'}
        </button>
      </div>

      {!card &&
        paid.cards.map((c) => (
          <button type="button" key={c.id} className="acc-link p-in d2" onClick={() => onOpenAccount(c.id)}>
            <span>{c.name} 預扣中</span>
            <span>
              <b className="num">{fmt(balances?.get(c.id) ?? 0)}</b> ›
            </span>
          </button>
        ))}

      {days.map((g) => (
        <section className="group" key={g.ymd}>
          <div className="group-head">
            <span>{dayLabel(fromYmd(g.ymd))}</span>
          </div>
          <div className="card">
            {g.rows.map((r) => {
              const { title, sub } = describe(r)
              const moved = r.kind === 'tx' && r.tx!.type === 'transfer'
              // Card rows read as "owed": spending adds 預扣 (shown −), paying it off is shown +.
              const shownDelta = card ? -r.delta : r.delta
              return (
                <button
                  type="button"
                  key={(r.tx?.id ?? r.adjustment!.id) + r.delta}
                  className="row"
                  onClick={() => (r.kind === 'tx' ? onOpenTx(r.tx!.id) : setAdjRow(r.adjustment!))}
                >
                  <span className="row-main">
                    <span className="row-title">{title}</span>
                    <span className="row-sub">{sub}</span>
                  </span>
                  <span className={'row-amt num' + (moved ? ' transfer' : r.pending ? ' pending' : shownDelta > 0 ? ' income' : '')}>
                    {shownDelta > 0 ? '+' : '−'}
                    {fmt(Math.abs(shownDelta))}
                    {moved && <small>不算收支</small>}
                    {r.pending && <small>預扣</small>}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      ))}
      <p className="set-foot acc-start">
        {acc.balanceFrom && `${dayLabel(new Date(acc.balanceFrom), { short: true })} ${timeLabel(new Date(acc.balanceFrom))} 以前的紀錄已含在起始${card ? '預扣' : '餘額'}裡，不再重算。`}
        {flow && flow.length === 0 && '起算後還沒有紀錄。'}
      </p>

      <AdjustSheet account={adjusting ? acc : null} current={bal} onClose={() => setAdjusting(false)} />
      <Overlay>
        <ActionSheet
          open={adjRow !== null}
          onClose={() => setAdjRow(null)}
          title="這筆餘額調整"
          message={adjRow ? `${adjRow.note || '校正金額'}：${fmt(adjRow.before)} → ${fmt(adjRow.after)}` : undefined}
          actions={[
            {
              label: '刪除這筆調整',
              danger: true,
              onClick: () => {
                const a = adjRow
                setAdjRow(null)
                if (!a) return
                deleteAdjustment(a.id).then(
                  (gone) =>
                    toast('已刪除調整', {
                      undo: gone ? () => void restoreAdjustment(gone).then(() => toast('已復原')) : undefined,
                    }),
                  () => toast('刪除失敗，請再試一次', { kind: 'error' }),
                )
              },
            },
          ]}
        />
      </Overlay>
    </>
  )
}
