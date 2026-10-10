import { useEffect, useRef, useState } from 'react'
import { BackupError, backupFileName, buildBackup, csvFileName, parseBackup, toCsv, type BackupFile } from '../backup/format'
import { saveFile } from '../backup/share'
import { markBackedUp, readAllData, restoreBackup, undoRestore, type Snapshot } from '../backup/store'
import { useSetting, useTxCount } from '../db/hooks'
import { daysBetween } from '../lib/dates'
import { ActionSheet } from '../ui/ActionSheet'
import { Icon } from '../ui/Icon'
import { Overlay } from '../ui/overlay'
import { useRefData } from '../ui/refData'
import { useToast } from '../ui/Toast'

type Prepared = { kind: 'json' | 'csv'; file: File; count: number }

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
  const [confirmUndo, setConfirmUndo] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

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
    try {
      const result = await saveFile(p.file)
      if (result === 'cancelled') return
      setPrepared(null)
      if (p.kind === 'json') {
        await markBackedUp()
        toast('已匯出備份')
      } else toast('已匯出 CSV')
    } catch {
      toast('沒有存成功，請再試一次', { kind: 'error' })
    }
  }

  const onPickFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const backup = parseBackup(await file.text())
      setPendingRestore(backup)
    } catch (e) {
      toast(e instanceof BackupError ? e.message : '無法讀取這個檔案', { kind: 'error' })
    } finally {
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const doRestore = async () => {
    if (!pendingRestore || busy) return
    setBusy(true)
    try {
      await restoreBackup(pendingRestore)
      setPendingRestore(null)
      toast(`已還原 ${pendingRestore.transactions.length.toLocaleString('en-US')} 筆紀錄`)
    } catch {
      toast('還原失敗，目前的資料沒有變動', { kind: 'error' })
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
          title={prepared?.kind === 'csv' ? 'CSV 已準備好' : '備份已準備好'}
          message={
            <>
              共 <b>{(prepared?.count ?? 0).toLocaleString('en-US')}</b> 筆交易。
              <br />
              下一步選「儲存到檔案」，建議存在「我的 iPhone」。
            </>
          }
          actions={[{ label: prepared?.kind === 'csv' ? '儲存 CSV…' : '儲存備份…', onClick: () => void save() }]}
        />
        <ActionSheet
          open={pendingRestore !== null}
          onClose={() => setPendingRestore(null)}
          title="用這個備份取代目前的資料？"
          message={
            pendingRestore && (
              <>
                備份檔：{dateTimeLabel(pendingRestore.exportedAt)} 匯出，共 <b>{pendingRestore.transactions.length.toLocaleString('en-US')}</b> 筆交易。
                <br />
                目前的 <b>{count.toLocaleString('en-US')}</b> 筆交易會被取代。還原前的資料會保留一份，之後可以在設定頁退回。
              </>
            )
          }
          actions={[{ label: '取代並還原', danger: true, disabled: busy, onClick: () => void doRestore() }]}
        />
        <ActionSheet
          open={confirmUndo && snapshot !== null}
          onClose={() => setConfirmUndo(false)}
          title="退回到還原之前？"
          message={
            snapshot && (
              <>
                目前的 <b>{count.toLocaleString('en-US')}</b> 筆交易會被 {dateTimeLabel(snapshot.takenAt)} 的 <b>{snapshot.data.transactions.length.toLocaleString('en-US')}</b>{' '}
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
