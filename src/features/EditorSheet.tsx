import { useEffect, useState } from 'react'
import { addCategory, addPaymentMethod, MoneyError, NAME_MAX, updateCategory, updatePaymentMethod } from '../db/repo'
import { PAYMENT_TYPE_LABELS, type PaymentType } from '../db/types'
import { BottomSheet } from '../ui/BottomSheet'
import { CATEGORY_ICON_CHOICES, Icon, ICON_LABELS } from '../ui/Icon'
import { useRefData } from '../ui/refData'
import { useToast } from '../ui/Toast'
import type { EditorTarget } from './ManagePage'

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
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  // Keep showing the last target while the sheet slides away.
  const [shown, setShown] = useState<EditorTarget | null>(null)

  useEffect(() => {
    if (!target) return
    setShown(target)
    setErr('')
    setSaving(false)
    if (target.kind === 'category') {
      const c = target.id ? ref.categories.find((x) => x.id === target.id) : undefined
      setName(c?.name ?? '')
      setIcon(c?.icon ?? CATEGORY_ICON_CHOICES[0])
      setActive(c?.isActive ?? true)
    } else {
      const p = target.id ? ref.payments.find((x) => x.id === target.id) : undefined
      setName(p?.name ?? '')
      setPayType(p?.type ?? 'other')
      setActive(p?.isActive ?? true)
    }
    // Read reference data once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const t = target ?? shown
  const isNew = !t?.id
  const noun = t?.kind === 'payment' ? '付款方式' : t?.type === 'income' ? '收入分類' : '支出分類'
  const title = (isNew ? '新增' : '編輯') + noun

  const save = async () => {
    if (!t || saving) return
    setSaving(true)
    setErr('')
    try {
      if (t.kind === 'category') {
        if (t.id) await updateCategory(t.id, { name, isActive: active })
        else await addCategory({ name, type: t.type, icon })
      } else {
        if (t.id) await updatePaymentMethod(t.id, { name, type: payType, isActive: active })
        else await addPaymentMethod({ name, type: payType })
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
      onClose={onClose}
      labelledBy="editor-title"
      head={
        <div className="sheet-bar">
          <button type="button" className="txt-btn" onClick={onClose}>
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
              placeholder={t.kind === 'payment' ? '例如：台新卡、LINE Pay' : '例如：寵物、學習'}
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
