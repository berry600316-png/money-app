import type { PaymentMethod, PaymentType } from '../../db/types'
import { cardsPaidFrom, isCard, isMethod, type PayGroup, type PayOption } from '../../lib/accounts'
import { fmt } from '../../lib/money'
import { BottomSheet } from '../../ui/BottomSheet'
import { Icon } from '../../ui/Icon'
import { Overlay } from '../../ui/overlay'
import { useRefData } from '../../ui/refData'

/** Which accounts a picker offers (D-120). Paying an expense has its own picker (D-125). */
export type PickRole = 'into' | 'from' | 'to'

const TITLES: Record<PickRole, string> = {
  into: '存入哪個帳戶',
  from: '從哪個帳戶',
  to: '到哪個帳戶',
}

const GROUPS: { types: PaymentType[]; label: (role: PickRole) => string }[] = [
  { types: ['bank'], label: () => '銀行' },
  { types: ['cash'], label: () => '現金' },
  { types: ['stored_value'], label: () => '儲值' },
  { types: ['credit_card'], label: () => '信用卡（繳卡費）' },
]

export function allowedIn(role: PickRole, p: PaymentMethod, exclude?: string): boolean {
  if (p.id === exclude) return false
  if (role === 'to') return !isMethod(p)
  return !isMethod(p) && !isCard(p)
}

/**
 * D-125: how an expense is paid, grouped by the account it draws on. One tap picks both the way to pay
 * and the account; a card (or a 行動支付 bound to one) shows "預扣", anything else "直接扣".
 */
export function PayPicker({
  open,
  groups,
  value,
  recent,
  balances,
  onPick,
  onClose,
}: {
  open: boolean
  groups: readonly PayGroup[]
  /** Key of the current choice (payKey). */
  value: string
  /** The option last used, shown first. */
  recent: PayOption | undefined
  balances: ReadonlyMap<string, number> | undefined
  onPick: (o: PayOption) => void
  onClose: () => void
}) {
  const ref = useRefData()
  const note = (o: PayOption, account: PaymentMethod | null, title: string) => {
    const credit = isCard(o.card)
    if (title === '行動支付' && o.card) return credit ? '預扣' : '直接扣'
    if (!account) return o.card && credit ? '預扣，卡片還沒指定銀行' : '不算進帳戶餘額'
    if (o.card) return credit ? '預扣' : '直接扣'
    if (o.paymentMethodId === account.id) {
      const b = balances?.get(account.id)
      return b === undefined ? '尚未設定餘額' : fmt(b)
    }
    return '直接扣'
  }
  const row = (o: PayOption, account: PaymentMethod | null, label = o.label, title = account?.name ?? '') => (
    <button
      type="button"
      key={o.key + label}
      className="pk-row"
      aria-pressed={o.key === value}
      onClick={() => {
        onPick(o)
        onClose()
      }}
    >
      <span className="pk-m">
        <b>{label}</b>
        {o.card?.cardLast4 && o.card.id === o.paymentMethodId && <small>···{o.card.cardLast4}</small>}
      </span>
      <span className={'pk-r ' + (account && o.paymentMethodId === account.id && balances?.has(account.id) ? 'num' : 'small')}>{note(o, account, title)}</span>
      {o.key === value && <Icon name="check" className="pk-ck" />}
    </button>
  )
  /** "餘額 52,300 · 預扣 8,320" beside a bank's name. */
  const head = (a: PaymentMethod) => {
    const b = balances?.get(a.id)
    const { cards, pending } = cardsPaidFrom(a.id, ref.payments, balances ?? new Map())
    if (b === undefined) return '尚未設定餘額'
    return `餘額 ${fmt(b)}` + (cards.length && pending ? ` · 預扣 ${fmt(pending)}` : '')
  }
  const recentGroup = recent && groups.find((g) => g.options.some((o) => o.key === recent.key))
  // Cash and stored value with nothing bound to them are one row each: list them together.
  const singles = groups.filter((g) => g.account && g.account.type !== 'bank' && g.options.length === 1)

  return (
    <Overlay>
      <BottomSheet
        open={open}
        onClose={onClose}
        labelledBy="pay-picker-title"
        className="picker-sheet"
        head={
          <div className="sheet-bar">
            <button type="button" className="txt-btn" onClick={onClose}>
              關閉
            </button>
            <h2 id="pay-picker-title">怎麼付</h2>
            <span />
          </div>
        }
      >
        <div className="pk-body">
          {recent && recentGroup && (
            <>
              <h3 className="pk-g">最近用過</h3>
              <div className="set-card">
                {row(recent, recentGroup.account, recentGroup.account && recentGroup.account.id !== recent.paymentMethodId ? `${recentGroup.account.name} · ${recent.name}` : recent.label, recentGroup.title)}
              </div>
            </>
          )}
          {groups
            .filter((g) => g.account && !singles.includes(g))
            .map((g) => (
              <div key={g.account!.id}>
                <h3 className="pk-g pk-gh">
                  <span>{g.account!.name}</span>
                  {g.account!.type === 'bank' && <span className="num-ui">{head(g.account!)}</span>}
                </h3>
                <div className="set-card">{g.options.map((o) => row(o, g.account))}</div>
              </div>
            ))}
          {singles.length > 0 && (
            <div>
              <h3 className="pk-g">現金與儲值</h3>
              <div className="set-card">{singles.map((g) => row(g.options[0], g.account))}</div>
            </div>
          )}
          {groups
            .filter((g) => !g.account)
            .map((g) => (
              <div key={g.title}>
                <h3 className="pk-g">{g.title === '行動支付' ? '行動支付（用哪張卡）' : '還沒指定帳戶（到設定指定後才會算進帳戶）'}</h3>
                <div className="set-card">{g.options.map((o) => row(o, null, o.label, g.title))}</div>
              </div>
            ))}
        </div>
      </BottomSheet>
    </Overlay>
  )
}

