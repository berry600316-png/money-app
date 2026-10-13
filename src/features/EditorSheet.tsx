import { useEffect, useRef, useState } from 'react'
import { addCategory, addPaymentMethod, MoneyError, NAME_MAX, updateCategory, updatePaymentMethod } from '../db/repo'
import { PAYMENT_TYPE_LABELS, type PaymentType, type SalaryNature } from '../db/types'
import { useSalaryItems } from '../db/hooks'
import { addSalaryItem, updateSalaryItem } from '../db/salary'
import { isCard, isMethod } from '../lib/accounts'
import { toYmd } from '../lib/dates'
import { MAX_AMOUNT } from '../lib/money'
import { Seg } from '../ui/Seg'
import { CATEGORY_ICON_CHOICES, Icon, ICON_LABELS } from '../ui/Icon'
import { BottomSheet } from '../ui/BottomSheet'
import { useRefData } from '../ui/refData'
import { useToast } from '../ui/Toast'
import type { EditorTarget } from './ManagePage'
import { useCloseGuard, useDirtyCheck } from '../ui/discard'

/** Accounts first, then the ways to pay that ask which account the money left (D-117, D-120). */
const PAYMENT_TYPES: PaymentType[] = ['bank', 'cash', 'stored_value', 'credit_card', 'debit_card', 'transfer', 'mobile', 'other']

const digits = (s: string) => s.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 8)

