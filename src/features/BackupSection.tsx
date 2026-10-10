import { useEffect, useRef, useState } from 'react'
import { BackupError, backupFileName, buildBackup, csvFileName, parseBackup, toCsv, type BackupFile } from '../backup/format'
import { saveFile } from '../backup/share'
import { markBackedUp, readAllData, restoreBackup, restoreRange, undoRestore, type RangePreview, type Snapshot } from '../backup/store'
import { useSetting, useTxCount } from '../db/hooks'
import { daysBetween } from '../lib/dates'
import { ActionSheet } from '../ui/ActionSheet'
import { Icon } from '../ui/Icon'
import { Overlay } from '../ui/overlay'
import { useRefData } from '../ui/refData'
import { useToast } from '../ui/Toast'
import { rangeLabel, RangeRestoreSheet } from './RangeRestoreSheet'

type Prepared = { kind: 'json' | 'csv'; file: File; count: number }

/** Keeps the last non-null value so a sheet's text doesn't vanish while it slides away. */
function useLast<T>(v: T | null): T | null {
  const ref = useRef<T | null>(v)
  if (v !== null) ref.current = v
  return ref.current
}

function dateTimeLabel(iso: string) {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Settings → 備份與匯出 (spec 0.9, D-40..D-42). */
export function BackupSection({ backupRequest }: { backupRequest: number }) {
  const toast = useToast()
  const ref = useRefData()
  const count = useTxCount() ?? 0
  const lastBackupAt = useSetting<string | null>('lastBackupAt', null)
  const snapshot = useSetting<Snapshot | null>('preRestoreSnapshot', null)
  const [busy, setBusy] = useState(false)
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [pendingRestore, setPendingRestore] = useState<BackupFile | null>(null)
  // choose → (full | range → rangeConfirm)
  const [mode, setMode] = useState<'choose' | 'full' | 'range' | 'rangeConfirm' | null>(null)
  const [range, setRange] = useState<{ from: string; to: string; preview: RangePreview } | null>(null)
  const shownRange = useLast(range)
  const [confirmUndo, setConfirmUndo] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const shownPrepared = useLast(prepared)
  const shownRestore = useLast(pendingRestore)
  const shownSnap = useLast(snapshot)

  // Safari only lets navigator.share run inside a tap, so the file is built first and
  // handed over by a second tap in the "備份已準備好" sheet.
  const prepare = async (kind: 'json' | 'csv') => {
    if (busy) return
    setBusy(true)
    try {
      const data = await readAllData()
      const now = new Date()
      const file =
        kind === 'json'
          ? new File([JSON.stringify(buildBackup(data, now), null, 1)], backupFileName(now), { type: 'application/json' })
          : new File([toCsv(data.transactions, { category: (id) => ref.category(id).name, payment: (id) => ref.payment(id).name })], csvFileName(now), {
              type: 'text/csv',
            })
      setPrepared({ kind, file, count: data.transactions.length })
    } catch {
      toast('無法讀取資料，請再試一次', { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  // The home-screen reminder asks for a backup.
  const lastRequest = useRef(backupRequest)
  useEffect(() => {
    if (backupRequest !== lastRequest.current) {
      lastRequest.current = backupRequest
      void prepare('json')
    }
  }) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!prepared) return
    const p = prepared
    let result
    try {
      result = await saveFile(p.file)
    } catch {
      toast('沒有存成功，請再試一次', { kind: 'error' })
      return
    }
    if (result === 'cancelled') return
    setPrepared(null)
    if (p.kind === 'csv') {
      toast('已匯出 CSV')
      return
    }
    try {
      await markBackedUp()
      toast('已匯出備份')
    } catch {
      toast('備份已存出，但無法記錄備份時間', { kind: 'error' })
    }
  }

  const onPickFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const backup = parseBackup(await file.text())
      setPendingRestore(backup)
      setMode('choose')
    } catch (e) {
      toast(e instanceof BackupError ? e.message : '無法讀取這個檔案', { kind: 'error' })
    } finally {
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const endRestore = () => {
    setMode(null)
    setPendingRestore(null)
    setRange(null)
  }

  const doRestore = async () => {
    if (!pendingRestore || busy) return
    setBusy(true)
    try {
      await restoreBackup(pendingRestore)
      endRestore()
      toast(`已還原 ${pendingRestore.transactions.length.toLocaleString('en-US')} 筆紀錄`)
    } catch {
      toast('還原失敗，目前的資料沒有變動', { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const doRangeRestore = async () => {
    if (!pendingRestore || !range || busy) return
    setBusy(true)
    try {
      const done = await restoreRange(pendingRestore, range.from, range.to)
      endRestore()
      toast(`已還原 ${rangeLabel(range.from)} 到 ${rangeLabel(range.to)}，共 ${done.fromBackup.toLocaleString('en-US')} 筆`)
    } catch (e) {
      toast(e instanceof BackupError ? e.message : '還原失敗，目前的資料沒有變動', { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const doUndo = async () => {
    if (busy) return
    setBusy(true)
    try {
      await undoRestore()
      setConfirmUndo(false)
      toast('已退回到還原之前')
    } catch {
      toast('退回失敗，目前的資料沒有變動', { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const lastLabel = lastBackupAt
    ? (() => {
        const days = daysBetween(lastBackupAt)
        const d = new Date(lastBackupAt)
        return `上次備份：${d.getMonth() + 1} 月 ${d.getDate()} 日（${days === 0 ? '今天' : `${days} 天前`}）`
      })()
    : '還沒有備份過。'

  return (
    <div className="set-sec">
      <h2>備份與匯出</h2>
      <div className="set-card">
        <button type="button" className="srow" onClick={() => prepare('json')} disabled={busy}>
          <span className="s-main">
            匯出完整備份<span className="s-sub">JSON 檔，可用來還原</span>
          </span>
          <Icon name="chev" className="chev" />
        </button>
        <button type="button" className="srow" onClick={() => fileInput.current?.click()} disabled={busy}>
          <span className="s-main">
            從備份還原<span className="s-sub">會取代目前的資料</span>
          </span>
          <Icon name="chev" className="chev" />
        </button>
        {snapshot && (
          <button type="button" className="srow" onClick={() => setConfirmUndo(true)} disabled={busy}>
            <span className="s-main">
              退回到還原之前
              <span className="s-sub">
                {dateTimeLabel(snapshot.takenAt)} 的資料，共 {snapshot.data.transactions.length.toLocaleString('en-US')} 筆
              </span>
            </span>
            <Icon name="chev" className="chev" />
          </button>
        )}
        <button type="button" className="srow" onClick={() => prepare('csv')} disabled={busy}>
          <span className="s-main">
            匯出交易 CSV<span className="s-sub">可用 Numbers 或 Excel 開啟</span>
          </span>
          <Icon name="chev" className="chev" />
        </button>
      </div>
      <p className="set-foot">{lastLabel} 建議存到「檔案」App 的「我的 iPhone」，資料就不會離開這支手機。</p>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => void onPickFile(e.target.files?.[0])}
      />

      <Overlay>
        <ActionSheet
          open={prepared !== null}
          onClose={() => setPrepared(null)}
          title={shownPrepared?.kind === 'csv' ? 'CSV 已準備好' : '備份已準備好'}
          message={
            <>
              共 <b>{(shownPrepared?.count ?? 0).toLocaleString('en-US')}</b> 筆交易。
              <br />
              下一步選「儲存到檔案」，建議存在「我的 iPhone」。
            </>
          }
          actions={[{ label: shownPrepared?.kind === 'csv' ? '儲存 CSV…' : '儲存備份…', onClick: () => void save() }]}
        />
        <ActionSheet
          open={mode === 'choose'}
          onClose={endRestore}
          title="要怎麼還原？"
          message={
            shownRestore && (
              <>
                備份檔：{dateTimeLabel(shownRestore.exportedAt)} 匯出，共 <b>{shownRestore.transactions.length.toLocaleString('en-US')}</b> 筆交易。
              </>
            )
          }
          actions={[
            { label: '只還原某段期間', disabled: !shownRestore?.transactions.length, onClick: () => setMode('range') },
            { label: '全部取代', onClick: () => setMode('full') },
          ]}
        />
        <ActionSheet
          open={mode === 'full'}
          onClose={endRestore}
          title="用這個備份取代目前的資料？"
          message={
            shownRestore && (
              <>
                備份檔：{dateTimeLabel(shownRestore.exportedAt)} 匯出，共 <b>{shownRestore.transactions.length.toLocaleString('en-US')}</b> 筆交易。
                <br />
                目前的 <b>{count.toLocaleString('en-US')}</b> 筆交易會被取代。還原前的資料會保留一份，之後可以在設定頁退回。
              </>
            )
          }
          actions={[{ label: '取代並還原', danger: true, disabled: busy, onClick: () => void doRestore() }]}
        />
        <RangeRestoreSheet
          backup={shownRestore}
          open={mode === 'range'}
          onClose={endRestore}
          onNext={(from, to, preview) => {
            setRange({ from, to, preview })
            setMode('rangeConfirm')
          }}
        />
        <ActionSheet
          open={mode === 'rangeConfirm'}
          onClose={() => setMode('range')}
          title="取代這段期間的資料？"
          message={
            shownRange && (
              <>
                {rangeLabel(shownRange.from)} 到 {rangeLabel(shownRange.to)}：備份的 <b>{shownRange.preview.fromBackup.toLocaleString('en-US')}</b> 筆會取代目前的{' '}
                <b>{shownRange.preview.replaced.toLocaleString('en-US')}</b> 筆，期間以外的紀錄不受影響。
                {shownRange.preview.movedIn > 0 && (
                  <>
                    <br />
                    另有 <b>{shownRange.preview.movedIn}</b> 筆後來改到其他日期的紀錄，會改回備份時的內容。
                  </>
                )}
                {shownRange.preview.newCategories.length + shownRange.preview.newPayments.length > 0 && (
                  <>
                    <br />
                    會加回：{[...shownRange.preview.newCategories, ...shownRange.preview.newPayments].map((x) => `「${x.name}」`).join('')}
                  </>
                )}
                <br />
                還原前的資料會保留一份，之後可以在設定頁退回。
              </>
            )
          }
          actions={[{ label: '取代這段期間', danger: true, disabled: busy, onClick: () => void doRangeRestore() }]}
        />
        <ActionSheet
          open={confirmUndo && snapshot !== null}
          onClose={() => setConfirmUndo(false)}
          title="退回到還原之前？"
          message={
            shownSnap && (
              <>
                目前的 <b>{count.toLocaleString('en-US')}</b> 筆交易會被 {dateTimeLabel(shownSnap.takenAt)} 的 <b>{shownSnap.data.transactions.length.toLocaleString('en-US')}</b>{' '}
                筆取代。
              </>
            )
          }
          actions={[{ label: '退回', danger: true, disabled: busy, onClick: () => void doUndo() }]}
        />
      </Overlay>
    </div>
  )
}
