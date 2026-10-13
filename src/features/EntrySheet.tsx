import { useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../db/db'
import { DEFAULT_CATEGORY_ID, DEFAULT_PAYMENT_METHOD_ID, SALARY_CATEGORY_ID } from '../db/defaults'
import { useBalances, useSetting } from '../db/hooks'
import {
  addTransaction,
  deleteEntry,
  LAST_KEYS,
  MERCHANT_MAX,
  MoneyError,
  NOTE_MAX,
  recentMerchants,
  restoreTransaction,
  transferFee,
  updateTransaction,
  type TxInput,
} from '../db/repo'
import type { CategoryType, PaymentMethod, TimeSource, TxType } from '../db/types'
import { defaultPay, describePay, isAsset, isCard, isMethod, payGroups, payKey, type PayOption } from '../lib/accounts'
import { dayLabel, fromYmd, timeLabel, toYmd } from '../lib/dates'
import { applyKey, fmt } from '../lib/money'
import { requestPersistentStorage } from '../pwa/pwa'
import { BottomSheet } from '../ui/BottomSheet'
import { Icon } from '../ui/Icon'
import { useRefData } from '../ui/refData'
import { Seg } from '../ui/Seg'
import { useToast } from '../ui/Toast'
import { useCloseGuard, useDirtyCheck, useDiscardAsking } from '../ui/discard'
import { AccountPicker, allowedIn, PayPicker, type PickRole } from './accounts/AccountPicker'

interface Draft {
  type: TxType
  amount: string
  categoryId: string
  /** Expense: account or way to pay. Income: the account it went into. Transfer: the source account. */
  paymentMethodId: string
  /** Expense paid with 轉帳 / a 行動支付 bound to an account: the account the money left (D-120, D-125). */
  sourceAccountId: string
  /** Expense paid with a 行動支付 bound to a card: the card charged (D-125). */
  cardId: string
  /** Transfer: the destination account (a card = paying its bill, D-119). */
  toAccountId: string
  /** Transfer fee digits (D-121). */
  fee: string
  showFee: boolean
  date: string
  /** "HH:MM" (D-99). */
  time: string
  /** D-100: shown next to the time until the user changes it. */
  timeSource?: TimeSource
  merchant: string
  note: string
  showNote: boolean
}

/** Everything the user can change; the snapshot taken on open is compared with it (D-101). */
const fieldsOf = (d: Draft) =>
  JSON.stringify([
    d.type,
    d.amount,
    d.type === 'transfer' ? '' : d.categoryId,
    d.paymentMethodId,
    d.type === 'expense' ? [d.sourceAccountId, d.cardId] : '',
    d.type === 'transfer' ? [d.toAccountId, d.fee] : '',
    d.date,
    d.time,
    d.type === 'transfer' ? '' : d.merchant.trim(),
    d.note.trim(),
  ])

export interface EntryPrefill {
  /** D-115: a new entry on this day; the time defaults to the current clock time. */
  date?: string
  amount?: number
  merchant?: string
  categoryId?: string
  paymentMethodId?: string
  /** D-123: start as a transfer (互轉 / 繳卡費) between these accounts. */
  type?: TxType
  fromAccountId?: string
  toAccountId?: string
}

const KIND_OPTIONS = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '互轉' },
] as const

const KEYS: { k: string; label?: string; cls?: string }[] = [
  { k: '1' }, { k: '2' }, { k: '3' }, { k: 'back', cls: 'fn' },
  { k: '4' }, { k: '5' }, { k: '6' }, { k: 'clear', label: '清除', cls: 'fn' },
  { k: '7' }, { k: '8' }, { k: '9' },
  { k: '00' }, { k: '0', cls: 'zero' },
]

const payIcon = (p: PaymentMethod) => (isCard(p) || p.type === 'debit_card' ? 'card' : p.type === 'bank' ? 'bank' : isMethod(p) ? 'out' : 'wallet')

