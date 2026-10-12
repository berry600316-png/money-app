import type { PaymentMethod, PaymentType } from '../../db/types'
import { isCard, isMethod } from '../../lib/accounts'
import { fmt } from '../../lib/money'
import { BottomSheet } from '../../ui/BottomSheet'
import { Icon } from '../../ui/Icon'
import { Overlay } from '../../ui/overlay'
import { useRefData } from '../../ui/refData'

/** Which accounts a picker offers (D-120). */
export type PickRole = 'pay' | 'source' | 'into' | 'from' | 'to'

const TITLES: Record<PickRole, string> = {
  pay: '從哪裡付',
  source: '從哪個帳戶出',
  into: '存入哪個帳戶',
  from: '從哪個帳戶',
  to: '到哪個帳戶',
}

const GROUPS: { types: PaymentType[]; label: (role: PickRole) => string }[] = [
  { types: ['bank'], label: () => '銀行' },
  { types: ['cash'], label: () => '現金' },
  { types: ['stored_value'], label: () => '儲值' },
  { types: ['credit_card'], label: (r) => (r === 'to' ? '信用卡（繳卡費）' : '信用卡（刷卡先記為預扣）') },
  { types: ['transfer', 'mobile', 'other'], label: () => '其他付款方式' },
]

export function allowedIn(role: PickRole, p: PaymentMethod, exclude?: string): boolean {
  if (p.id === exclude) return false
  if (role === 'pay') return true
  if (role === 'to') return !isMethod(p)
  return !isMethod(p) && !isCard(p)
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
    const right = isMethod(p) ? (
      <span className="pk-r small">{role === 'pay' ? '再選從哪個帳戶出' : ''}</span>
    ) : b === undefined ? (
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
