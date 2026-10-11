import { useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../db/db'
import { DEFAULT_CATEGORY_ID, DEFAULT_PAYMENT_METHOD_ID, SALARY_CATEGORY_ID } from '../db/defaults'
import { useSetting } from '../db/hooks'
import {
  addTransaction,
  deleteTransaction,
  MERCHANT_MAX,
  MoneyError,
  NOTE_MAX,
  recentMerchants,
  restoreTransaction,
  updateTransaction,
  type TxInput,
} from '../db/repo'
import type { TimeSource, TxType } from '../db/types'
import { dayLabel, fromYmd, timeLabel, toYmd } from '../lib/dates'
import { applyKey, fmt } from '../lib/money'
import { requestPersistentStorage } from '../pwa/pwa'
import { BottomSheet } from '../ui/BottomSheet'
import { Icon } from '../ui/Icon'
import { useRefData } from '../ui/refData'
import { Seg } from '../ui/Seg'
import { useToast } from '../ui/Toast'
import { useCloseGuard, useDirtyCheck, useDiscardAsking } from '../ui/discard'

interface Draft {
  type: TxType
  amount: string
  categoryId: string
  paymentMethodId: string
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
const fieldsOf = (d: Draft) => JSON.stringify([d.type, d.amount, d.categoryId, d.paymentMethodId, d.date, d.time, d.merchant.trim(), d.note.trim()])

export interface EntryPrefill {
  amount?: number
  merchant?: string
  categoryId?: string
  paymentMethodId?: string
}

const KIND_OPTIONS = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
] as const

const KEYS: { k: string; label?: string; cls?: string }[] = [
  { k: '1' }, { k: '2' }, { k: '3' }, { k: 'back', cls: 'fn' },
  { k: '4' }, { k: '5' }, { k: '6' }, { k: 'clear', label: '清除', cls: 'fn' },
  { k: '7' }, { k: '8' }, { k: '9' },
  { k: '00' }, { k: '0', cls: 'zero' },
]

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
  /** New entry pre-filled from elsewhere (D-109: a planned expense). */
  prefill?: EntryPrefill | null
  /** One line shown above the amount (D-109). */
  banner?: string | null
  /** Replaces the plain "add" save for a new entry (D-109: add + link in one transaction). */
  saveNew?: ((input: TxInput) => Promise<void>) | null
}) {
  const ref = useRefData()
  const toast = useToast()
  const lastPay = useSetting<string>('lastPaymentMethodId', DEFAULT_PAYMENT_METHOD_ID)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [typing, setTyping] = useState(false)
  const [merchantFocused, setMerchantFocused] = useState(false)
  const [suggestions, setSuggestions] = useState<{ merchant: string; categoryId: string }[]>([])
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const amtRef = useRef<HTMLSpanElement | null>(null)
  const amtWrapRef = useRef<HTMLDivElement | null>(null)
  const merchantRef = useRef<HTMLInputElement | null>(null)
  const noteRef = useRef<HTMLInputElement | null>(null)
  const opened = useRef('')
  /** The stored date/time and its marker: the marker stays only while both are unchanged (D-100). */
  const openedAt = useRef<{ date: string; time: string; timeSource?: TimeSource }>({ date: '', time: '' })
  const guard = useCloseGuard('entry')
  useDirtyCheck('entry', open, () => !!draft && !saving && fieldsOf(draft) !== opened.current)
  const requestClose = () => guard(onClose)
  const asking = useDiscardAsking()

  const activeCategory = (type: TxType, preferred: string) => {
    const ok = ref.categories.find((c) => c.id === preferred && c.type === type && c.isActive)
    return ok ? ok.id : (ref.categories.find((c) => c.type === type && c.isActive)?.id ?? '')
  }
  const activePayment = (preferred: string) => {
    const ok = ref.payments.find((p) => p.id === preferred && p.isActive)
    return ok ? ok.id : (ref.payments.find((p) => p.isActive)?.id ?? '')
  }

  // Build a fresh draft every time the sheet opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    keyed.current = false
    setSaving(false)
    setTyping(false)
    setSuggestions([])
    const start = (dr: Draft) => {
      opened.current = fieldsOf(dr)
      openedAt.current = { date: dr.date, time: dr.time, timeSource: dr.timeSource }
      setDraft(dr)
    }
    if (editId) {
      // Clear first so a quick tap on save can never write the previous draft into this record.
      setDraft(null)
      db.transactions.get(editId).then((t) => {
        if (cancelled) return
        if (!t) {
          toast('這筆紀錄已不存在', { kind: 'error' })
          onClose()
          return
        }
        const at = new Date(t.occurredAt)
        start({
          type: t.type,
          amount: String(t.amount),
          categoryId: t.categoryId,
          paymentMethodId: t.paymentMethodId,
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
      start({
        type: 'expense',
        amount: prefill?.amount ? String(prefill.amount) : '',
        categoryId: activeCategory('expense', prefill?.categoryId ?? DEFAULT_CATEGORY_ID.expense),
        paymentMethodId: activePayment(prefill?.paymentMethodId ?? lastPay),
        date: toYmd(now),
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
    if (!draft || !merchantFocused || !draft.merchant.trim()) {
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

  const chips = useMemo(() => {
    if (!draft) return []
    return ref.categories.filter((c) => c.type === draft.type && (c.isActive || c.id === draft.categoryId))
  }, [ref.categories, draft])

  const payOptions = useMemo(() => {
    if (!draft) return []
    return ref.payments.filter((p) => p.isActive || p.id === draft.paymentMethodId)
  }, [ref.payments, draft])

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d))

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

  const save = async () => {
    if (!draft || saving) return
    if (!amount) {
      replay(amtWrapRef.current, 'shake')
      return
    }
    setSaving(true)
    const input = {
      type: draft.type,
      amount,
      merchant: draft.merchant,
      categoryId: draft.categoryId,
      paymentMethodId: draft.paymentMethodId,
      date: draft.date,
      time: draft.time,
      note: draft.note,
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
        toast(`已記下${draft.type === 'income' ? '收入' : ''} NT$ ${fmt(amount)}`)
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
      const deleted = await deleteTransaction(editId)
      onClose()
      toast('已刪除 1 筆', {
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
      if (asking) return
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
      if (a !== merchantRef.current && a !== noteRef.current) setTyping(false)
    }, 60)
  }

  const today = toYmd(new Date())
  const title = editId ? '編輯紀錄' : '記一筆'

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
          {draft ? (
            <Seg
              label="收支類型"
              options={KIND_OPTIONS}
              value={draft.type}
              onChange={(type) => {
                if (type === draft.type) return
                patch({ type, categoryId: activeCategory(type, DEFAULT_CATEGORY_ID[type]) })
              }}
            />
          ) : (
            <span />
          )}
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

          <label htmlFor="f-merchant" className="sr">
            商家
          </label>
          <input
            ref={merchantRef}
            id="f-merchant"
            className="merchant"
            placeholder="商家（選填）"
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
                </button>
              ))}
            </div>
          )}

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
            <label className="pill" htmlFor="f-pay">
              <Icon name="card" />
              <span>{ref.payment(draft.paymentMethodId).name}</span>
              <select
                id="f-pay"
                className="pill-input"
                aria-label="付款方式"
                value={draft.paymentMethodId}
                onChange={(e) => patch({ paymentMethodId: e.target.value })}
              >
                {payOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
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
          </div>

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
    </BottomSheet>
  )
}
