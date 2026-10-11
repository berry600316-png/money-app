import { useState, type ReactNode } from 'react'
import { suggestCategory } from '../../card/categorize'
import { applyStatementAmount, deferToNext, explain, matchManually, reconfirmPair, recordFromEntry, removeDecision } from '../../card/cardRepo'
import { pairStillValid, txDate, type Item } from '../../card/reconcile'
import { dayDiff } from '../../card/text'
import { MoneyError } from '../../db/repo'
import type { CardStatement, Reconciliation, StatementEntry, Transaction } from '../../db/types'
import { fmt } from '../../lib/money'
import { BottomSheet } from '../../ui/BottomSheet'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'
import { KIND_LABELS } from './StatementImportPage'

type View = 'main' | 'record' | 'find-tx' | 'find-entry'

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
}: {
  item: Item | null
  statement: CardStatement
  entries: readonly StatementEntry[]
  transactions: readonly Transaction[]
  recons: readonly Reconciliation[]
  onClose: () => void
  onEditTx: (id: string) => void
}) {
  const ref = useRefData()
  const toast = useToast()
  const [view, setView] = useState<View>('main')
  const [categoryId, setCategoryId] = useState('other')
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<Item | null>(null)
  const [last, setLast] = useState<Item | null>(null)
  if (item !== last) {
    setLast(item)
    if (item) {
      setShown(item)
      setView('main')
      setBusy(false)
      if ('entry' in item) {
        const history = transactions.filter((t) => t.merchant).map((t) => ({ merchant: t.merchant, categoryId: t.categoryId }))
        setCategoryId(suggestCategory(item.entry.merchant, history, ref.categories))
      }
    }
  }
  const it = item ?? shown

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

  // Records that are free to pair (not validly paired on any statement).
  const txById = new Map(transactions.map((t) => [t.id, t]))
  const pairedTx = new Set(recons.filter((r) => r.status === 'matched' && r.transactionId && !pairStillValid(r, txById.get(r.transactionId))).map((r) => r.transactionId!))
  const pairedEntry = new Set(recons.filter((r) => r.status === 'matched' && r.entryId).map((r) => r.entryId!))

  const candidatesForEntry = (e: StatementEntry) =>
    transactions
      .filter((t) => t.type === 'expense' && !pairedTx.has(t.id) && Math.abs(dayDiff(entryDate(e), txDate(t))) <= 15)
      .sort((a, b) => Math.abs(a.amount - e.amount) - Math.abs(b.amount - e.amount) || Math.abs(dayDiff(entryDate(e), txDate(a))) - Math.abs(dayDiff(entryDate(e), txDate(b))))
      .slice(0, 30)
  const candidatesForTx = (t: Transaction) =>
    entries
      .filter((e) => e.kind !== 'payment' && !pairedEntry.has(e.id))
      .sort((a, b) => Math.abs(a.amount - t.amount) - Math.abs(b.amount - t.amount) || Math.abs(dayDiff(entryDate(a), txDate(t))) - Math.abs(dayDiff(entryDate(b), txDate(t))))
      .slice(0, 30)

  const entry = it && 'entry' in it ? it.entry : null
  const tx = it && 'tx' in it ? it.tx : null
  const title = entry?.merchant ?? tx?.merchant ?? ''
  const amount = entry?.amount ?? tx?.amount ?? 0

  const txRow = (t: Transaction, onPick: () => void) => (
    <button type="button" className="rrow compact" key={t.id} onClick={onPick} disabled={busy}>
      <span className="row-main">
        <span className="row-title">{t.merchant || ref.category(t.categoryId).name}</span>
        <span className="state">
          {md(txDate(t))} · {ref.category(t.categoryId).name}
          {entry && t.amount !== entry.amount ? ` · 差 ${fmt(Math.abs(entry.amount - t.amount))}` : ''}
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
    run(() => matchManually(statement.id, e.id, t.id, e.amount === t.amount ? '' : `金額不同（帳單 ${e.amount}，記帳 ${t.amount}）`), '已配對')

  let body: ReactNode = null
  if (it && view === 'record' && entry) {
    body = (
      <>
        <p className="sheet-msg">用帳單上的金額、商店、消費日與這張卡建立一筆支出，並直接完成核對。</p>
        <div className="meta-grid" style={{ marginTop: 0 }}>
          <label className="full">
            分類
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {ref.categories
                .filter((c) => c.type === 'expense' && c.isActive)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => run(() => recordFromEntry(statement.id, entry.id, categoryId), '已補記並核對')}>
          補記並核對
        </button>
        <button type="button" className="btn-quiet" onClick={() => setView('main')}>
          返回
        </button>
      </>
    )
  } else if (it && view === 'find-tx' && entry) {
    const list = candidatesForEntry(entry)
    body = (
      <>
        <p className="sheet-msg">選一筆你已經記過的消費和這筆帳單明細配對（前後 15 天、同一張卡）。</p>
        {list.length ? <div className="cand">{list.map((t) => txRow(t, () => void pairWith(entry, t)))}</div> : <p className="sheet-msg">前後 15 天沒有可配對的記帳。</p>}
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
      </div>
    )
    switch (it.kind) {
      case 'bank_only':
        body = (
          <>
            {hero}
            <p className="sheet-msg">銀行帳單有這筆交易，但找不到對應的記帳。</p>
            <button type="button" className="btn-primary" onClick={() => setView('record')}>
              補記這筆消費
            </button>
            <button type="button" className="btn-secondary" onClick={() => setView('find-tx')}>
              尋找既有紀錄
            </button>
            <button type="button" className="btn-quiet" onClick={() => run(() => explain(statement.id, { entryId: it.entry.id }, '不需記帳'), '已標為不需記帳')}>
              不需要記帳（標為已說明）
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
            <button type="button" className="btn-primary" onClick={() => run(() => deferToNext(statement.id, it.tx.id), '已標為等待下期帳單')}>
              等待下期帳單
            </button>
            <button type="button" className="btn-secondary" onClick={() => setView('find-entry')}>
              尋找對應帳單明細
            </button>
            <button type="button" className="btn-quiet" onClick={() => onEditTx(it.tx.id)}>
              編輯原記帳資料
            </button>
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
            <button type="button" className="btn-primary" onClick={() => run(() => applyStatementAmount(statement.id, it.entry.id, it.tx.id), '已改成帳單金額並核對')}>
              把記帳改成 {fmt(it.entry.amount)}
            </button>
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
            <div className="cand">{it.candidates.map((t) => txRow(t, () => void pairWith(it.entry, t)))}</div>
            <button type="button" className="btn-quiet" onClick={() => setView('record')}>
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
            {it.entry.amount > 0 && (
              <button type="button" className="btn-primary" onClick={() => setView('record')}>
                補記為支出
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => setView('find-tx')}>
              和既有記帳配對
            </button>
            <button type="button" className="btn-quiet" onClick={() => run(() => explain(statement.id, { entryId: it.entry.id }, KIND_LABELS[it.entry.kind]), '已標為已說明')}>
              標為已說明
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
      case 'matched':
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
            <p className="sheet-msg">{it.auto ? '自動核對' : it.recon?.method === 'created' ? '由帳單補記' : '手動配對'}{it.recon?.note ? ` · ${it.recon.note}` : ''}</p>
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
            <p className="sheet-msg">{it.why === 'deferred' ? '你標記為等待下期帳單。' : '接近結帳日的消費常在下期才列帳，暫時不算問題。'}</p>
            <button type="button" className="btn-secondary" onClick={() => setView('find-entry')}>
              尋找對應帳單明細
            </button>
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
            <p className="sheet-msg">已說明：{it.recon.note || '—'}</p>
            <button type="button" className="btn-quiet" onClick={() => run(() => removeDecision(it.recon.id), '已取消說明')}>
              取消說明
            </button>
          </>
        )
        break
    }
  }

  return (
    <BottomSheet
      open={item !== null}
      onClose={onClose}
      labelledBy="recon-item-title"
      head={
        <div className="sheet-bar">
          <button type="button" className="txt-btn" onClick={onClose}>
            關閉
          </button>
          <h2 id="recon-item-title">核對</h2>
          <span />
        </div>
      }
    >
      <div className="sheet-body">{body}</div>
    </BottomSheet>
  )
}
