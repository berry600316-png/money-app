import { useEffect, useState } from 'react'
import { adjustBalance, MoneyError, NOTE_MAX, setStartBalances } from '../../db/repo'
import type { PaymentMethod } from '../../db/types'
import { isCard } from '../../lib/accounts'
import { toYmd } from '../../lib/dates'
import { fmt, MAX_AMOUNT } from '../../lib/money'
import { BottomSheet } from '../../ui/BottomSheet'
import { Overlay } from '../../ui/overlay'
import { useToast } from '../../ui/Toast'

const digits = (s: string) => s.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 8)

/**
 * D-118: set the balance of several accounts at once (the one-time setup after the upgrade). Only the
 * filled ones start counting; the rest stay "尚未設定餘額".
 */
export function SetupSheet({ open, accounts, onClose }: { open: boolean; accounts: PaymentMethod[]; onClose: () => void }) {
  const toast = useToast()
  const today = toYmd(new Date())
  const [values, setValues] = useState<Record<string, string>>({})
  const [date, setDate] = useState(today)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!open) return
    setValues({})
    setDate(today)
    setSaving(false)
    // Only when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const filled = accounts.filter((a) => (values[a.id] ?? '') !== '')
  const save = async () => {
    if (saving) return
    if (!filled.length) return onClose()
    setSaving(true)
    try {
      const items = filled.map((a) => ({ id: a.id, amount: Number(values[a.id]) }))
      if (items.some((i) => i.amount > MAX_AMOUNT)) throw new MoneyError('金額太大')
      await setStartBalances(items, date)
      toast(`已設定 ${items.length} 個帳戶的餘額`)
      onClose()
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '沒有存到，請再試一次', { kind: 'error' })
      setSaving(false)
    }
  }

  return (
    <Overlay>
      <BottomSheet
        open={open}
        onClose={onClose}
        labelledBy="setup-title"
        head={
          <div className="sheet-bar">
            <button type="button" className="txt-btn" onClick={onClose}>
              取消
            </button>
            <h2 id="setup-title">設定目前餘額</h2>
            <span />
          </div>
        }
      >
        <div className="form">
          <p className="range-help">打開網銀或錢包看一眼，填實際有多少；信用卡填目前還沒繳的卡費。不確定的先空著，之後再填。</p>
          <div className="fields">
            {accounts.map((a) => (
              <label className="frow" key={a.id} htmlFor={'setup-' + a.id}>
                <span>
                  {a.name}
                  {isCard(a) && <small className="frow-sub">還沒繳的卡費</small>}
                </span>
                <input
                  id={'setup-' + a.id}
                  className="num amt-in"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="未填"
                  autoComplete="off"
                  value={values[a.id] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [a.id]: digits(e.target.value) }))}
                />
              </label>
            ))}
          </div>
          <div className="fields">
            <label className="frow" htmlFor="setup-date">
              <span>
                從哪天開始算
                <small className="frow-sub">這天以前的紀錄不算進餘額</small>
              </span>
              <input id="setup-date" type="date" max={today} value={date} onChange={(e) => e.target.value && setDate(e.target.value > today ? today : e.target.value)} />
            </label>
          </div>
          <button type="button" className="btn-primary" disabled={saving} onClick={save}>
            {filled.length ? `設定 ${filled.length} 個帳戶` : '完成'}
          </button>
        </div>
      </BottomSheet>
    </Overlay>
  )
}

/**
 * D-118: correct an account to its real balance. Not income, expense or a transfer; it only shows in
 * this account's history.
 */
export function AdjustSheet({ account, current, onClose }: { account: PaymentMethod | null; current: number; onClose: () => void }) {
  const toast = useToast()
  const open = account !== null
  const [shown, setShown] = useState<PaymentMethod | null>(null)
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!account) return
    setShown(account)
    setValue('')
    setNote('')
    setSaving(false)
  }, [account])

  const a = account ?? shown
  const card = isCard(a ?? undefined)
  const actual = value === '' ? null : Number(value)
  const diff = actual === null ? 0 : actual - current
  const save = async () => {
    if (!a || saving || actual === null) return
    setSaving(true)
    try {
      await adjustBalance(a.id, actual, note)
      toast(`已調整 ${diff > 0 ? '+' : ''}${fmt(diff)}，不算收支`)
      onClose()
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '沒有存到，請再試一次', { kind: 'error' })
      setSaving(false)
    }
  }

  return (
    <Overlay>
      <BottomSheet
        open={open}
        onClose={onClose}
        labelledBy="adjust-title"
        head={
          <div className="sheet-bar">
            <button type="button" className="txt-btn" onClick={onClose}>
              取消
            </button>
            <h2 id="adjust-title">調整{card ? '預扣' : '餘額'}</h2>
            <span />
          </div>
        }
      >
        {a && (
          <div className="form">
            <div className="fields">
              <div className="frow">
                <span>App 記的{card ? '預扣' : '餘額'}</span>
                <span className="num frow-val">{fmt(current)}</span>
              </div>
              <label className="frow" htmlFor="adjust-value">
                <span>實際{card ? '還沒繳' : '有多少'}</span>
                <input
                  id="adjust-value"
                  className="num amt-in"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder={fmt(current)}
                  autoComplete="off"
                  value={value}
                  onChange={(e) => setValue(e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 8))}
                />
              </label>
              <div className="frow">
                <span>差額</span>
                <span className={'num frow-val' + (diff ? '' : ' muted')}>
                  {diff > 0 ? '+' : ''}
                  {fmt(diff)}
                </span>
              </div>
              <label className="frow" htmlFor="adjust-note">
                <span>原因（選填）</span>
                <input id="adjust-note" type="text" maxLength={NOTE_MAX} placeholder="例如：點現金" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
            </div>
            <p className="range-help">調整只校正這個帳戶的數字，不算收入或支出，也不會出現在明細，只留在這個帳戶的紀錄裡。</p>
            <button type="button" className="btn-primary" disabled={saving || actual === null || !diff} onClick={save}>
              儲存
            </button>
          </div>
        )}
      </BottomSheet>
    </Overlay>
  )
}
