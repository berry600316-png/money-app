import { useEffect, useState } from 'react'
import { MoneyError } from '../../db/repo'
import { NOTE_MAX, setPayslipNote } from '../../db/salary'
import type { Payslip, SalaryItem, SalaryKind } from '../../db/types'
import { BottomSheet } from '../../ui/BottomSheet'
import { useCloseGuard, useDirtyCheck } from '../../ui/discard'
import { Overlay } from '../../ui/overlay'
import { useToast } from '../../ui/Toast'

/**
 * D-141: the notes of one payslip. Pick an item on it (應發 / 應扣; 已有 = it has a note), then type, change
 * or delete its note. One note per item, up to 50 characters.
 */
export function PayslipNoteSheet({
  slip,
  items,
  open,
  onClose,
}: {
  slip: Payslip
  items: readonly SalaryItem[]
  open: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const [itemId, setItemId] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const saved = (iid: string) => slip.lines.find((l) => l.itemId === iid)?.note ?? ''
  const nameOf = (iid: string) => items.find((i) => i.id === iid)?.name ?? slip.lines.find((l) => l.itemId === iid)?.name ?? ''
  const kindOf = (iid: string) => items.find((i) => i.id === iid)?.kind

  // Opens on the first item that has a note, else the first item.
  useEffect(() => {
    if (!open) return
    const first = slip.lines.find((l) => l.note) ?? slip.lines[0]
    setItemId(first?.itemId ?? '')
    setText(first?.note ?? '')
    setBusy(false)
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const dirty = !!itemId && text.trim() !== saved(itemId)
  useDirtyCheck('payslipNote', open, () => !busy && dirty)
  const guard = useCloseGuard('payslipNote')
  const requestClose = () => guard(onClose)

  const pick = (iid: string) => {
    if (iid === itemId) return
    // The text typed for the item before goes with it (nothing is saved until 儲存).
    guard(() => {
      setItemId(iid)
      setText(saved(iid))
    })
  }

  const write = async (note: string) => {
    if (!itemId || busy) return
    // Nothing changed: 儲存 just closes (a greyed-out button reads as broken).
    if (note.trim() === saved(itemId)) {
      onClose()
      return
    }
    setBusy(true)
    try {
      await setPayslipNote(slip.id, itemId, note)
      toast(note.trim() ? `已儲存「${nameOf(itemId)}」的備註` : `已刪除「${nameOf(itemId)}」的備註`)
      onClose()
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '沒有存到，請再試一次', { kind: 'error' })
      setBusy(false)
    }
  }

  const group = (kind: SalaryKind) => {
    const lines = slip.lines.filter((l) => kindOf(l.itemId) === kind)
    if (!lines.length) return null
    return (
      <>
        <div className="note-grp">{kind === 'earning' ? '應發' : '應扣'}</div>
        <div className="opt-set">
          {lines.map((l) => (
            <button type="button" key={l.itemId} className="opt" aria-pressed={l.itemId === itemId} onClick={() => pick(l.itemId)}>
              {nameOf(l.itemId)}
              {l.note && <small className="note-has">· 已有</small>}
            </button>
          ))}
        </div>
      </>
    )
  }

  const has = !!saved(itemId)
  return (
    <Overlay>
      <BottomSheet
        open={open}
        onClose={requestClose}
        labelledBy="note-title"
        head={
          <div className="sheet-bar">
            <button type="button" className="txt-btn" onClick={requestClose}>
              取消
            </button>
            <h2 id="note-title">備註</h2>
            <span />
          </div>
        }
      >
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            void write(text)
          }}
        >
          <div>
            <span className="lbl field-head" id="note-item-label">
              選項目
            </span>
            <div role="group" aria-labelledby="note-item-label">
              {group('earning')}
              {group('deduction')}
            </div>
          </div>
          {itemId && (
            <div>
              <label className="lbl" htmlFor="note-text">
                {nameOf(itemId)}的備註
              </label>
              <textarea
                id="note-text"
                className="field note-area"
                value={text}
                maxLength={NOTE_MAX}
                rows={3}
                placeholder="例如：10/3、10/12 加班"
                onChange={(e) => setText(e.target.value)}
              />
              <p className="note-cnt">
                {text.trim().length} / {NOTE_MAX}
              </p>
            </div>
          )}
          <button type="submit" className="btn-primary" disabled={busy || !itemId}>
            儲存
          </button>
          {has && (
            <button type="button" className="btn-danger-quiet" onClick={() => void write('')} disabled={busy}>
              刪除這則備註
            </button>
          )}
        </form>
      </BottomSheet>
    </Overlay>
  )
}