/**
 * D-123 / Q90: accounts with their balance, the recently used ones first. A picked value that is no
 * longer offered (a disabled account, an old record's payment method) still shows, so nothing is
 * silently changed.
 */
export function AccountPicker({
  open,
  role,
  value,
  recent,
  exclude,
  balances,
  onPick,
  onClose,
}: {
  open: boolean
  role: PickRole
  value: string
  recent: string[]
  exclude?: string
  balances: ReadonlyMap<string, number> | undefined
  onPick: (id: string) => void
  onClose: () => void
}) {
  const ref = useRefData()
  const offered = (p: PaymentMethod) => (p.isActive && allowedIn(role, p, exclude)) || p.id === value
  const recentList = recent.map((id) => ref.payments.find((p) => p.id === id)).filter((p): p is PaymentMethod => !!p && offered(p))

  const row = (p: PaymentMethod) => {
    const b = balances?.get(p.id)
    const right = b === undefined ? (
      <span className="pk-r small">尚未設定餘額</span>
    ) : (
      <span className="pk-r num">
        {fmt(b)}
        {isCard(p) && <small>預扣</small>}
      </span>
    )
    const payer = isCard(p) && p.payFromId ? ref.payment(p.payFromId).name : ''
    return (
      <button
        type="button"
        key={p.id}
        className="pk-row"
        aria-pressed={p.id === value}
        onClick={() => {
          onPick(p.id)
          onClose()
        }}
      >
        <span className="pk-m">
          <b>{p.name}</b>
          {(p.cardLast4 || payer) && <small>{[p.cardLast4 ? `···${p.cardLast4}` : '', payer ? `由 ${payer} 繳` : ''].filter(Boolean).join(' · ')}</small>}
        </span>
        {right}
        {p.id === value && <Icon name="check" className="pk-ck" />}
      </button>
    )
  }

  return (
    <Overlay>
      <BottomSheet
        open={open}
        onClose={onClose}
        labelledBy="picker-title"
        className="picker-sheet"
        head={
          <div className="sheet-bar">
            <button type="button" className="txt-btn" onClick={onClose}>
              關閉
            </button>
            <h2 id="picker-title">{TITLES[role]}</h2>
            <span />
          </div>
        }
      >
        <div className="pk-body">
          {recentList.length > 0 && (
            <>
              <h3 className="pk-g">最近用過</h3>
              <div className="set-card">{recentList.map(row)}</div>
            </>
          )}
          {GROUPS.map((g) => {
            const list = ref.payments.filter((p) => g.types.includes(p.type) && offered(p))
            if (!list.length) return null
            return (
              <div key={g.types[0]}>
                <h3 className="pk-g">{g.label(role)}</h3>
                <div className="set-card">{list.map(row)}</div>
              </div>
            )
          })}
        </div>
      </BottomSheet>
    </Overlay>
  )
}
