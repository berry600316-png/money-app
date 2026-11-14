import { useRef, useState } from 'react'
import { commitNotificationImport, getNoticeMethods, getNoticeTypes, knownLineChatCaptures } from '../../card/cardRepo'
import { planImport, type PaySource } from '../../card/importPlan'
import { hasLineChatTransactionTime, readLineChatFile, type LineChatReadResult } from '../../card/lineChatFile'
import { acceptDuplicate, completeUnparsed, lineReviewIssue, lineReviewSection, restoreLineRow, skipLineRow, type LineReviewRow } from '../../card/lineChatReview'
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
  const [rows, setRows] = useState<LineReviewRow[] | null>(null)
  const [duplicates, setDuplicates] = useState(0)
  const [busy, setBusy] = useState(false)
  const skipWarningShown = useRef(false)
  const categories = ref.categories.filter((c) => c.type === 'expense' && c.isActive)
  const sources = ref.payments.filter((p) => p.isActive && (
    p.type === 'credit_card' || (p.type === 'debit_card' && ref.payments.some((b) => b.id === p.payFromId && b.type === 'bank')) || isAsset(p)
  ))

  const replace = (row: LineReviewRow, next: LineReviewRow) => setRows((current) => current?.map((r) => r === row ? next : r) ?? null)
  const patch = (row: LineReviewRow, update: Partial<LineReviewRow>) => replace(row, { ...row, ...update })
  const skip = (row: LineReviewRow, confirmFirst = false) => {
    if (confirmFirst && !skipWarningShown.current) {
      if (!window.confirm('取消勾選會永久略過這筆。送出後，下次匯入也不會再顯示。確定嗎？')) return
      skipWarningShown.current = true
    }
    replace(row, skipLineRow(row))
  }
  const selectSource = (row: LineReviewRow, key: string) => {
    const source: PaySource | null = key.startsWith('card:') ? { cardId: key.slice(5) } : key.startsWith('account:') ? { sourceAccountId: key.slice(8) } : null
    patch(row, {
      source,
      sourceIsDefault: false,
      paymentMethodId: row.channelMethodId,
      needsSource: !source,
      include: !!source && row.status !== 'unparsed' && (!row.duplicate || !!row.duplicateReviewed),
      ...(source && row.status === 'suspect' && !row.duplicate ? { status: 'new', reason: '' } : {}),
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

  const problems = rows?.filter((r) => lineReviewSection(r) === 'problem') ?? []
  const selected = rows?.filter((r) => lineReviewSection(r) === 'selected') ?? []
  const permanentlySkipped = rows?.filter((r) => lineReviewSection(r) === 'skipped') ?? []
  const byMonth = (rows ?? []).reduce((months, row) => {
    const key = localInput(row.occurredAt).slice(0, 7)
    const groups = months.get(key) ?? { problem: [], selected: [], skipped: [] }
    groups[lineReviewSection(row)].push(row)
    months.set(key, groups)
    return months
  }, new Map<string, Record<'problem' | 'selected' | 'skipped', LineReviewRow[]>>())

  const commit = async () => {
    if (busy || !rows) return
    if (problems.length) return toast(`請先處理 ${problems.length} 筆待處理問題`, { kind: 'error' })
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

  const finishUnparsed = (r: LineReviewRow) => {
    if (!r.merchant.trim() || !isValidAmount(r.amount) || !Number.isFinite(Date.parse(r.occurredAt)) || Date.parse(r.occurredAt) > Date.now()) {
      return toast('請補齊正確的商家、金額和時間', { kind: 'error' })
    }
    if (!r.source) return toast('請先選擇付款來源', { kind: 'error' })
    replace(r, completeUnparsed(r))
  }

  const rowFields = (r: LineReviewRow) => (
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
  )

  const rowView = (r: LineReviewRow, section: 'problem' | 'selected' | 'skipped') => {
    const issue = lineReviewIssue(r)
    return <div className="line-chat-row" key={r.capture.captureId}>
      <div className="line-chat-row-head">
        {section === 'problem' ? <span className="line-chat-issue-label">{issue === 'duplicate' ? '可能重複' : issue === 'unparsed' ? '未辨識付款' : '待選付款來源'}</span> : <label>
          <input type="checkbox" checked={section === 'selected'} aria-label={`${r.merchant || '未辨識付款'}：${section === 'selected' ? '匯入' : '不匯入'}`} onChange={() => section === 'selected' ? skip(r, true) : replace(r, restoreLineRow(r))} />
          <span>{r.merchant || '未辨識付款'}</span>
        </label>}
        <strong>{isValidAmount(r.amount) ? `NT$ ${r.amount.toLocaleString('en-US')}` : '金額待補'}</strong>
      </div>
      {section === 'problem' && <p className="line-chat-row-name">{r.merchant || '商家待補'}</p>}
      <p className="line-chat-row-meta">{localInput(r.occurredAt).replace('T', ' ')}</p>
      {issue === 'unparsed' ? <p className="line-chat-reason">系統還無法辨識這筆付款；請對照原始訊息補齊欄位，或選不匯入。</p> : issue && r.reason && <p className="line-chat-reason">{r.reason}</p>}
      {section === 'skipped' && <p className="line-chat-skipped-note">下次不再出現・送出前可勾回</p>}
      {section === 'problem' ? <>
        {issue === 'unparsed' && <p className="line-chat-raw">{r.capture.body?.slice(0, 240)}</p>}
        {rowFields(r)}
      </> : <details className="line-chat-detail"><summary>查看或修改內容</summary>{r.status === 'unparsed' && <p className="line-chat-raw">{r.capture.body?.slice(0, 240)}</p>}{rowFields(r)}</details>}
      {issue === 'duplicate' && <div className="line-chat-actions">
        <button type="button" className="chip-btn" onClick={() => replace(r, acceptDuplicate(r))}>仍要匯入</button>
        <button type="button" className="btn-quiet" onClick={() => skip(r)}>不匯入</button>
        <small>不匯入後，下次不再出現</small>
      </div>}
      {issue === 'unparsed' && <div className="line-chat-actions">
        <button type="button" className="chip-btn" onClick={() => finishUnparsed(r)}>補填並加入</button>
        <button type="button" className="btn-quiet" onClick={() => skip(r)}>不匯入</button>
        <small>不匯入後，下次不再出現</small>
      </div>}
    </div>
  }

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
        <div className="counts"><span><b>{problems.length}</b>筆待處理問題</span><span><b>{selected.length}</b>筆已勾選</span><span><b>{permanentlySkipped.length}</b>筆不匯入</span></div>
        {[...byMonth].sort(([a], [b]) => b.localeCompare(a)).map(([month, group]) => <section key={month} className="line-chat-month">
          <div className="grp-title"><b>{month.replace('-', ' 年 ')} 月</b><span>{group.problem.length + group.selected.length + group.skipped.length} 筆</span></div>
          {(['problem', 'selected', 'skipped'] as const).map((section) => group[section].length > 0 && <section key={section} className={`line-chat-section line-chat-section-${section}`}>
            <h2 className="line-chat-section-title">{section === 'problem' ? '待處理問題' : section === 'selected' ? '已勾選・將匯入' : '不匯入'} <span>{group[section].length}</span></h2>
            <div className="card line-chat-group">{group[section].map((r) => rowView(r, section))}</div>
          </section>)}
        </section>)}
        {rows?.length === 0 && <p className="lead">最近 120 天沒有尚未處理的付款。</p>}
        <p className="set-foot">「不匯入」送出後會永久略過，下次不再出現。匯入完成後，請自行刪除「檔案」App 中的原始 .txt。</p>
        {problems.length > 0 && <p className="line-chat-blocked">請先處理 {problems.length} 筆問題，才能完成匯入。</p>}
        <div className="foot-bar"><button type="button" className="btn-primary" disabled={busy || problems.length > 0 || selected.length + permanentlySkipped.length === 0} onClick={() => void commit()}>{busy ? '匯入中…' : `記帳 ${selected.length} 筆・不匯入 ${permanentlySkipped.length} 筆`}</button></div>
      </>}
      <button type="button" className="btn-quiet line-chat-reset" disabled={busy} onClick={() => { setRead(null); setRows(null); setDuplicates(0) }}>重新選擇檔案</button>
    </>}
  </>
}
