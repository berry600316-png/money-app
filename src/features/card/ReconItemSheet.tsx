import { useState, type ReactNode } from 'react'
import { suggestCategory } from '../../card/categorize'
import { confirmBookOnly, deferToNext, explainEntryWithReason, matchManually, reconfirmExplanation, reconfirmPair, removeDecision, updateEntryExplanationReason, updateStatementEntry } from '../../card/cardRepo'
import { LAST_RECON_REASON_KEY, readReconReasons, RECON_REASONS_KEY } from '../../card/reconReasons'
import { txDate, type Item } from '../../card/reconcile'
import { dayDiff } from '../../card/text'
import { searchReconTransactions } from '../../card/reconSearch'
import { MoneyError } from '../../db/repo'
import { useSetting } from '../../db/hooks'
import type { CardStatement, Reconciliation, StatementEntry, Transaction, TxType } from '../../db/types'
import { fmt } from '../../lib/money'
import { BottomSheet } from '../../ui/BottomSheet'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'
import { KIND_LABELS } from './StatementImportPage'
import { ReconReasonManager, ReconReasonPicker } from './ReconReasonPicker'

type View = 'main' | 'find-tx' | 'find-entry' | 'explain' | 'edit-reason' | 'manage-reasons' | 'edit-entry'

const md = (ymd: string | null) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8))}` : '—')
const entryDate = (e: StatementEntry) => e.txDate ?? e.postDate ?? ''

/** Spec §8, §9.4: handle one item without leaving the reconciliation page. */
export function ReconItemSheet({
  item,
  statement,
  entries,
  transactions,
  recons,
  onClose,
  onEditTx,
  onRecordEntry,
}: {
  item: Item | null
  statement: CardStatement
  entries: readonly StatementEntry[]
  transactions: readonly Transaction[]
  recons: readonly Reconciliation[]
  onClose: () => void
  onEditTx: (id: string) => void
  onRecordEntry: (entry: StatementEntry, type: TxType, categoryId: string) => void
}) {
  const ref = useRefData()
  const toast = useToast()
  const reasonOptions = readReconReasons(useSetting<unknown>(RECON_REASONS_KEY, []))
  const lastReasonId = useSetting<string>(LAST_RECON_REASON_KEY, '')
  const [view, setView] = useState<View>('main')
  const [reasonReturnView, setReasonReturnView] = useState<'explain' | 'edit-reason'>('explain')
  const [categoryId, setCategoryId] = useState('other')
  const [reasonId, setReasonId] = useState('')
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [adjacentMonths, setAdjacentMonths] = useState(false)
  const [visibleCount, setVisibleCount] = useState(40)
  const [showEvidence, setShowEvidence] = useState(false)
  const [entryDraft, setEntryDraft] = useState<Pick<StatementEntry, 'merchant' | 'amount' | 'txDate' | 'postDate' | 'kind'> | null>(null)
  const [shown, setShown] = useState<Item | null>(null)
  const [last, setLast] = useState<Item | null>(null)
  if (item !== last) {
    setLast(item)
    if (item) {
      setShown(item)
      setView('main')
      setReasonId('')
      setBusy(false)
      setSearch('')
      setAdjacentMonths(false)
      setVisibleCount(40)
      setShowEvidence(false)
      if ('entry' in item) {
        setEntryDraft({ merchant: item.entry.merchant, amount: item.entry.amount, txDate: item.entry.txDate, postDate: item.entry.postDate, kind: item.entry.kind })
        const history = transactions.filter((t) => t.merchant).map((t) => ({ merchant: t.merchant, categoryId: t.categoryId }))
        setCategoryId(item.entry.kind === 'refund' || item.entry.kind === 'deposit'
          ? ref.categories.find((c) => c.type === 'income' && c.isActive)?.id ?? ''
          : suggestCategory(item.entry.merchant, history, ref.categories))
      }
    }
  }
  const it = item ?? shown
  const selectedReason = reasonOptions.find((r) => r.id === reasonId)
  const openExplain = () => {
    setReasonId(reasonOptions.some((r) => r.id === lastReasonId) ? lastReasonId : '')
    setView('explain')
  }
  const openEditReason = (note: string) => {
    setReasonId(reasonOptions.find((r) => r.label === note)?.id ?? '')
    setView('edit-reason')
  }
  const openReasonManager = () => {
    setReasonReturnView(view === 'edit-reason' ? 'edit-reason' : 'explain')
    setView('manage-reasons')
  }

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      toast(ok)
      onClose()
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '沒有存到，請再試一次', { kind: 'error' })
      setBusy(false)
    }
  }

  // Existing pairs reserve their records, including pairs awaiting renewed review.
  const pairedTx = new Set(recons.filter((r) => r.status === 'matched' && r.transactionId).map((r) => r.transactionId!))
  const pairedEntry = new Set(recons.filter((r) => r.status === 'matched' && r.entryId).map((r) => r.entryId!))

  const candidatesForEntry = (e: StatementEntry) =>
    searchReconTransactions(transactions, { entry: e, query: search,
      adjacentMonths, paymentMethods: ref.payments, excludedIds: pairedTx })
  const candidatesForTx = (t: Transaction) =>
    entries
      .filter((e) => !pairedEntry.has(e.id))
      .sort((a, b) => Math.abs(a.amount - t.amount) - Math.abs(b.amount - t.amount) || Math.abs(dayDiff(entryDate(a), txDate(t))) - Math.abs(dayDiff(entryDate(b), txDate(t))))

  const entry = it && 'entry' in it ? it.entry : null
  const tx = it && 'tx' in it ? it.tx : null
  const title = entry?.merchant ?? tx?.merchant ?? ''
  const amount = entry?.amount ?? tx?.amount ?? 0

  const txRow = (t: Transaction, onPick: () => void) => (
    <button type="button" className="rrow compact" key={t.id} onClick={onPick} disabled={busy}>
      <span className="row-main">
        <span className="row-title">{t.merchant || (t.type === 'transfer' ? '互轉' : ref.category(t.categoryId).name)}</span>
        <span className="state">
          {md(txDate(t))} · {t.type === 'transfer' ? '互轉' : t.type === 'income' ? '收入' : ref.category(t.categoryId).name} · {ref.payment(t.paymentMethodId).name}
          {entry && t.amount !== Math.abs(entry.amount) ? ` · 差 ${fmt(Math.abs(Math.abs(entry.amount) - t.amount))}` : ''}
        </span>
      </span>
      <span className="row-amt num">{fmt(t.amount)}</span>
    </button>
  )
  const entryRow = (e: StatementEntry, onPick: () => void) => (
    <button type="button" className="rrow compact" key={e.id} onClick={onPick} disabled={busy}>
      <span className="row-main">
        <span className="row-title">
          {e.merchant}
          {e.kind !== 'purchase' && <span className="kind-tag">{KIND_LABELS[e.kind]}</span>}
        </span>
        <span className="state">
          消費 {md(e.txDate)}
          {e.postDate ? ` · 入帳 ${md(e.postDate)}` : ''}
        </span>
      </span>
      <span className="row-amt num">{fmt(e.amount)}</span>
    </button>
  )

  const pairWith = (e: StatementEntry, t: Transaction) =>
    run(() => matchManually(statement.id, e.id, t.id), '已配對')
  const record = (e: StatementEntry, type?: TxType) => onRecordEntry(e,
    type ?? (e.kind === 'refund' || e.kind === 'deposit' ? 'income' : 'expense'), categoryId)

  let body: ReactNode = null
  if (it && view === 'edit-entry' && entry && entryDraft) {
    const setDraft = (key: keyof typeof entryDraft, value: string | number | null) => setEntryDraft((old) => old && { ...old, [key]: value })
    body = <>
      <p className="sheet-msg">修正這一條帳單明細後，原配對會撤銷並重新檢查；你的記帳不變。</p>
      <div className="meta-grid">
        <label className="full">項目名稱<input value={entryDraft.merchant} maxLength={60} onChange={(e) => setDraft('merchant', e.target.value)} /></label>
        <label>金額<input type="number" step="1" value={entryDraft.amount} onChange={(e) => setDraft('amount', Number(e.target.value))} /></label>
        <label>類型<select value={entryDraft.kind} onChange={(e) => setDraft('kind', e.target.value as StatementEntry['kind'])}>
          {Object.entries(KIND_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>交易日期<input type="date" value={entryDraft.txDate ?? ''} onChange={(e) => setDraft('txDate', e.target.value || null)} /></label>
        <label>入帳日期<input type="date" value={entryDraft.postDate ?? ''} onChange={(e) => setDraft('postDate', e.target.value || null)} /></label>
      </div>
      <button type="button" className="btn-primary" disabled={busy} onClick={() => run(() => updateStatementEntry(statement.id, entry.id, entryDraft), '帳單明細已修正，請重新核對')}>儲存修正</button>
      <button type="button" className="btn-quiet" onClick={() => setView('main')}>返回</button>
    </>
  } else if (it && view === 'manage-reasons') {
    body = <ReconReasonManager onSelect={setReasonId} />
  } else if (it && 'entry' in it && view === 'explain') {
    body = <>
      <p className="sheet-msg">選擇這筆金流已確認、但不另行記帳的原因。</p>
      <ReconReasonPicker selectedId={reasonId} onSelect={setReasonId} onManage={openReasonManager} />
      <button type="button" className="btn-primary" disabled={busy || !selectedReason} onClick={() => run(() => explainEntryWithReason(statement.id, it.entry.id, reasonId), '已人工確認')}>人工確認並打勾</button>
      <button type="button" className="btn-quiet" onClick={() => setView('main')}>返回</button>
    </>
  } else if (it && view === 'edit-reason' && it.kind === 'explained_entry') {
    body = <>
      <p className="sheet-msg">目前原因：{it.recon.note}</p>
      <ReconReasonPicker selectedId={reasonId} onSelect={setReasonId} onManage={openReasonManager} />
      <button type="button" className="btn-primary" disabled={busy || !selectedReason} onClick={() => run(() => updateEntryExplanationReason(it.recon.id, reasonId), '原因已更新')}>儲存原因</button>
      <button type="button" className="btn-quiet" onClick={() => setView('main')}>返回</button>
    </>
  } else if (it && view === 'find-tx' && entry) {
    const list = candidatesForEntry(entry)
    const month = entryDate(entry)?.slice(0, 7)
    body = (
      <>
        <p className="sheet-msg">{month ? `${month.replace('-', ' 年 ')} 月${adjacentMonths ? '及前後各一個月' : ''}的記帳，共 ${list.length} 筆` : '這筆帳單明細沒有日期，請先修正日期。'}</p>
        <input type="search" value={search} placeholder="搜尋商家、金額或日期" aria-label="搜尋既有紀錄" onChange={(e) => { setSearch(e.target.value); setVisibleCount(40) }} />
        {month && <button type="button" className="btn-quiet" onClick={() => { setAdjacentMonths(!adjacentMonths); setVisibleCount(40) }}>
          {adjacentMonths ? '只看交易月份' : '搜尋前後各一個月'}
        </button>}
        {list.length ? <div className="cand">{list.slice(0, visibleCount).map((t) => txRow(t, () => void pairWith(entry, t)))}</div> : <p className="sheet-msg">沒有找到符合條件的記帳。</p>}
        {list.length > visibleCount && <button type="button" className="btn-secondary" onClick={() => setVisibleCount(visibleCount + 40)}>顯示更多（還有 {list.length - visibleCount} 筆）</button>}
        <button type="button" className="btn-quiet" onClick={() => setView('main')}>
          返回
        </button>
      </>
    )
  } else if (it && view === 'find-entry' && tx) {
    const list = candidatesForTx(tx)
    body = (
      <>
        <p className="sheet-msg">選這期帳單中對應的那一筆。</p>
        {list.length ? <div className="cand">{list.map((e) => entryRow(e, () => void pairWith(e, tx)))}</div> : <p className="sheet-msg">這期帳單沒有尚未配對的明細。</p>}
        <button type="button" className="btn-quiet" onClick={() => setView('main')}>
          返回
        </button>
      </>
    )
  } else if (it) {
    const hero = (
      <div className="sheet-hero">
        <div className="m">{title || '（未填商店）'}</div>
        <div className="amt-big">NT${fmt(Math.abs(amount))}</div>
        <div className="d">
          {entry ? `消費 ${md(entry.txDate)}${entry.postDate ? ` · 入帳 ${md(entry.postDate)}` : ''}` : tx ? `記帳日 ${md(txDate(tx))}` : ''}
        </div>
        {statement.statementType === 'debit_card' && entry?.evidence && <div className="d">
          帳單證據：{entry.evidence === 'both' ? '金融卡消費與銀行流水' : entry.evidence === 'card' ? '金融卡消費' : '銀行流水'}
        </div>}
      </div>
    )
    switch (it.kind) {
      case 'bank_only':
        body = (
          <>
            {hero}
            <p className="sheet-msg">{it.entry.kind === 'withdrawal' ? '銀行流水有這筆提款；可直接寫原因確認，不必補記每筆現金用途。' : '銀行帳單有這筆交易，但找不到對應的記帳。'}</p>
            {it.entry.kind !== 'withdrawal' && <button type="button" className="btn-primary" onClick={() => record(it.entry)}>
              補記並核對
            </button>}
            {(it.entry.kind === 'transfer_out' || it.entry.kind === 'deposit') && <button type="button" className="btn-secondary" onClick={() => record(it.entry, 'transfer')}>補記為互轉</button>}
            <button type="button" className="btn-secondary" onClick={() => setView('find-tx')}>
              尋找既有紀錄
            </button>
            <button type="button" className="btn-quiet" onClick={openExplain}>
              人工確認，不補記
            </button>
            <button type="button" className="btn-quiet" onClick={onClose}>
              保留待確認
            </button>
          </>
        )
        break
      case 'book_only':
        body = (
          <>
            {hero}
            <p className="sheet-msg">你記了這筆，但這期帳單找不到。可能是還沒請款，下期才會出現。</p>
            {statement.statementType !== 'debit_card' && <button type="button" className="btn-primary" onClick={() => run(() => deferToNext(statement.id, it.tx.id), '已標為等待下期帳單')}>
              等待下期帳單
            </button>}
            <button type="button" className="btn-secondary" onClick={() => setView('find-entry')}>
              尋找對應帳單明細
            </button>
            <button type="button" className="btn-quiet" onClick={() => onEditTx(it.tx.id)}>
              編輯原記帳資料
            </button>
            <button type="button" className="btn-primary" onClick={() => run(() => confirmBookOnly(statement.id, it.tx.id), '已人工確認')}>這筆是真的，打勾</button>
          </>
        )
        break
      case 'amount_diff':
        body = (
          <>
            <div className="pair">
              <div>
                <span className="lbl">你的記帳</span>
                <span className="v">{fmt(it.tx.amount)}</span>
                <div className="s">
                  {it.tx.merchant || '—'} · {md(txDate(it.tx))}
                </div>
              </div>
              <div>
                <span className="lbl">銀行帳單</span>
                <span className="v">{fmt(it.entry.amount)}</span>
                <div className="s">
                  {it.entry.merchant} · {md(it.entry.txDate)}
                </div>
              </div>
            </div>
            <p className="sheet-msg">
              差額 NT${fmt(Math.abs(it.diff))}。可能有手續費、小費或記錯金額；不會自動改你的記帳。
            </p>
            <button type="button" className="btn-secondary" onClick={() => void pairWith(it.entry, it.tx)}>
              就是這筆，金額差異已了解
            </button>
            <button type="button" className="btn-quiet" onClick={() => setView('find-tx')}>
              尋找其他對應交易
            </button>
            <button type="button" className="btn-quiet" onClick={onClose}>
              保留待確認
            </button>
          </>
        )
        break
      case 'ambiguous':
        body = (
          <>
            {hero}
            <p className="sheet-msg">有 {it.candidates.length} 筆記帳都可能是這筆，請選正確的那一筆。</p>
            <div className="cand">{it.candidates.filter((t) => !pairedTx.has(t.id)).map((t) => txRow(t, () => void pairWith(it.entry, t)))}</div>
            <button type="button" className="btn-quiet" onClick={() => record(it.entry)}>
              都不是，補記一筆新的
            </button>
          </>
        )
        break
      case 'special':
        body = (
          <>
            {hero}
            <p className="sheet-msg">這是「{KIND_LABELS[it.entry.kind]}」類的交易，不會自動核對。</p>
            {it.entry.kind === 'refund' && <button type="button" className="btn-primary" onClick={() => record(it.entry, 'income')}>補記為收入</button>}
            {it.entry.amount > 0 && ['fee', 'installment'].includes(it.entry.kind) && (
              <button type="button" className="btn-primary" onClick={() => record(it.entry)}>
                補記為支出
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => setView('find-tx')}>
              和既有記帳配對
            </button>
            <button type="button" className="btn-quiet" onClick={openExplain}>
              不需記帳，填寫原因
            </button>
          </>
        )
        break
      case 'broken':
        body = (
          <>
            {hero}
            <p className="sheet-msg">{it.reason}，原本的核對結果已失效。</p>
            {it.tx && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => run(() => reconfirmPair(it.recon.id), '已重新確認配對')}
              >
                仍然是這筆（以目前記帳為準）
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => run(() => removeDecision(it.recon.id), '已取消配對，重新核對')}>
              取消配對，重新核對
            </button>
          </>
        )
        break
      case 'broken_explanation':
        body = <>
          {hero}
          <p className="sheet-msg">{it.reason}。先前的人工確認「{it.recon.note}」已失效。</p>
          <button type="button" className="btn-primary" onClick={() => run(() => reconfirmExplanation(it.recon.id), '已重新人工確認')}>重新確認這筆</button>
          <button type="button" className="btn-secondary" onClick={() => run(() => removeDecision(it.recon.id), '已取消人工確認')}>取消確認，重新核對</button>
        </>
        break
      case 'matched':
        body = (
          <>
            {hero}
            {statement.statementType === 'debit_card' && it.entry.evidence && <p className="sheet-msg">
              帳單證據：{it.entry.evidence === 'both' ? '金融卡消費與銀行流水' : it.entry.evidence === 'card' ? '金融卡消費' : '銀行流水'}
            </p>}
            <p className="sheet-msg">{it.auto ? '自動核對' : it.recon?.method === 'created' ? '由帳單補記' : '手動配對'}</p>
            <button type="button" className="btn-quiet" onClick={() => setShowEvidence(!showEvidence)}>{showEvidence ? '收起核對依據' : '查看核對依據'}</button>
            {showEvidence && <>
                <div className="pair">
                  <div><span className="lbl">你的記帳</span><span className="v">{fmt(it.tx.amount)}</span><div className="s">{it.tx.merchant || '—'} · {md(txDate(it.tx))}</div></div>
                  <div><span className="lbl">銀行帳單</span><span className="v">{fmt(it.entry.amount)}</span><div className="s">{it.entry.merchant} · {md(it.entry.txDate)}</div></div>
                </div>
                <p className="sheet-msg">{it.recon?.note || '帳單與記帳內容相符'}</p>
            </>}
            {it.recon && (
              <button type="button" className="btn-quiet" onClick={() => run(() => removeDecision(it.recon!.id), '已取消配對')}>
                取消配對
              </button>
            )}
          </>
        )
        break
      case 'pending_next':
        body = (
          <>
            {hero}
            <p className="sheet-msg">這筆記帳仍未與本期帳單配對。你可找對應明細，或自行確認。</p>
            <button type="button" className="btn-secondary" onClick={() => setView('find-entry')}>
              尋找對應帳單明細
            </button>
            <button type="button" className="btn-primary" onClick={() => run(() => confirmBookOnly(statement.id, it.tx.id), '已人工確認')}>這筆是真的，打勾</button>
            {it.recon && (
              <button type="button" className="btn-quiet" onClick={() => run(() => removeDecision(it.recon!.id), '已取消等待')}>
                取消「等待下期」
              </button>
            )}
          </>
        )
        break
      case 'explained_entry':
      case 'explained_tx':
        body = (
          <>
            {hero}
            <p className="sheet-msg">{it.kind === 'explained_tx' ? '人工確認：這筆記帳是真的，目前沒有帳單配對。' : `不需記帳：${it.recon.note}`}</p>
            {it.kind === 'explained_entry' && <button type="button" className="btn-secondary" onClick={() => openEditReason(it.recon.note)}>修改確認原因</button>}
            {it.kind === 'explained_tx' && <button type="button" className="btn-secondary" onClick={() => setView('find-entry')}>尋找帳單明細</button>}
            <button type="button" className="btn-quiet" onClick={() => run(() => removeDecision(it.recon.id), '已取消說明')}>
              取消說明
            </button>
          </>
        )
        break
    }
  }

  if (it && view === 'main' && entry) body = <>{body}<button type="button" className="btn-quiet" onClick={() => setView('edit-entry')}>修正這條帳單明細</button></>

  return (
    <BottomSheet
      open={item !== null}
      onClose={view === 'manage-reasons' ? () => setView(reasonReturnView) : onClose}
      labelledBy="recon-item-title"
      head={
        <div className="sheet-bar">
          <button type="button" className="txt-btn" onClick={view === 'manage-reasons' ? () => setView(reasonReturnView) : onClose}>
            {view === 'manage-reasons' ? '返回' : '關閉'}
          </button>
          <h2 id="recon-item-title">{view === 'manage-reasons' ? '管理確認原因' : '核對'}</h2>
          <span />
        </div>
      }
    >
      <div className="sheet-body">{body}</div>
    </BottomSheet>
  )
}