export function EntrySheet({
  open,
  editId,
  onClose,
  onUsePayslip,
  prefill,
  banner,
  saveNew,
}: {
  open: boolean
  editId: string | null
  onClose: () => void
  onUsePayslip: () => void
  /** New entry pre-filled from elsewhere (D-109: a planned expense; D-123: a transfer or bill payment). */
  prefill?: EntryPrefill | null
  /** One line shown above the amount (D-109). */
  banner?: string | null
  /** Replaces the plain "add" save for a new entry (D-109: add + link in one transaction). */
  saveNew?: ((input: TxInput) => Promise<void>) | null
}) {
  const ref = useRefData()
  const toast = useToast()
  const balances = useBalances()
  const lastPay = useSetting<string>(LAST_KEYS.expense, DEFAULT_PAYMENT_METHOD_ID)
  const lastInto = useSetting<string>(LAST_KEYS.income, '')
  const lastSource = useSetting<string>(LAST_KEYS.source, '')
  const lastFrom = useSetting<string>(LAST_KEYS.from, '')
  const lastTo = useSetting<string>(LAST_KEYS.to, '')
  /** Q109 B: the card each 行動支付 used last time. */
  const walletCards = useSetting<Record<string, string>>(LAST_KEYS.walletCards, {})
  const [draft, setDraft] = useState<Draft | null>(null)
  const [feeRecord, setFeeRecord] = useState(false)
  const [saving, setSaving] = useState(false)
  const [typing, setTyping] = useState(false)
  const [pick, setPick] = useState<PickRole | 'pay' | null>(null)
  const [merchantFocused, setMerchantFocused] = useState(false)
  const [suggestions, setSuggestions] = useState<{ merchant: string; categoryId: string }[]>([])
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const amtRef = useRef<HTMLSpanElement | null>(null)
  const amtWrapRef = useRef<HTMLDivElement | null>(null)
  const merchantRef = useRef<HTMLInputElement | null>(null)
  const noteRef = useRef<HTMLInputElement | null>(null)
  const feeRef = useRef<HTMLInputElement | null>(null)
  const opened = useRef('')
  /** The stored date/time and its marker: the marker stays only while both are unchanged (D-100). */
  const openedAt = useRef<{ date: string; time: string; timeSource?: TimeSource }>({ date: '', time: '' })
  const guard = useCloseGuard('entry')
  // D-125: ways to pay, grouped under the account each one draws on.
  const groups = useMemo(() => payGroups(ref.payments), [ref.payments])
  useDirtyCheck('entry', open, () => !!draft && !saving && fieldsOf(draft) !== opened.current)
  const requestClose = () => guard(onClose)
  const asking = useDiscardAsking()

  const activeCategory = (type: CategoryType, preferred: string) => {
    const ok = ref.categories.find((c) => c.id === preferred && c.type === type && c.isActive)
    return ok ? ok.id : (ref.categories.find((c) => c.type === type && c.isActive)?.id ?? '')
  }
  /** An expense starts with the way to pay last used (D-20), with its account (D-125). */
  const payFields = (methodId: string) => {
    const o = defaultPay(groups, methodId, lastSource, walletCards?.[methodId])
    return { paymentMethodId: o?.paymentMethodId ?? '', sourceAccountId: o?.sourceAccountId ?? '', cardId: o?.cardId ?? '' }
  }
  /** The first of `preferred` allowed in `role`, else the first allowed account (D-120: remembered per role). */
  const pickFor = (role: PickRole, preferred: (string | undefined)[], exclude?: string) => {
    for (const id of preferred) {
      const p = id ? ref.payments.find((x) => x.id === id) : undefined
      if (p && p.isActive && allowedIn(role, p, exclude)) return p.id
    }
    // Nothing remembered yet: money usually moves from (or into) a bank account first.
    const ok = ref.payments.filter((p) => p.isActive && allowedIn(role, p, exclude))
    return (ok.find((p) => p.type === 'bank') ?? ok[0])?.id ?? ''
  }

  // Build a fresh draft every time the sheet opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    keyed.current = false
    setSaving(false)
    setTyping(false)
    setPick(null)
    setSuggestions([])
    setFeeRecord(false)
    const start = (dr: Draft) => {
      opened.current = fieldsOf(dr)
      openedAt.current = { date: dr.date, time: dr.time, timeSource: dr.timeSource }
      setDraft(dr)
    }
    if (editId) {
      // Clear first so a quick tap on save can never write the previous draft into this record.
      setDraft(null)
      Promise.all([db.transactions.get(editId), transferFee(editId)]).then(([t, fee]) => {
        if (cancelled) return
        if (!t) {
          toast('這筆紀錄已不存在', { kind: 'error' })
          onClose()
          return
        }
        const at = new Date(t.occurredAt)
        setFeeRecord(!!t.feeOf)
        start({
          type: t.type,
          amount: String(t.amount),
          categoryId: t.categoryId,
          paymentMethodId: t.paymentMethodId,
          sourceAccountId: t.sourceAccountId ?? '',
          cardId: t.cardId ?? '',
          toAccountId: t.toAccountId ?? '',
          fee: fee ? String(fee) : '',
          showFee: fee > 0,
          date: toYmd(at),
          time: timeLabel(at),
          timeSource: t.timeSource,
          merchant: t.merchant,
          note: t.note,
          showNote: !!t.note,
        })
      }, () => {
        if (cancelled) return
        toast('讀取這筆紀錄失敗，請再試一次', { kind: 'error' })
        onClose()
      })
    } else {
      const now = new Date()
      const type: TxType = prefill?.type ?? 'expense'
      const from = pickFor('from', [prefill?.fromAccountId, lastFrom])
      const to = pickFor('to', [prefill?.toAccountId, lastTo], from)
      start({
        type,
        amount: prefill?.amount ? String(prefill.amount) : '',
        categoryId: type === 'transfer' ? '' : activeCategory(type, prefill?.categoryId ?? DEFAULT_CATEGORY_ID[type]),
        ...payFields(prefill?.paymentMethodId ?? lastPay),
        ...(type === 'transfer' ? { paymentMethodId: from } : type === 'income' ? { paymentMethodId: pickFor('into', [lastInto]) } : {}),
        toAccountId: to,
        fee: '',
        showFee: false,
        // A day chosen on the calendar (never later than today), at the current clock time (D-115).
        date: prefill?.date && prefill.date <= toYmd(now) ? prefill.date : toYmd(now),
        time: timeLabel(now),
        merchant: prefill?.merchant ?? '',
        note: '',
        showNote: false,
      })
    }
    return () => {
      cancelled = true
    }
    // Only when the sheet opens or switches record; reference data is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId])

  // D-23: recent merchants while typing in the merchant field.
  useEffect(() => {
    if (!draft || draft.type === 'transfer' || !merchantFocused || !draft.merchant.trim()) {
      setSuggestions([])
      return
    }
    let stale = false
    const t = window.setTimeout(() => {
      recentMerchants(draft.merchant, draft.type).then(
        (s) => !stale && setSuggestions(s),
        () => !stale && setSuggestions([]),
      )
    }, 120)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
  }, [draft?.merchant, draft?.type, merchantFocused]) // eslint-disable-line react-hooks/exhaustive-deps

  const amount = draft ? parseInt(draft.amount || '0', 10) : 0
  const fee = draft ? parseInt(draft.fee || '0', 10) : 0

  const chips = useMemo(() => {
    if (!draft || draft.type === 'transfer') return []
    return ref.categories.filter((c) => c.type === draft.type && (c.isActive || c.id === draft.categoryId))
  }, [ref.categories, draft])

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d))

  /** Switching kind starts each kind where the last entry of that kind did (D-120). */
  const switchType = (type: TxType) => {
    if (!draft || type === draft.type) return
    if (type === 'transfer') {
      const from = pickFor('from', [isAsset(ref.payment(draft.paymentMethodId)) ? draft.paymentMethodId : undefined, lastFrom])
      patch({ type, paymentMethodId: from, toAccountId: pickFor('to', [draft.toAccountId, lastTo], from) })
    } else if (type === 'income') {
      patch({ type, categoryId: activeCategory('income', DEFAULT_CATEGORY_ID.income), paymentMethodId: pickFor('into', [lastInto, draft.paymentMethodId]) })
    } else {
      patch({ type, categoryId: activeCategory('expense', DEFAULT_CATEGORY_ID.expense), ...payFields(lastPay) })
    }
  }

  const replay = (el: HTMLElement | null, cls: string) => {
    if (!el) return
    el.classList.remove(cls)
    void el.offsetWidth
    el.classList.add(cls)
  }

  // Pop the number only for keypad input, not when a draft is loaded.
  const keyed = useRef(false)
  // Functional update: fast taps can land before React re-renders, so never read `draft` here.
  const press = (k: string) => {
    keyed.current = true
    setDraft((d) => {
      if (!d) return d
      const next = applyKey(d.amount, k)
      return next === undefined || next === d.amount ? d : { ...d, amount: next }
    })
  }
  useEffect(() => {
    if (keyed.current) replay(amtRef.current, 'bump')
    keyed.current = false
  }, [draft?.amount])

  const toCard = !!draft && draft.type === 'transfer' && isCard(ref.payment(draft.toAccountId))

  const save = async () => {
    if (!draft || saving) return
    if (!amount) {
      replay(amtWrapRef.current, 'shake')
      return
    }
    setSaving(true)
    const input: TxInput = {
      type: draft.type,
      amount,
      merchant: draft.merchant,
      categoryId: draft.type === 'transfer' ? '' : draft.categoryId,
      paymentMethodId: draft.paymentMethodId,
      date: draft.date,
      time: draft.time,
      note: draft.note,
      ...(draft.type === 'transfer' ? { toAccountId: draft.toAccountId, fee: draft.showFee ? fee : 0 } : {}),
      ...(draft.type === 'expense' && draft.sourceAccountId ? { sourceAccountId: draft.sourceAccountId } : {}),
      ...(draft.type === 'expense' && draft.cardId ? { cardId: draft.cardId } : {}),
    }
    try {
      if (editId) {
        await updateTransaction(editId, input)
        toast('已更新')
      } else if (saveNew) {
        await saveNew(input)
        toast(`已記下 NT$ ${fmt(amount)}，並對應必要支出`)
      } else {
        await addTransaction(input)
        toast(
          draft.type === 'transfer'
            ? toCard
              ? `已繳卡費 NT$ ${fmt(amount)}，不算支出`
              : `已互轉 NT$ ${fmt(amount)}，不算收支`
            : `已記下${draft.type === 'income' ? '收入' : ''} NT$ ${fmt(amount)}`,
        )
        void requestPersistentStorage()
      }
      onClose()
    } catch (e) {
      // Keep the sheet open with everything the user typed (spec 0.15).
      toast(e instanceof MoneyError ? e.message : '沒有存到，請再試一次', { kind: 'error' })
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!editId || saving) return
    setSaving(true)
    try {
      const deleted = await deleteEntry(editId)
      onClose()
      toast(`已刪除 ${deleted.length > 1 ? '互轉和手續費' : '1 筆'}`, {
        undo: () => {
          restoreTransaction(deleted).then(
            () => toast('已復原'),
            () => toast('復原失敗，請再試一次', { kind: 'error' }),
          )
        },
      })
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '刪除失敗，請再試一次', { kind: 'error' })
      setSaving(false)
    }
  }

  // Hardware keyboard (desktop testing, iPad keyboards).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (asking || pick) return
      const tag = (document.activeElement?.tagName ?? '').toUpperCase()
      const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return
        e.preventDefault() // handled here: page-level Esc must not also act on it
        if (inField) (document.activeElement as HTMLElement).blur()
        else requestClose()
        return
      }
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return
      // Let Enter/Space activate a focused button (e.g. 取消) instead of saving.
      if (e.key === 'Enter' && tag === 'BUTTON') return
      if (/^[0-9]$/.test(e.key)) {
        press(e.key)
        e.preventDefault()
      } else if (e.key === 'Backspace') {
        press('back')
        e.preventDefault()
      } else if (e.key === 'Enter') {
        void save()
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onFieldFocus = (isMerchant: boolean) => {
    setTyping(true)
    if (isMerchant) setMerchantFocused(true)
  }
  const onFieldBlur = (isMerchant: boolean) => {
    if (isMerchant) setMerchantFocused(false)
    window.setTimeout(() => {
      const a = document.activeElement
      if (a !== merchantRef.current && a !== noteRef.current && a !== feeRef.current) setTyping(false)
    }, 60)
  }

  /** "餘額 52,300" / "預扣 8,320" / "尚未設定餘額" under an account's name. */
  const balanceLine = (id: string) => {
    const p = ref.payment(id)
    if (isMethod(p)) return ''
    const b = balances?.get(id)
    if (b === undefined) return '尚未設定餘額'
    return `${isCard(p) ? '預扣' : '餘額'} ${fmt(b)}`
  }

  const onPick = (id: string) => {
    if (!draft || !pick) return
    if (pick === 'to') {
      const card = ref.payment(id)
      const pending = balances?.get(id) ?? 0
      // D-119: paying a card bill starts with the whole 預扣 (when nothing is typed yet).
      return patch({ toAccountId: id, ...(isCard(card) && !amount && pending > 0 ? { amount: String(pending) } : {}) })
    }
    if (pick === 'from') return patch({ paymentMethodId: id, ...(id === draft.toAccountId ? { toAccountId: pickFor('to', [lastTo], id) } : {}) })
    patch({ paymentMethodId: id })
  }

  const today = toYmd(new Date())
  const title = editId ? '編輯紀錄' : '記一筆'
  const pickValue = !draft || !pick ? '' : pick === 'to' ? draft.toAccountId : draft.paymentMethodId
  const recent = { into: [lastInto], from: [lastFrom], to: [lastTo] }
  const payChoice = draft ? { paymentMethodId: draft.paymentMethodId, sourceAccountId: draft.sourceAccountId || undefined, cardId: draft.cardId || undefined } : null
  const pay = payChoice ? describePay(payChoice, (id) => ref.payments.find((p) => p.id === id)) : null
  const onPay = (o: PayOption) => patch({ paymentMethodId: o.paymentMethodId, sourceAccountId: o.sourceAccountId ?? '', cardId: o.cardId ?? '' })

  const dateTimePills = draft && (
    <>
      <label className={'pill' + (draft.date !== today ? ' on' : '')} htmlFor="f-date">
        <Icon name="cal" />
        <span>{dayLabel(fromYmd(draft.date), { short: true })}</span>
        <input
          id="f-date"
          type="date"
          className="pill-input"
          max={today}
          value={draft.date}
          aria-label="日期"
          onClick={(e) => {
            try {
              e.currentTarget.showPicker()
            } catch {
              /* not supported: native tap still opens the picker */
            }
          }}
          onChange={(e) => {
            const v = e.target.value
            if (!v) return
            const date = v > today ? today : v
            // D-99: the chosen time stays; on today it can't be later than now.
            const nowHm = timeLabel(new Date())
            // A new date makes the time the user's own, as the save does (D-100).
            patch(date === today && draft.time > nowHm ? { date, time: nowHm, timeSource: undefined } : { date, timeSource: date === openedAt.current.date && draft.time === openedAt.current.time ? openedAt.current.timeSource : undefined })
          }}
        />
      </label>
      <label className={'pill' + (draft.timeSource ? ' approx' : '')} htmlFor="f-time">
        <Icon name="clock" />
        <span className="num-ui">{draft.time}</span>
        {draft.timeSource && <small>{draft.timeSource === 'notification' ? '通知時間' : '時間未知'}</small>}
        <input
          id="f-time"
          type="time"
          className="pill-input"
          value={draft.time}
          aria-label="時間"
          onClick={(e) => {
            try {
              e.currentTarget.showPicker()
            } catch {
              /* not supported: native tap still opens the picker */
            }
          }}
          onChange={(e) => {
            const v = e.target.value
            if (!/^\d{2}:\d{2}$/.test(v)) return
            const nowHm = timeLabel(new Date())
            patch({ time: draft.date === today && v > nowHm ? nowHm : v, timeSource: undefined })
          }}
        />
      </label>
    </>
  )

  const notePill = draft && (
    <button
      type="button"
      className={'pill' + (draft.note.trim() ? ' on' : '')}
      onClick={() => {
        patch({ showNote: true })
        window.setTimeout(() => noteRef.current?.focus(), 0)
      }}
    >
      <Icon name="note" />
      <span>備註</span>
    </button>
  )

  return (
    <BottomSheet
      open={open}
      onClose={requestClose}
      escClose={false}
      labelledBy="entry-title"
      sheetRef={sheetRef}
      className={typing ? 'typing' : undefined}
      head={
        <div className="sheet-bar">
          <button type="button" className="txt-btn" onClick={requestClose}>
            取消
          </button>
          <h2 className="sr" id="entry-title">
            {title}
          </h2>
          {draft && !feeRecord ? <Seg label="類型" className="kind-seg" options={KIND_OPTIONS} value={draft.type} onChange={switchType} /> : <span />}
          {editId ? (
            <button type="button" className="del-btn" aria-label="刪除這筆" onClick={remove} disabled={saving}>
              <Icon name="trash" />
            </button>
          ) : (
            <span />
          )}
        </div>
      }
    >
      {draft && (
        <>
          {banner && (
            <p className="entry-banner">
              <Icon name="link" />
              {banner}
            </p>
          )}
          {feeRecord && (
            <p className="entry-banner">
              <Icon name="swap" />
              這是一筆互轉的手續費，日期跟著那筆互轉；刪除那筆互轉時會一起刪除。
            </p>
          )}
          <div className="amt-wrap" ref={amtWrapRef}>
            <span className="cur">NT$</span>
            <span
              ref={amtRef}
              className={'amt num' + (!amount ? ' zero' : '') + (amount && draft.type === 'income' ? ' income' : '')}
              aria-live="polite"
              aria-label={`金額 ${fmt(amount)} 元`}
            >
              {fmt(amount)}
            </span>
          </div>

          {draft.type === 'transfer' ? (
            <>
              {/* D-117 / D-119: a transfer is never income or expense; to a card it pays the bill. */}
              <p className="move-cap">
                {toCard ? (
                  <>
                    繳卡費<span className="move-tag">不算支出</span>
                  </>
                ) : (
                  '帳戶之間互轉，不算收入也不算支出'
                )}
              </p>
              <div className="move">
                <button type="button" className="mv" onClick={() => setPick('from')}>
                  <small>從</small>
                  <b>{ref.payment(draft.paymentMethodId).name}</b>
                  <span className="num-ui">{balanceLine(draft.paymentMethodId)}</span>
                </button>
                <button
                  type="button"
                  className="swap-btn"
                  aria-label="對調轉出和轉入"
                  disabled={toCard}
                  onClick={() => patch({ paymentMethodId: draft.toAccountId, toAccountId: draft.paymentMethodId })}
                >
                  <Icon name="swap" />
                </button>
                <button type="button" className="mv" onClick={() => setPick('to')}>
                  <small>到</small>
                  <b>{ref.payment(draft.toAccountId).name}</b>
                  <span className="num-ui">{balanceLine(draft.toAccountId)}</span>
                </button>
              </div>
              {toCard && (balances?.get(draft.toAccountId) ?? 0) > 0 && (
                <div className="paycard">
                  <span>
                    目前預扣 <b className="num">{fmt(balances!.get(draft.toAccountId)!)}</b>
                  </span>
                  {amount !== balances!.get(draft.toAccountId) && (
                    <button type="button" onClick={() => patch({ amount: String(balances!.get(draft.toAccountId)) })}>
                      帶入全額
                    </button>
                  )}
                </div>
              )}
              <div className="meta">
                {dateTimePills}
                <button
                  type="button"
                  className={'pill' + (draft.showFee ? ' on' : '')}
                  onClick={() => {
                    patch({ showFee: !draft.showFee })
                    if (!draft.showFee) window.setTimeout(() => feeRef.current?.focus(), 0)
                  }}
                >
                  <Icon name="coin" />
                  <span>手續費{draft.showFee && fee ? ` ${fmt(fee)}` : ''}</span>
                </button>
                {notePill}
              </div>
              {draft.showFee && (
                <label className="fee-row" htmlFor="f-fee">
                  <span>手續費</span>
                  <small>另記一筆「其他」支出，從 {ref.payment(draft.paymentMethodId).name} 扣</small>
                  <input
                    ref={feeRef}
                    id="f-fee"
                    className="num"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="0"
                    autoComplete="off"
                    enterKeyHint="done"
                    value={draft.fee}
                    onChange={(e) => patch({ fee: e.target.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 8) })}
                    onFocus={() => onFieldFocus(false)}
                    onBlur={() => onFieldBlur(false)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        e.currentTarget.blur()
                      }
                    }}
                  />
                </label>
              )}
            </>
          ) : (
            <>
              <label htmlFor="f-merchant" className="sr">
                {draft.type === 'income' ? '來源' : '商家'}
              </label>
              <input
                ref={merchantRef}
                id="f-merchant"
                className="merchant"
                placeholder={draft.type === 'income' ? '來源（選填）' : '商家（選填）'}
                autoComplete="off"
                enterKeyHint="done"
                maxLength={MERCHANT_MAX}
                value={draft.merchant}
                onChange={(e) => patch({ merchant: e.target.value })}
                onFocus={() => onFieldFocus(true)}
                onBlur={() => onFieldBlur(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.currentTarget.blur()
                  }
                }}
              />
              {suggestions.length > 0 && (
                <div className="suggest" aria-label="最近用過的商家">
                  {suggestions.map((s) => (
                    <button
                      type="button"
                      key={s.merchant}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => {
                        const cat = ref.categories.find((c) => c.id === s.categoryId && c.isActive && c.type === draft.type)
                        patch({ merchant: s.merchant, ...(cat ? { categoryId: cat.id } : {}) })
                        setSuggestions([])
                        merchantRef.current?.blur()
                      }}
                    >
                      <Icon name={ref.category(s.categoryId).icon} />
                      {s.merchant}
                      <small>{ref.category(s.categoryId).name}</small>
                    </button>
                  ))}
                </div>
              )}

              {/* D-127: icon tiles with the name under them (the name wraps rather than being cut). */}
              <div className="chips" role="group" aria-label="分類">
                {chips.map((c) => (
                  <button type="button" key={c.id} className="chip" aria-pressed={c.id === draft.categoryId} onClick={() => patch({ categoryId: c.id })}>
                    <span className="ico">
                      <Icon name={c.icon} />
                    </span>
                    <span className="name">{c.name}</span>
                  </button>
                ))}
              </div>

              {/* D-65: salary can be recorded with its full payslip instead. */}
              {!editId && draft.type === 'income' && draft.categoryId === SALARY_CATEGORY_ID && (
                <button type="button" className="payslip-hint" onClick={onUsePayslip}>
                  <Icon name="receipt" />
                  用薪資單記錄明細 ›
                </button>
              )}

              <div className="meta">
                {/* D-121: a fee is dated with its transfer, so its date is changed there. */}
                {!feeRecord && dateTimePills}
                <button type="button" className="pill pill-pay" onClick={() => setPick(draft.type === 'income' ? 'into' : 'pay')}>
                  {draft.type === 'income' ? <small>存入</small> : <Icon name={payIcon(ref.payment(draft.paymentMethodId))} />}
                  <span>{draft.type === 'income' || !pay ? ref.payment(draft.paymentMethodId).name : pay.label}</span>
                </button>
                {notePill}
              </div>
            </>
          )}

          {draft.showNote && (
            <div className="note-row">
              <label htmlFor="f-note" className="sr">
                備註
              </label>
              <input
                ref={noteRef}
                id="f-note"
                className="field"
                placeholder="寫點備註"
                maxLength={NOTE_MAX}
                autoComplete="off"
                enterKeyHint="done"
                value={draft.note}
                onChange={(e) => patch({ note: e.target.value })}
                onFocus={() => onFieldFocus(false)}
                onBlur={() => onFieldBlur(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.currentTarget.blur()
                  }
                }}
              />
            </div>
          )}

          <div className="keypad">
            {KEYS.map((key) => (
              <button
                type="button"
                key={key.k}
                className={'key' + (key.cls ? ' ' + key.cls : '')}
                aria-label={key.k === 'back' ? '刪除一位' : undefined}
                onClick={() => press(key.k)}
              >
                {key.k === 'back' ? <Icon name="backspace" /> : (key.label ?? key.k)}
              </button>
            ))}
            <button type="button" className={'key save' + (!amount ? ' off' : '')} onClick={save} disabled={saving}>
              <Icon name="check" />
              <span>{editId ? '更新' : '儲存'}</span>
            </button>
          </div>
          <button type="button" className="alt-save" onPointerDown={(e) => e.preventDefault()} onClick={save} disabled={saving}>
            {editId ? '更新' : '儲存'}
          </button>
        </>
      )}
      <PayPicker
        open={pick === 'pay'}
        groups={groups}
        value={payChoice ? payKey(payChoice) : ''}
        recent={defaultPay(groups, lastPay, lastSource, walletCards?.[lastPay])}
        balances={balances}
        onPick={onPay}
        onClose={() => setPick(null)}
      />
      <AccountPicker
        open={pick !== null && pick !== 'pay'}
        role={pick === null || pick === 'pay' ? 'into' : pick}
        value={pickValue}
        recent={pick && pick !== 'pay' ? recent[pick] : []}
        exclude={pick === 'to' ? draft?.paymentMethodId : undefined}
        balances={balances}
        onPick={onPick}
        onClose={() => setPick(null)}
      />
    </BottomSheet>
  )
}
