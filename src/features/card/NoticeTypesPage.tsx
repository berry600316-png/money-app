import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { deleteNoticeType, getNoticeTypes, saveNoticeType } from '../../card/cardRepo'
import { NOTICE_KEYWORD_MAX, NOTICE_KEYWORDS_MAX, NOTICE_NAME_MAX, NOTICE_TYPES_MAX, targetProblem, type NoticeType } from '../../card/noticeTypes'
import { MoneyError } from '../../db/repo'
import { isWallet, payGroups } from '../../lib/accounts'
import { ActionSheet } from '../../ui/ActionSheet'
import { BottomSheet } from '../../ui/BottomSheet'
import { useCloseGuard, useDirtyCheck } from '../../ui/discard'
import { Icon } from '../../ui/Icon'
import { Overlay } from '../../ui/overlay'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'

/** A 行動支付 and one of its cards, as one value of the「記到」select. */
const placeKey = (paymentMethodId: string, cardId: string) => `${paymentMethodId}\n${cardId}`

/**
 * D-136 / Q117: the payment notice types, opened from the import page. Each type: a name, the keywords
 * that must all be in a notice, and the 行動支付 · card it is recorded to.
 */
export function NoticeTypesPage({ backLabel, onBack }: { backLabel: string; onBack: () => void }) {
  const types = useLiveQuery(() => getNoticeTypes(), [])
  const ref = useRefData()
  /** The type being edited; null = a new one; undefined = the sheet is closed. */
  const [editing, setEditing] = useState<NoticeType | null | undefined>(undefined)
  const placeName = (t: NoticeType) => {
    const wallet = ref.payments.find((p) => p.id === t.paymentMethodId)
    const card = ref.payments.find((p) => p.id === t.cardId)
    return `${wallet?.name ?? '已刪除'} · ${card?.name ?? '已刪除'}`
  }
  const full = (types?.length ?? 0) >= NOTICE_TYPES_MAX

  return (
    <>
      <div className="page-head">
        <button type="button" className="back" onClick={onBack}>
          <Icon name="left" />
          {backLabel}
        </button>
        <h1>通知類型</h1>
        <span />
      </div>
      <p className="lead">付款通知裡同時出現某個類型的全部關鍵字，就記到它指定的卡。</p>
      <div className="nt-example">
        <b>例如</b>
        <span>
          關鍵字「LINE Pay」
          <i>→ 記到 LINE Pay · 台新信用卡</i>
        </span>
        <span>
          關鍵字「LINE Pay」＋「全聯」
          <i>→ 記到 LINE Pay · 台新金融卡</i>
        </span>
        <small>在全聯的付款記到金融卡，其他 LINE Pay 付款記到信用卡。</small>
      </div>
      <p className="lead">同時符合兩個類型時，關鍵字包含另一個的優先；分不出來或都沒符合的，匯入時會請你選。</p>

      {!full && (
        <button type="button" className="add-line" onClick={() => setEditing(null)}>
          <Icon name="plus" />
          新增通知類型
        </button>
      )}
      {types && types.length === 0 && <div className="empty">還沒有通知類型</div>}
      {types && types.length > 0 && (
        <>
          <div className="sec-head">
            <h2>已設定</h2>
            <span>
              {types.length} 個，最多 {NOTICE_TYPES_MAX} 個
            </span>
          </div>
          <div className="card">
            {types.map((t) => {
              const problem = targetProblem(t, ref.payments)
              return (
                <button type="button" className="row nt-row" key={t.id} onClick={() => setEditing(t)}>
                  <span className="row-main">
                    <span className="row-title">{t.name}</span>
                    <span className="row-sub">關鍵字：{t.keywords.map((k) => `「${k}」`).join('＋')}</span>
                    <span className="row-sub">記到：{placeName(t)}</span>
                    {problem && <span className="why">{problem}，請重新選擇記到哪張卡</span>}
                  </span>
                  <Icon name="chev" className="chev" />
                </button>
              )
            })}
          </div>
        </>
      )}
      <NoticeTypeSheet target={editing} onClose={() => setEditing(undefined)} />
    </>
  )
}

interface Draft {
  name: string
  keywords: string[]
  /** placeKey of the 行動支付 · card; '' = not chosen (or no longer usable). */
  place: string
}

