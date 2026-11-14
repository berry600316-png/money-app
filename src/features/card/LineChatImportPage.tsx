import { useRef, useState } from 'react'
import { commitNotificationImport, getNoticeMethods, getNoticeTypes, knownLineChatCaptures } from '../../card/cardRepo'
import { planImport, type PaySource, type PlanRow } from '../../card/importPlan'
import { hasLineChatTransactionTime, readLineChatFile, type LineChatReadResult } from '../../card/lineChatFile'
import { db } from '../../db/db'
import { MoneyError } from '../../db/repo'
import { isAsset } from '../../lib/accounts'
import { isValidHm, localIso, timeLabel, toYmd } from '../../lib/dates'
import { isValidAmount } from '../../lib/money'
import { Icon } from '../../ui/Icon'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'

const sourceKey = (source: PaySource | null) => source?.cardId ? `card:${source.cardId}` : source?.sourceAccountId ? `account:${source.sourceAccountId}` : ''
const localInput = (iso: string) => {
  const date = new Date(iso)
  return `${toYmd(date)}T${timeLabel(date)}`
}

/** The chat text exists only in preview state; nothing is uploaded or stored as a file. */
export function LineChatImportPage({ onBack, backLabel }: { onBack: () => void; backLabel: string }) {
  const ref = useRefData()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [read, setRead] = useState<LineChatReadResult | null>(null)
  const [rows, setRows] = useState<PlanRow[] | null>(null)
  const [duplicates, setDuplicates] = useState(0)
  const [busy, setBusy] = useState(false)
  const categories = ref.categories.filter((c) => c.type === 'expense' && c.isActive)
  const sources = ref.payments.filter((p) => p.isActive && (
    p.type === 'credit_card' || (p.type === 'debit_card' && ref.payments.some((b) => b.id === p.payFromId && b.type === 'bank')) || isAsset(p)
  ))

  const patch = (row: PlanRow, update: Partial<PlanRow>) => setRows((current) => current?.map((r) => r === row ? { ...r, ...update } : r) ?? null)
  const selectSource = (row: PlanRow, key: string) => {
    const source: PaySource | null = key.startsWith('card:') ? { cardId: key.slice(5) } : key.startsWith('account:') ? { sourceAccountId: key.slice(8) } : null
    patch(row, {
      source,
      sourceIsDefault: false,
      paymentMethodId: row.channelMethodId,
      needsSource: !source,
      ...(source && row.status === 'suspect' && !row.duplicate && !row.reason ? { status: 'new', include: true } : {}),
    })
  }

  const selectFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try {
      const result = await readLineChatFile(file)
      setRead(result)
      if (result.errors.length) {
        setRows(null)
        return
      }
      const now = new Date()
      const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 120).toISOString()
      const [known, transactions, methods, types, noticeMethods] = await Promise.all([
        knownLineChatCaptures(db),
        db.transactions.where('occurredAt').above(since).toArray(),
        db.paymentMethods.toArray(),
        getNoticeTypes(),
        getNoticeMethods(),
      ])
      const history = [...transactions].filter((t) => t.type === 'expense' && t.merchant)
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .map((t) => ({ merchant: t.merchant, categoryId: t.categoryId }))
      const planned = planImport({
        captures: result.captures,
        knownCaptureIds: known,
        transactions,
        paymentMethods: methods,
        categories: ref.categories,
        history,
        defaultCards: {},
        noticeTypes: types,
        noticeMethods,
        now,
      })
      setDuplicates(planned.filter((r) => r.status === 'duplicate').length)
      setRows(planned.filter((r) => r.status !== 'duplicate' && r.status !== 'not_spending').map((r) =>
        r.capture.body && hasLineChatTransactionTime(r.capture.body) ? { ...r, timeSource: undefined } : r))
    } catch {
      setRead(null)
      setRows(null)
      toast('無法解析這份 LINE 對話檔', { kind: 'error' })
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const eligible = rows?.filter((r) => r.status === 'new' || r.status === 'suspect') ?? []
  const unparsed = rows?.filter((r) => r.status === 'unparsed') ?? []
  const selected = eligible.filter((r) => r.include && !r.permanentSkip)
  const permanentlySkipped = eligible.filter((r) => r.permanentSkip)
  const byMonth = eligible.reduce((months, row) => {
    const key = localInput(row.occurredAt).slice(0, 7)
    months.set(key, [...(months.get(key) ?? []), row])
    return months
  }, new Map<string, PlanRow[]>())

  const commit = async () => {
    if (busy || !rows) return
    if (selected.some((r) => !r.source)) return toast('請先為勾選的付款選擇卡片或帳戶', { kind: 'error' })
    if (selected.some((r) => !r.merchant.trim() || !isValidAmount(r.amount) || !Number.isFinite(Date.parse(r.occurredAt)) || Date.parse(r.occurredAt) > Date.now())) {
      return toast('請檢查商家、金額和時間', { kind: 'error' })
    }
    setBusy(true)
    try {
      const result = await commitNotificationImport([...selected, ...permanentlySkipped], { files: 1 })
      toast(`已記帳 ${result.imported} 筆${permanentlySkipped.length ? `，永久略過 ${permanentlySkipped.length} 筆` : ''}`)
      onBack()
    } catch (error) {
      toast(error instanceof MoneyError ? error.message : '匯入失敗，資料沒有寫入', { kind: 'error' })
      setBusy(false)
    }
  }

  const rowView = (r: PlanRow) => (
    <div className="line-chat-row" key={r.capture.captureId}>
      <div className="line-chat-row-head">
        <label>
          <input type="checkbox" checked={r.include && !r.permanentSkip} disabled={!!r.permanentSkip} onChange={(e) => patch(r, { include: e.target.checked })} />
          <span>{r.duplicate ? '可能重複' : r.needsSource ? '待選付款來源' : '匯入這筆'}</span>
        </label>
        <button type="button" className="txt-btn" aria-pressed={!!r.permanentSkip} onClick={() => {
          if (r.permanentSkip) return patch(r, { permanentSkip: false })
          if (window.confirm('永久略過後，下次重新匯入 LINE 對話也不會再顯示這筆。確定嗎？')) patch(r, { permanentSkip: true, include: false })
        }}>{r.permanentSkip ? '取消永久略過' : '永久略過'}</button>
      </div>
      {r.reason && <p className="line-chat-reason">{r.reason}</p>}
      <div className="line-chat-fields">
        <label>商家<input value={r.merchant} maxLength={40} onChange={(e) => patch(r, { merchant: e.target.value })} /></label>
        <label>金額<input type="number" min="1" step="1" value={r.amount} onChange={(e) => patch(r, { amount: Number(e.target.value) })} /></label>
        <label>時間<input type="datetime-local" value={localInput(r.occurredAt)} onChange={(e) => {
          const [date, time] = e.target.value.split('T')
          if (date && time && isValidHm(time)) patch(r, { occurredAt: localIso(date, time), timeSource: undefined })
        }} /></label>
        <label>分類<select value={r.categoryId} onChange={(e) => patch(r, { categoryId: e.target.value })}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <label className="line-chat-wide">付款來源<select value={sourceKey(r.source)} onChange={(e) => selectSource(r, e.target.value)}>
          <option value="">請選擇</option>
          {sources.map((p) => <option key={p.id} value={p.type === 'credit_card' || p.type === 'debit_card' ? `card:${p.id}` : `account:${p.id}`}>{p.name}</option>)}
        </select></label>
      </div>
    </div>
  )

  return <>
    <div className="page-head">
      <button type="button" className="back" onClick={onBack}><Icon name="left" />{backLabel}</button>
      <h1>LINE 對話匯入</h1><span />
    </div>
    <input ref={fileInput} type="file" accept=".txt,text/plain" hidden onChange={(e) => void selectFile(e.target.files?.[0])} />
    {!read && <>
      <p className="lead">選擇 LINE 錢包匯出的聊天文字檔。只找最近 120 天的付款；原始對話只在這次預覽使用，不會儲存在 CJ 或備份中。</p>
      <button type="button" className="pick-btn" disabled={busy} onClick={() => fileInput.current?.click()}><Icon name="inbox" />{busy ? '讀取中…' : '選擇 LINE 對話檔'}<small>支援你提供的 LINE 錢包 .txt 格式</small></button>
    </>}
    {read && <>
      {read.errors.length > 0 ? <ul className="warn-list">{read.errors.map((e) => <li key={e}>{e}</li>)}</ul> : <>
        <p className="line-chat-summary">檔案涵蓋 {read.coverage?.first}～{read.coverage?.last}；{duplicates} 筆已處理，{read.ignored} 則非付款訊息略過。</p>
        <div className="counts"><span><b>{eligible.length}</b>筆待檢查</span>{unparsed.length > 0 && <span><b>{unparsed.length}</b>筆未辨識</span>}</div>
        {[...byMonth].sort(([a], [b]) => b.localeCompare(a)).map(([month, group]) => <section key={month}>
          <div className="grp-title"><b>{month.replace('-', ' 年 ')} 月</b><span>{group.length} 筆</span></div>
          <div className="card line-chat-group">{group.map(rowView)}</div>
        </section>)}
        {unparsed.length > 0 && <section><div className="grp-title"><b>未辨識的付款</b></div><div className="card line-chat-group">
          {unparsed.map((r) => <div className="line-chat-unparsed" key={r.capture.captureId}><b>{localInput(r.occurredAt).replace('T', ' ')}</b><p>{r.reason}</p><small>{r.capture.body?.slice(0, 180)}</small></div>)}
        </div></section>}
        {eligible.length === 0 && unparsed.length === 0 && <p className="lead">最近 120 天沒有尚未處理的付款。</p>}
        <p className="set-foot">取消勾選只影響這次；「永久略過」儲存後，下次不再出現。匯入完成後，請自行刪除「檔案」App 中的原始 .txt。</p>
        <div className="foot-bar"><button type="button" className="btn-primary" disabled={busy || selected.length + permanentlySkipped.length === 0} onClick={() => void commit()}>{busy ? '匯入中…' : `記帳 ${selected.length} 筆${permanentlySkipped.length ? `，永久略過 ${permanentlySkipped.length} 筆` : ''}`}</button></div>
      </>}
      <button type="button" className="btn-quiet line-chat-reset" disabled={busy} onClick={() => { setRead(null); setRows(null); setDuplicates(0) }}>重新選擇檔案</button>
    </>}
  </>
}
