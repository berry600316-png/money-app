import { useRef, useState } from 'react'
import { commitNotificationImport, getLineChatBaseline, getNoticeMethods, getNoticeTypes, knownLineChatCaptures, saveLineChatBaseline } from '../../card/cardRepo'
import { canResetLineChatBaseline, inspectLineChat, nextLineChatBaseline, type LineChatBaseline, type LineChatInspection } from '../../card/lineChatBaseline'
import { planImport, type PaySource } from '../../card/importPlan'
import { hasLineChatTransactionTime, readLineChatFile, type LineChatReadResult } from '../../card/lineChatFile'
import { acceptDuplicate, completeUnparsed, deferLineRow, lineReviewIssue, lineReviewSection, restoreLineRow, skipLineRow, type LineReviewRow } from '../../card/lineChatReview'
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
  const [baseline, setBaseline] = useState<LineChatBaseline | null>(null)
  const [inspection, setInspection] = useState<LineChatInspection | null>(null)
  const [resetMode, setResetMode] = useState(false)
  const [completion, setCompletion] = useState<string | null>(null)
  const [rows, setRows] = useState<LineReviewRow[] | null>(null)
  const [duplicates, setDuplicates] = useState(0)
  const [knownIds, setKnownIds] = useState<Set<string>>(new Set())
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
      deferred: source ? false : row.deferred,
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
      setCompletion(null)
      if (result.errors.length) {
        setRows(null)
        setInspection(null)
        return
      }
      const [saved, known] = await Promise.all([getLineChatBaseline(), knownLineChatCaptures(db)])
      setBaseline(saved)
      setKnownIds(new Set(known.keys()))
      const checked = inspectLineChat(result, saved, new Set(known.keys()))
      setInspection(checked)
      if (!checked || resetMode || checked.kind !== 'ready') {
        setRows(null)
        return
      }
      const now = new Date()
      const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 120).toISOString()
      const [transactions, methods, types, noticeMethods] = await Promise.all([
        db.transactions.where('occurredAt').above(since).toArray(),
        db.paymentMethods.toArray(),
        getNoticeTypes(),
        getNoticeMethods(),
      ])
      const history = [...transactions].filter((t) => t.type === 'expense' && t.merchant)
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .map((t) => ({ merchant: t.merchant, categoryId: t.categoryId }))
      const planned = planImport({
        captures: checked.captures,
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
      const visible = planned.filter((r) => r.status !== 'duplicate' && r.status !== 'not_spending').map((r) =>
        r.capture.body && hasLineChatTransactionTime(r.capture.body) ? { ...r, timeSource: undefined } : r)
      setDuplicates(planned.filter((r) => r.status === 'duplicate').length)
      if (visible.length === 0 && checked.last.id !== saved?.id) {
        await saveLineChatBaseline(saved!.id, checked.last)
        setRead(null)
        setInspection(null)
        setCompletion(`沒有待匯入付款；基準點已自動前進至 ${localInput(checked.last.at).replace('T', ' ')}。${checked.expired ? `${checked.expired} 筆已超出 120 天，無法再補匯。` : ''}`)
      } else setRows(visible)
    } catch (error) {
      setRead(null)
      setRows(null)
      setInspection(null)
      toast(error instanceof MoneyError ? error.message : '無法解析這份 LINE 對話檔', { kind: 'error' })
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const problems = rows?.filter((r) => lineReviewSection(r) === 'problem' && !r.deferred) ?? []
  const deferred = rows?.filter((r) => r.deferred) ?? []
  const selected = rows?.filter((r) => lineReviewSection(r) === 'selected') ?? []
  const permanentlySkipped = rows?.filter((r) => lineReviewSection(r) === 'skipped') ?? []
  const byMonth = (rows ?? []).reduce((months, row) => {
    const key = localInput(row.occurredAt).slice(0, 7)
    const groups = months.get(key) ?? { problem: [], selected: [], skipped: [] }
    groups[lineReviewSection(row)].push(row)
    months.set(key, groups)
    return months
  }, new Map<string, Record<'problem' | 'selected' | 'skipped', LineReviewRow[]>>())
  const resetStart = read && baseline ? read.messages.findIndex((m) => m.id === baseline.id) : -1
  const resetHasGap = !!baseline && resetStart < 0
  const resetSkipped = read ? read.messages.slice(resetStart + 1).filter((m) => m.paymentCandidate && (!baseline || !knownIds.has(m.id))).length : 0

  const commit = async () => {
    if (busy || !rows || inspection?.kind !== 'ready' || !baseline || !read) return
    if (problems.length) return toast(`請先處理 ${problems.length} 筆待處理問題`, { kind: 'error' })
    if (selected.some((r) => !r.source)) return toast('請先為勾選的付款選擇卡片或帳戶', { kind: 'error' })
    if (selected.some((r) => !r.merchant.trim() || !isValidAmount(r.amount) || !Number.isFinite(Date.parse(r.occurredAt)) || Date.parse(r.occurredAt) > Date.now())) {
      return toast('請檢查商家、金額和時間', { kind: 'error' })
    }
    setBusy(true)
    try {
      const next = nextLineChatBaseline(read.messages, inspection.baselineIndex, new Set(deferred.map((r) => r.capture.captureId)))
      const result = await commitNotificationImport([...selected, ...permanentlySkipped], { files: 1, lineChatBaseline: { expectedId: baseline.id, next } })
      setRead(null)
      setRows(null)
      setInspection(null)
      setCompletion(`已記帳 ${result.imported} 筆、永久略過 ${result.skipped} 筆、稍後處理 ${deferred.length} 筆。基準點停在 ${localInput(next.at).replace('T', ' ')}。${inspection.expired ? `${inspection.expired} 筆已超出 120 天，無法再補匯。` : ''}`)
    } catch (error) {
      toast(error instanceof MoneyError ? error.message : '匯入失敗，資料沒有寫入', { kind: 'error' })
      setBusy(false)
    }
  }

  const confirmBaseline = async () => {
    if (!inspection || !read || busy) return
    const current = baseline
    const last = inspection.last
    if (current && !canResetLineChatBaseline(read.messages, current)) return toast('新檔最後訊息不能證明在目前基準點之後', { kind: 'error' })
    const warning = resetHasGap ? '檔案找不到舊基準訊息，中間可能有缺口，略過筆數無法完整計算。\n' : ''
    if (!window.confirm(`${warning}將基準點設在 ${localInput(last.at).replace('T', ' ')}；${current ? '將略過' : '舊付款不記帳，共略過'} ${resetSkipped} 筆付款候選。確定嗎？`)) return
    setBusy(true)
    try {
      await saveLineChatBaseline(current?.id ?? null, last)
      setRead(null)
      setRows(null)
      setInspection(null)
      setResetMode(false)
      setCompletion(`基準點已設在 ${localInput(last.at).replace('T', ' ')}；這次沒有更動既有記帳。`)
    } catch (error) {
      toast(error instanceof MoneyError ? error.message : '無法設定基準點', { kind: 'error' })
    } finally {
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
        {section === 'problem' ? <span className="line-chat-issue-label">{r.deferred ? '稍後處理' : issue === 'duplicate' ? '可能重複' : issue === 'unparsed' ? '未辨識付款' : '待選付款來源'}</span> : <label>
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
      {section === 'problem' && <div className="line-chat-actions">
        <button type="button" className="btn-quiet" onClick={() => replace(r, r.deferred ? { ...r, deferred: false } : deferLineRow(r))}>{r.deferred ? '改為現在處理' : '稍後處理'}</button>
        {issue === 'source' && <small>選好付款來源即可加入；也可以留待下次匯入</small>}
      </div>}
    </div>
  }

  return <>
    <div className="page-head">
      <button type="button" className="back" onClick={onBack}><Icon name="left" />{backLabel}</button>
      <h1>LINE 對話匯入</h1><span />
    </div>
    <input ref={fileInput} type="file" accept=".txt,text/plain" hidden onChange={(e) => void selectFile(e.target.files?.[0])} />
    {completion && <div className="card"><p>{completion}</p><button type="button" className="btn-primary" onClick={onBack}>完成</button></div>}
    {!read && !completion && <>
      <p className="lead">選擇 LINE 錢包匯出的聊天文字檔；程式會自動辨識中文版或日文版。只找最近 120 天的付款；原始對話只在這次預覽使用，不會儲存在 CJ 或備份中。</p>
      <button type="button" className="pick-btn" disabled={busy} onClick={() => { setResetMode(false); fileInput.current?.click() }}><Icon name="inbox" />{busy ? '讀取中…' : '匯入新增訊息／首次建立基準點'}<small>每次選擇重新匯出的完整 LINE 錢包 .txt</small></button>
      <button type="button" className="btn-quiet line-chat-reset" disabled={busy} onClick={() => { setResetMode(true); fileInput.current?.click() }}>重設基準點</button>
    </>}
    {read && <>
      {read.format && <p className="line-chat-summary">已自動辨識：{read.format === 'ja' ? '日文版' : '中文版'} LINE 錢包對話檔</p>}
      {read.errors.length > 0 ? <ul className="warn-list">{read.errors.map((e) => <li key={e}>{e}</li>)}</ul> : resetMode || inspection?.kind === 'first' ? <div className="card">
        <h2>{baseline ? '重設基準點' : '建立首次基準點'}</h2>
        <p>檔案最後訊息：{inspection && localInput(inspection.last.at).replace('T', ' ')}</p>
        <p>{baseline ? '先前已記好的帳不會更動。' : '首次設定只建立起點，不會把舊付款記帳。'}</p>
        <p>將略過 {resetSkipped} 筆付款候選。</p>
        {resetHasGap && <p className="line-chat-blocked">找不到舊基準訊息；中間可能有缺口，略過筆數無法完整計算。</p>}
        {baseline && !canResetLineChatBaseline(read.messages, baseline) && <p className="line-chat-blocked">新檔最後訊息必須晚於目前基準點，才能重設。</p>}
        <button type="button" className="btn-primary" disabled={busy || !!(baseline && !canResetLineChatBaseline(read.messages, baseline))} onClick={() => void confirmBaseline()}>{busy ? '儲存中…' : '設為基準點'}</button>
      </div> : inspection?.kind === 'missing' || inspection?.kind === 'same_time' || inspection?.kind === 'out_of_order' ? <div className="card">
        <p className="line-chat-blocked">{inspection.kind === 'missing' ? '這份檔案找不到目前的基準訊息，已停止匯入。若剛切換中／日文版，相同付款的文字可能不同；請檢查檔案，確認後才能手動重設基準點，避免重複記帳。' : inspection.kind === 'same_time' ? '檔案最後訊息與基準點同時間、內容不同，無法證明先後順序。' : '檔案最後訊息早於目前基準點，已停止匯入。'}</p>
        <button type="button" className="btn-quiet" onClick={() => setResetMode(true)}>檢查重設基準點</button>
      </div> : inspection?.kind === 'ready' && <>
        <p className="line-chat-summary">檔案涵蓋 {read.coverage?.first}～{read.coverage?.last}；{duplicates} 筆已處理，{read.ignored} 則非付款訊息略過。</p>
        {inspection.expired > 0 && <p className="line-chat-blocked">{inspection.expired} 筆已超出 120 天，無法再補匯。</p>}
        <div className="counts"><span><b>{problems.length}</b>筆待處理問題</span><span><b>{deferred.length}</b>筆稍後處理</span><span><b>{selected.length}</b>筆已勾選</span><span><b>{permanentlySkipped.length}</b>筆不匯入</span></div>
        {[...byMonth].sort(([a], [b]) => b.localeCompare(a)).map(([month, group]) => <section key={month} className="line-chat-month">
          <div className="grp-title"><b>{month.replace('-', ' 年 ')} 月</b><span>{group.problem.length + group.selected.length + group.skipped.length} 筆</span></div>
          {(['problem', 'selected', 'skipped'] as const).map((section) => group[section].length > 0 && <section key={section} className={`line-chat-section line-chat-section-${section}`}>
            <h2 className="line-chat-section-title">{section === 'problem' ? '待處理問題／稍後處理' : section === 'selected' ? '已勾選・將匯入' : '不匯入'} <span>{group[section].length}</span></h2>
            <div className="card line-chat-group">{group[section].map((r) => rowView(r, section))}</div>
          </section>)}
        </section>)}
        {rows?.length === 0 && <p className="lead">最近 120 天沒有尚未處理的付款。</p>}
        <p className="set-foot">「不匯入」送出後會永久略過，下次不再出現。匯入完成後，請自行刪除「檔案」App 中的原始 .txt。</p>
        {problems.length > 0 && <p className="line-chat-blocked">請先處理或標記稍後處理的 {problems.length} 筆問題。</p>}
        <div className="foot-bar"><button type="button" className="btn-primary" disabled={busy || problems.length > 0 || selected.length + permanentlySkipped.length === 0} onClick={() => void commit()}>{busy ? '匯入中…' : `記帳 ${selected.length} 筆・不匯入 ${permanentlySkipped.length} 筆・稍後 ${deferred.length} 筆`}</button></div>
      </>}
      <button type="button" className="btn-quiet line-chat-reset" disabled={busy} onClick={() => { setRead(null); setRows(null); setInspection(null); setDuplicates(0); setResetMode(false) }}>重新選擇檔案</button>
    </>}
  </>
}
