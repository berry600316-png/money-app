import { useEffect, useRef, useState } from 'react'
import { addCategory, addPaymentMethod, MoneyError, NAME_MAX, updateCategory, updatePaymentMethod } from '../db/repo'
import { PAYMENT_TYPE_LABELS, type PaymentType, type SalaryNature } from '../db/types'
import { useSalaryItems } from '../db/hooks'
import { addSalaryItem, updateSalaryItem } from '../db/salary'
import { Seg } from '../ui/Seg'
import { BottomSheet } from '../ui/BottomSheet'
import { CATEGORY_ICON_CHOICES, Icon, ICON_LABELS } from '../ui/Icon'
import { useRefData } from '../ui/refData'
import { useToast } from '../ui/Toast'
import type { EditorTarget } from './ManagePage'
import { useCloseGuard, useDirtyCheck } from '../ui/discard'

const PAYMENT_TYPES = Object.keys(PAYMENT_TYPE_LABELS) as PaymentType[]

/** Create or edit a category / payment method (D-11..D-15). */
export function EditorSheet({ target, onClose }: { target: EditorTarget | null; onClose: () => void }) {
  const ref = useRefData()
  const toast = useToast()
  const open = target !== null
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<string>(CATEGORY_ICON_CHOICES[0])
  const [payType, setPayType] = useState<PaymentType>('other')
  const [active, setActive] = useState(true)
  const [nature, setNature] = useState<SalaryNature>('fixed')
  const [bank, setBank] = useState('')
  const [last4, setLast4] = useState('')
  const salaryItems = useSalaryItems()
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  // Keep showing the last target while the sheet slides away.
  const [shown, setShown] = useState<EditorTarget | null>(null)

  // D-101: snapshot the fields once they are loaded, compare on close.
  const fields = JSON.stringify([name.trim(), icon, payType, active, nature, bank.trim(), last4])
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
      setIcon(c?.icon ?? CATEGORY_ICON_CHOICES[0])
      setActive(c?.isActive ?? true)
    } else if (target.kind === 'payment') {
      const p = target.id ? ref.payments.find((x) => x.id === target.id) : undefined
      setName(p?.name ?? '')
      setPayType(p?.type ?? 'other')
      setActive(p?.isActive ?? true)
      setBank(p?.bank ?? '')
      setLast4(p?.cardLast4 ?? '')
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
  const noun =
    t?.kind === 'payment'
      ? '付款方式'
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
        if (t.id) await updateCategory(t.id, { name, isActive: active })
        else await addCategory({ name, type: t.type, icon })
      } else if (t.kind === 'payment') {
        if (t.id) await updatePaymentMethod(t.id, { name, type: payType, isActive: active, bank, cardLast4: last4 })
        else await addPaymentMethod({ name, type: payType, bank, cardLast4: last4 })
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
              placeholder={t.kind === 'payment' ? '例如：台新卡、LINE Pay' : t.kind === 'salary' ? '例如：交通津貼、三節獎金' : '例如：寵物、學習'}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {t.kind === 'category' && isNew && (
            <div>
              <span className="lbl" id="icon-label">
                圖示（新增後不能更改）
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

          {t.kind === 'payment' && (
            <div>
              <label className="lbl" htmlFor="editor-type">
                類型
              </label>
              <select id="editor-type" className="select" value={payType} onChange={(e) => setPayType(e.target.value as PaymentType)}>
                {PAYMENT_TYPES.map((pt) => (
                  <option key={pt} value={pt}>
                    {PAYMENT_TYPE_LABELS[pt]}
                  </option>
                ))}
              </select>
            </div>
          )}

          {t.kind === 'payment' && payType === 'credit_card' && (
            <div className="card-fields">
              <div>
                <label className="lbl" htmlFor="editor-bank">
                  發卡銀行
                </label>
                <input id="editor-bank" className="field" value={bank} maxLength={20} placeholder="例如：台新" autoComplete="off" onChange={(e) => setBank(e.target.value)} />
              </div>
              <div>
                <label className="lbl" htmlFor="editor-last4">
                  卡號末四碼
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
              <p className="range-help" style={{ gridColumn: '1 / -1' }}>
                用來對應刷卡通知與銀行帳單。只記末四碼，不會存完整卡號。
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