function NoticeTypeSheet({ target, onClose }: { target: NoticeType | null | undefined; onClose: () => void }) {
  const ref = useRefData()
  const toast = useToast()
  const open = target !== undefined
  const [d, setD] = useState<Draft>({ name: '', keywords: [''], place: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [asking, setAsking] = useState(false)
  // Keep showing the last one while the sheet slides away.
  const [shown, setShown] = useState<NoticeType | null>(null)
  const opened = useRef('')
  // Q126 A: every card a 行動支付 / 其他 holds (「LINE Pay · 台新金融卡」), in the user's order.
  const places = payGroups(ref.payments)
    .flatMap((g) => g.options)
    .filter((o) => o.cardId && isWallet(ref.payments.find((p) => p.id === o.paymentMethodId)))

  useEffect(() => {
    if (target === undefined) return
    setShown(target)
    setBusy(false)
    setErr('')
    setAsking(false)
    const usable = target && !targetProblem(target, ref.payments)
    const next: Draft = target
      ? { name: target.name, keywords: [...target.keywords], place: usable ? placeKey(target.paymentMethodId, target.cardId) : '' }
      : { name: '', keywords: [''], place: places.length === 1 ? placeKey(places[0].paymentMethodId, places[0].cardId!) : '' }
    opened.current = JSON.stringify(next)
    setD(next)
    // Only when a new target arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  useDirtyCheck('noticeType', open, () => !busy && JSON.stringify(d) !== opened.current)
  const guard = useCloseGuard('noticeType')
  const requestClose = () => guard(onClose)

  const editingOne = open ? target : shown
  const isNew = !editingOne
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }))
  const setKeyword = (i: number, v: string) => set({ keywords: d.keywords.map((k, j) => (j === i ? v : k)) })

  const save = async () => {
    if (busy) return
    const [paymentMethodId = '', cardId = ''] = d.place.split('\n')
    if (!d.place) {
      setErr('請選擇記到哪張卡')
      return
    }
    setBusy(true)
    setErr('')
    try {
      await saveNoticeType({ ...(editingOne ? { id: editingOne.id } : {}), name: d.name, keywords: d.keywords, paymentMethodId, cardId })
      toast(isNew ? `已新增「${d.name.trim()}」` : '已儲存')
      opened.current = JSON.stringify(d)
      onClose()
    } catch (e) {
      setErr(e instanceof MoneyError ? e.message : '沒有存到，請再試一次')
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!editingOne) return
    setAsking(false)
    try {
      await deleteNoticeType(editingOne.id)
      toast(`已刪除「${editingOne.name}」`)
      opened.current = JSON.stringify(d)
      onClose()
    } catch {
      toast('刪除失敗，請再試一次', { kind: 'error' })
    }
  }

  return (
    <Overlay>
      <BottomSheet
        open={open}
        onClose={requestClose}
        labelledBy="nt-title"
        head={
          <div className="sheet-bar">
            <button type="button" className="txt-btn" onClick={requestClose}>
              取消
            </button>
            <h2 id="nt-title">{isNew ? '新增通知類型' : '編輯通知類型'}</h2>
            <span />
          </div>
        }
      >
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div>
            <label className="lbl" htmlFor="nt-name">
              名稱
            </label>
            <input
              id="nt-name"
              className="field"
              value={d.name}
              maxLength={NOTICE_NAME_MAX}
              autoComplete="off"
              enterKeyHint="done"
              placeholder="例如：LINE Pay 全聯"
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>

          <div>
            <span className="lbl field-head" id="nt-kw-label">
              關鍵字
            </span>
            <div className="nt-keywords" role="group" aria-labelledby="nt-kw-label">
              {d.keywords.map((k, i) => (
                <div className="nt-kw" key={i}>
                  <input
                    className="field"
                    value={k}
                    maxLength={NOTICE_KEYWORD_MAX}
                    autoComplete="off"
                    enterKeyHint="done"
                    placeholder={i === 0 ? '例如：LINE Pay' : '例如：全聯'}
                    aria-label={`第 ${i + 1} 個關鍵字`}
                    onChange={(e) => setKeyword(i, e.target.value)}
                  />
                  {d.keywords.length > 1 && (
                    <button type="button" className="icon-btn nt-del" aria-label={`刪除第 ${i + 1} 個關鍵字`} onClick={() => set({ keywords: d.keywords.filter((_, j) => j !== i) })}>
                      <Icon name="trash" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {d.keywords.length < NOTICE_KEYWORDS_MAX && (
              <button type="button" className="add-line" onClick={() => set({ keywords: [...d.keywords, ''] })}>
                <Icon name="plus" />
                新增關鍵字
              </button>
            )}
            <p className="range-help" style={{ marginTop: 8 }}>
              通知裡要同時出現這裡的每一個關鍵字，才算這個類型。全形半形、英文大小寫視為相同。每個最多 {NOTICE_KEYWORD_MAX} 個字。
            </p>
          </div>

          <div>
            <label className="lbl" htmlFor="nt-place">
              記到
            </label>
            {places.length ? (
              <select id="nt-place" className="select" value={d.place} onChange={(e) => set({ place: e.target.value })}>
                {!d.place && <option value="">請選擇</option>}
                {places.map((o) => (
                  <option key={o.key} value={placeKey(o.paymentMethodId, o.cardId!)}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <p className="range-help">還沒有綁卡的行動支付。請先到「設定 › 帳戶與付款方式」，在 LINE Pay 底下勾選它綁的卡。</p>
            )}
            {editingOne && targetProblem(editingOne, ref.payments) && !d.place && (
              <p className="err-line">原本的設定已不能用（{targetProblem(editingOne, ref.payments)}），請重新選擇。</p>
            )}
          </div>

          <p className="form-err" role="alert">
            {err}
          </p>
          <button type="submit" className="btn-primary" disabled={busy || !places.length}>
            {isNew ? '新增' : '儲存'}
          </button>
          {!isNew && (
            <button type="button" className="btn-danger-quiet" onClick={() => setAsking(true)} disabled={busy}>
              刪除這個通知類型
            </button>
          )}
        </form>
      </BottomSheet>
      <ActionSheet
        open={asking}
        onClose={() => setAsking(false)}
        title={`刪除「${editingOne?.name ?? ''}」？`}
        message="之後匯入的付款通知不再依它判斷；已經匯入的紀錄不受影響。"
        actions={[{ label: '刪除', danger: true, onClick: () => void remove() }]}
      />
    </Overlay>
  )
}