/** Create or edit a category / account or payment method / salary item (D-11..D-15, D-117..D-122). */
export function EditorSheet({ target, onClose }: { target: EditorTarget | null; onClose: () => void }) {
  const ref = useRefData()
  const toast = useToast()
  const open = target !== null
  const [name, setName] = useState('')
  /** D-127: the category's icon; chosen when adding and changeable later. */
  const [icon, setIcon] = useState('')
  const [payType, setPayType] = useState<PaymentType>('bank')
  const [active, setActive] = useState(true)
  const [nature, setNature] = useState<SalaryNature>('fixed')
  const [bank, setBank] = useState('')
  const [last4, setLast4] = useState('')
  const [payFrom, setPayFrom] = useState('')
  /** D-125: the card or account a 行動支付 / 其他 is bound to; '' = not bound. */
  /** D-132: the cards a 行動支付 / 其他 holds; D-133: the one its payment notices go to ('' = automatic). */
  const [held, setHeld] = useState<string[]>([])
  const [notifyCard, setNotifyCard] = useState('')
  /** D-118: start date and the balance (a card: unpaid 預扣) on it; '' amount = not counted. */
  const [startDate, setStartDate] = useState('')
  const [startAmount, setStartAmount] = useState('')
  const salaryItems = useSalaryItems()
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  // Keep showing the last target while the sheet slides away.
  const [shown, setShown] = useState<EditorTarget | null>(null)

  // D-101: snapshot the fields once they are loaded, compare on close.
  const fields = JSON.stringify([name.trim(), icon, payType, active, nature, bank.trim(), last4, payFrom, held.join(','), notifyCard, startDate, startAmount])
  const opened = useRef<string | null>(null)
  const snapNext = useRef(false)
  // Declared before the loading effect so it sees the loaded values one commit later.
  useEffect(() => {
    if (snapNext.current) {
      opened.current = fields
      snapNext.current = false
    }
  })
  useDirtyCheck('editor', open, () => !saving && opened.current !== null && fields !== opened.current)
  const guard = useCloseGuard('editor')
  const requestClose = () => guard(onClose)
  const today = toYmd(new Date())

  useEffect(() => {
    if (!target) return
    opened.current = null
    snapNext.current = true
    setShown(target)
    setErr('')
    setSaving(false)
    if (target.kind === 'category') {
      const c = target.id ? ref.categories.find((x) => x.id === target.id) : undefined
      setName(c?.name ?? '')
      setIcon(c?.icon ?? (target.type === 'income' ? 'plusCircle' : CATEGORY_ICON_CHOICES[0]))
      setActive(c?.isActive ?? true)
    } else if (target.kind === 'payment') {
      const p = target.id ? ref.payments.find((x) => x.id === target.id) : undefined
      setName(p?.name ?? '')
      setPayType(p?.type ?? target.newType ?? 'bank')
      setActive(p?.isActive ?? true)
      setBank(p?.bank ?? '')
      setLast4(p?.cardLast4 ?? '')
      setPayFrom(p?.payFromId ?? (p ? '' : (target.under ?? '')))
      setHeld(p?.cards ?? [])
      setNotifyCard(p?.notifyCardId ?? '')
      setStartDate(p?.balanceFrom ? toYmd(new Date(p.balanceFrom)) : today)
      setStartAmount(p?.openingBalance !== undefined ? String(p.openingBalance) : '')
    } else {
      const s = target.id ? salaryItems?.find((x) => x.id === target.id) : undefined
      setName(s?.name ?? '')
      setNature(s?.nature ?? (target.salaryKind === 'earning' ? 'fixed' : 'variable'))
      setActive(s?.isActive ?? true)
    }
    // Read reference data once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const t = target ?? shown
  const isNew = !t?.id
  const isCardType = payType === 'credit_card'
  // D-129: a debit card belongs to a bank account like a credit card, but takes money at once.
  const isDebit = payType === 'debit_card'
  const tracksBalance = !isMethod({ type: payType })
  // D-125: a card belongs to a bank; a 行動支付 / 其他 is bound to a card or an account.
  const payers = ref.payments.filter((p) => p.type === 'bank' && p.id !== t?.id && (p.isActive || p.id === payFrom))
  const isBindable = payType === 'mobile' || payType === 'other'
  // Q110 B: only cards (credit: 預扣, debit: 直接扣); a disabled card it already holds still shows.
  const bindCards = ref.payments.filter((p) => (isCard(p) || p.type === 'debit_card') && p.id !== t?.id && (p.isActive || held.includes(p.id)))
  const toggleCard = (id: string) => {
    setHeld((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]))
    if (notifyCard === id) setNotifyCard('')
  }
  const noun =
    t?.kind === 'payment'
      ? '帳戶或付款方式'
      : t?.kind === 'salary'
        ? t.salaryKind === 'earning'
          ? '應發項目'
          : '應扣項目'
        : t?.type === 'income'
          ? '收入分類'
          : '支出分類'
  const title = (isNew ? '新增' : '編輯') + noun

  const save = async () => {
    if (!t || saving) return
    setSaving(true)
    setErr('')
    try {
      if (t.kind === 'category') {
        if (t.id) await updateCategory(t.id, { name, icon, isActive: active })
        else await addCategory({ name, type: t.type, icon })
      } else if (t.kind === 'payment') {
        const amount = startAmount === '' ? null : Number(startAmount)
        if (amount !== null && amount > MAX_AMOUNT) throw new MoneyError('金額太大')
        if (t.id) {
          await updatePaymentMethod(t.id, {
            name,
            type: payType,
            isActive: active,
            bank,
            cardLast4: last4,
            payFromId: isCardType || isDebit ? payFrom : '',
            cards: isBindable ? held : [],
            notifyCardId: isBindable && held.includes(notifyCard) ? notifyCard : '',
            start: tracksBalance ? (amount === null ? null : { date: startDate || today, amount }) : null,
          })
        } else {
          await addPaymentMethod({
            name,
            type: payType,
            bank,
            cardLast4: last4,
            ...((isCardType || isDebit) && payFrom ? { payFromId: payFrom } : {}),
            ...(isBindable && held.length ? { cards: held } : {}),
            ...(isBindable && held.includes(notifyCard) ? { notifyCardId: notifyCard } : {}),
            ...(tracksBalance && amount !== null ? { start: { date: today, amount } } : {}),
          })
        }
      } else {
        if (t.id) await updateSalaryItem(t.id, { name, nature, isActive: active })
        else await addSalaryItem({ name, kind: t.salaryKind, nature })
      }
      toast(isNew ? `已新增「${name.trim()}」` : '已儲存')
      onClose()
    } catch (e) {
      setErr(e instanceof MoneyError ? e.message : '沒有存到，請再試一次')
      setSaving(false)
    }
  }

  const amountLabel = isCardType ? '目前還沒繳的卡費' : '目前有多少'

  return (
    <BottomSheet
      open={open}
      onClose={requestClose}
      labelledBy="editor-title"
      head={
        <div className="sheet-bar">
          <button type="button" className="txt-btn" onClick={requestClose}>
            取消
          </button>
          <h2 id="editor-title">{title}</h2>
          <span />
        </div>
      }
    >
      {t && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          {t.kind === 'payment' && (
            <div>
              <span className="lbl" id="editor-type-label">
                類型
              </span>
              <div className="opt-set" role="group" aria-labelledby="editor-type-label">
                {PAYMENT_TYPES.map((pt) => (
                  <button type="button" key={pt} className="opt" aria-pressed={payType === pt} onClick={() => setPayType(pt)}>
                    {PAYMENT_TYPE_LABELS[pt]}
                  </button>
                ))}
              </div>
              {payType === 'transfer' && <p className="range-help" style={{ marginTop: 8 }}>轉帳會出現在每個銀行帳戶底下：記帳時選「台新 · 轉帳」，就直接從台新扣。</p>}
            </div>
          )}

          <div>
            <label className="lbl" htmlFor="editor-name">
              名稱
            </label>
            <input
              id="editor-name"
              className="field"
              value={name}
              maxLength={NAME_MAX}
              autoComplete="off"
              enterKeyHint="done"
              placeholder={
                t.kind === 'payment'
                  ? { bank: '例如：台新 Richart', cash: '例如：身上現金', stored_value: '例如：悠遊卡', credit_card: '例如：台新信用卡', debit_card: '例如：台新金融卡', transfer: '例如：轉帳', mobile: '例如：LINE Pay', other: '例如：禮券' }[payType]
                  : t.kind === 'salary'
                    ? '例如：交通津貼、三節獎金'
                    : '例如：寵物、學習'
              }
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {t.kind === 'category' && (
            <div>
              <span className="lbl" id="icon-label">
                圖示
              </span>
              <div className="icon-grid" role="group" aria-labelledby="icon-label">
                {CATEGORY_ICON_CHOICES.map((n) => (
                  <button type="button" key={n} aria-pressed={icon === n} aria-label={ICON_LABELS[n]} onClick={() => setIcon(n)}>
                    <Icon name={n} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {t.kind === 'payment' && isDebit && (
            <div>
              <label className="lbl" htmlFor="editor-debit-bank">
                屬於哪個銀行帳戶
              </label>
              <select id="editor-debit-bank" className="select" value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
                <option value="">還沒指定（不算進任何帳戶）</option>
                {payers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="range-help" style={{ marginTop: 8 }}>
                用金融卡付的錢直接從這個帳戶扣（不像信用卡先記為預扣）。記帳時它會出現在這個銀行底下；匯入 LINE Pay 消費時也可以選它。
              </p>
            </div>
          )}

          {t.kind === 'payment' && isCardType && (
            <div className="card-fields">
              <div>
                <label className="lbl" htmlFor="editor-last4">
                  卡號末四碼（選填）
                </label>
                <input
                  id="editor-last4"
                  className="field num"
                  value={last4}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={4}
                  placeholder="1234"
                  autoComplete="off"
                  onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                />
              </div>
              <div>
                <label className="lbl" htmlFor="editor-bank">
                  發卡銀行（選填）
                </label>
                <input id="editor-bank" className="field" value={bank} maxLength={20} placeholder="例如：台新" autoComplete="off" onChange={(e) => setBank(e.target.value)} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="lbl" htmlFor="editor-payfrom">
                  屬於哪個銀行帳戶
                </label>
                <select id="editor-payfrom" className="select" value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
                  <option value="">還沒指定</option>
                  {payers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <p className="range-help" style={{ gridColumn: '1 / -1' }}>
                刷卡照樣算本月支出，記為這個銀行的「預扣」；繳卡費時才從這個銀行扣。末四碼用來對應刷卡通知與帳單，不會存完整卡號。
              </p>
            </div>
          )}

          {t.kind === 'payment' && isBindable && (
            <div>
              <span className="lbl" id="editor-cards-label">
                綁定的卡片（可以多張）
              </span>
              {bindCards.length ? (
                <div className="opt-set" role="group" aria-labelledby="editor-cards-label">
                  {bindCards.map((p) => (
                    <button type="button" key={p.id} className="opt" aria-pressed={held.includes(p.id)} onClick={() => toggleCard(p.id)}>
                      {p.name}
                      <small>{p.type === 'credit_card' ? '預扣' : '直接扣'}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="range-help">還沒有信用卡或金融卡，請先新增一張卡。</p>
              )}
              {held.length > 1 && (
                <div style={{ marginTop: 14 }}>
                  <label className="lbl" htmlFor="editor-notify-card">
                    付款通知記到哪張卡
                  </label>
                  <select id="editor-notify-card" className="select" value={held.includes(notifyCard) ? notifyCard : ''} onChange={(e) => setNotifyCard(e.target.value)}>
                    <option value="">還沒選（匯入時要逐筆選）</option>
                    {held.map((id) => (
                      <option key={id} value={id}>
                        {ref.payment(id).name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <p className="range-help" style={{ marginTop: 8 }}>
                記帳時用這個付款方式，會用上次刷的那張卡，要換再點一下。信用卡記為預扣；金融卡直接從它的帳號扣。
                {held.length === 1 ? '只綁一張卡時，付款通知就記到這張。' : ''}
              </p>
            </div>
          )}

          {t.kind === 'payment' && tracksBalance && (
            <div className={isNew ? '' : 'card-fields'}>
              {!isNew && (
                <div>
                  <label className="lbl" htmlFor="editor-start">
                    從哪天開始算
                  </label>
                  <input id="editor-start" className="field" type="date" max={today} value={startDate} onChange={(e) => e.target.value && setStartDate(e.target.value > today ? today : e.target.value)} />
                </div>
              )}
              <div>
                <label className="lbl" htmlFor="editor-amount">
                  {isNew ? `${amountLabel}（選填）` : isCardType ? '那天還沒繳的卡費' : '那天有多少'}
                </label>
                <input
                  id="editor-amount"
                  className="field num"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder={isNew ? '之後再填' : '空白＝不計算餘額'}
                  autoComplete="off"
                  value={startAmount}
                  onChange={(e) => setStartAmount(digits(e.target.value))}
                />
              </div>
              <p className="range-help" style={{ gridColumn: '1 / -1', marginTop: 8 }}>
                {isNew ? '從今天開始算餘額；今天以前的舊紀錄不算進去。' : '這天以前的紀錄不算進餘額，但照樣在明細和統計裡。'}
              </p>
            </div>
          )}

          {t.kind === 'salary' && (
            <div>
              <span className="lbl">每月金額</span>
              <Seg
                label="固定或變動"
                options={[
                  { value: 'fixed', label: '固定' },
                  { value: 'variable', label: '變動' },
                ]}
                value={nature}
                onChange={setNature}
              />
              <p className="range-help" style={{ marginTop: 8 }}>
                {nature === 'fixed' ? '新增下個月薪資單時，沿用上一張的金額。' : '新增下個月薪資單時從 0 開始，再填這個月實際的金額。'}
              </p>
            </div>
          )}

          {!isNew && (
            <label className="switch-row" htmlFor="editor-active">
              <span>使用中</span>
              <span className="switch">
                <input id="editor-active" type="checkbox" role="switch" checked={active} onChange={(e) => setActive(e.target.checked)} />
                <span />
              </span>
            </label>
          )}

          <p className="form-err" role="alert">
            {err}
          </p>
          <button type="submit" className="btn-primary" disabled={saving || !name.trim()}>
            {isNew ? '新增' : '儲存'}
          </button>
        </form>
      )}
    </BottomSheet>
  )
}
