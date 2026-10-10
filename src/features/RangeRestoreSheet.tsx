import { useEffect, useState } from 'react'
import { BackupError, type BackupFile } from '../backup/format'
import { backupDateSpan, previewRange, type RangePreview } from '../backup/store'
import { fromYmd } from '../lib/dates'
import { BottomSheet } from '../ui/BottomSheet'
import { Icon } from '../ui/Icon'

export function rangeLabel(ymd: string): string {
  const d = fromYmd(ymd)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** D-45: pick the period to restore; shows what would change before anything is written. */
export function RangeRestoreSheet({
  backup,
  open,
  onClose,
  onNext,
}: {
  backup: BackupFile | null
  open: boolean
  onClose: () => void
  onNext: (from: string, to: string, preview: RangePreview) => void
}) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [preview, setPreview] = useState<RangePreview | null>(null)
  const [err, setErr] = useState('')

  // Default to the backup's own span every time a file is chosen.
  useEffect(() => {
    if (!open || !backup) return
    const span = backupDateSpan(backup)
    if (span) {
      setFrom(span[0])
      setTo(span[1])
    }
  }, [open, backup])

  useEffect(() => {
    if (!open || !backup || !from || !to) return
    let stale = false
    setPreview(null)
    setErr('')
    previewRange(backup, from, to).then(
      (p) => !stale && setPreview(p),
      (e) => !stale && setErr(e instanceof BackupError ? e.message : '無法計算這段期間，請再試一次'),
    )
    return () => {
      stale = true
    }
  }, [open, backup, from, to])

  const dateField = (id: string, label: string, value: string, set: (v: string) => void) => (
    <label className="pill" htmlFor={id}>
      <Icon name="cal" />
      <span>
        {label} <span className="num">{value ? value.replace(/-0?/g, '/') : '—'}</span>
      </span>
      <input
        id={id}
        type="date"
        className="pill-input"
        value={value}
        aria-label={label + '日期'}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker()
          } catch {
            /* native tap opens the picker */
          }
        }}
        onChange={(e) => e.target.value && set(e.target.value)}
      />
    </label>
  )

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      labelledBy="range-title"
      head={
        <div className="sheet-bar">
          <button type="button" className="txt-btn" onClick={onClose}>
            取消
          </button>
          <h2 id="range-title">還原某段期間</h2>
          <span />
        </div>
      }
    >
      <div className="form">
        <p className="range-help">只有這段期間內的紀錄會換成備份的內容，期間以外的紀錄不受影響。</p>
        <div className="range-dates">
          {dateField('range-from', '從', from, setFrom)}
          {dateField('range-to', '到', to, setTo)}
        </div>
        <div className="range-preview" aria-live="polite">
          {err ? (
            <span className="form-err">{err}</span>
          ) : preview ? (
            <>
              <div className="range-nums">
                <div>
                  <span className="lbl">備份這段期間</span>
                  <span className="v num">{preview.fromBackup.toLocaleString('en-US')}</span>
                  <span className="lbl">筆</span>
                </div>
                <div>
                  <span className="lbl">會取代目前的</span>
                  <span className="v num">{preview.replaced.toLocaleString('en-US')}</span>
                  <span className="lbl">筆</span>
                </div>
              </div>
              {preview.fromBackup === 0 && <p className="range-note">備份在這段期間沒有紀錄，目前這段期間的紀錄會被移除。</p>}
            </>
          ) : (
            <span className="lbl">計算中…</span>
          )}
        </div>
        <button type="button" className="btn-primary" disabled={!preview || !!err} onClick={() => preview && onNext(from, to, preview)}>
          下一步
        </button>
      </div>
    </BottomSheet>
  )
}
