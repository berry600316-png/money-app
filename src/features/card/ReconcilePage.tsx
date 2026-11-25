import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { completeStatementReview, deleteStatement, reopenStatementReview, saveAutoPairs } from '../../card/cardRepo'
import { reconcileLedger } from '../../card/ledgerReconcile'
import { txDate, type Item } from '../../card/reconcile'
import { db } from '../../db/db'
import { MoneyError } from '../../db/repo'
import type { PaymentMethod, StatementEntry } from '../../db/types'
import { useBalances } from '../../db/hooks'
import { fromYmd } from '../../lib/dates'
import { fmt } from '../../lib/money'
import { monthKeyLabel } from '../../lib/months'
import { ActionSheet } from '../../ui/ActionSheet'
import { Icon } from '../../ui/Icon'
import { Overlay } from '../../ui/overlay'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'
import { ReconItemSheet } from './ReconItemSheet'
import { KIND_LABELS } from './StatementImportPage'

const md = (ymd: string | null) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8))}` : '—')

const STATE_TEXT: Partial<Record<Item['kind'], string>> = {
  bank_only: '帳單有、記帳沒有',
  book_only: '記帳有、帳單沒有',
  ambiguous: '有多筆可能的記帳',
  amount_diff: '金額不一致',
  special: '特殊交易',
  broken: '記帳已變更',
  broken_explanation: '人工確認需重對',
  pending_next: '等待下期帳單',
}

/** Spec §9.3: overview → problems → matched → statement info. */
export function ReconcilePage({
  statementId,
  onBack,
  backLabel,
  onImportStatement,
  onEditTx,
  onPayCard,
}: {
  statementId: string | null
  onBack: () => void
  backLabel: string
  onImportStatement: () => void
  onEditTx: (id: string) => void
  /** D-119: pay this card's bill (a transfer from its paying account; never a new expense). */
  onPayCard: (card: PaymentMethod, pending: number) => void
}) {
  const ref = useRefData()
  const balances = useBalances()
  const toast = useToast()
  const [chosen, setChosen] = useState<string | null>(statementId)
  const [selected, setSelected] = useState<Item | null>(null)
  const [reviewConfirmed, setReviewConfirmed] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const statements = useLiveQuery(() => db.cardStatements.toArray().then((s) => s.sort((a, b) => (a.statementMonth < b.statementMonth ? 1 : -1))), [])
  const st = statements?.find((s) => s.id === chosen) ?? statements?.[0] ?? null
  const data = useLiveQuery(async () => {
    if (!st) return null
    const [entries, transactions, recons] = await Promise.all([
      db.statementEntries.where('statementId').equals(st.id).toArray(),
      db.transactions.toArray(),
      db.reconciliations.toArray(),
    ])
    return { entries, transactions, recons }
  }, [st?.id, st?.paymentMethodId])

  const result = useMemo(() => (st && data ? reconcileLedger({ statement: st, entries: data.entries, transactions: data.transactions,
    recons: data.recons, paymentMethods: ref.payments }) : null), [st, data, ref.payments])

  // Save newly found reliable pairs once; the live query then shows them as matched.
  const savedKey = useRef('')
  useEffect(() => {
    if (!st || st.parseStatus === 'needs_reimport' || st.reviewCompleted || !result?.autoPairs.length) return
    const key = st.id + result.autoPairs.map((p) => p.entryId + p.transactionId).join()
    if (savedKey.current === key) return
    savedKey.current = key
    saveAutoPairs(st.id, result.autoPairs).catch(() => toast('自動核對結果沒有存到', { kind: 'error' }))
  }, [st, result, toast])

  const head = (
    <div className="page-head">
      <button type="button" className="back" onClick={onBack}>
        <Icon name="left" />
        {backLabel}
      </button>
      <h1>{st?.statementType === 'debit_card' ? '金融卡與帳戶核對' : '信用卡核對'}</h1>
      <button type="button" className="head-action" onClick={onImportStatement}>
        匯入帳單
      </button>
    </div>
  )

  if (statements === undefined) return head
  if (!st) {
    return (
      <>
        {head}
        <div className="empty">
          <strong>還沒有銀行帳單</strong>
          匯入信用卡或金融卡 PDF 帳單後，就能和你的記帳逐筆核對。
          <br />
          <button type="button" className="btn-soft" onClick={onImportStatement}>
            匯入 PDF 帳單
          </button>
        </div>
      </>
    )
  }
  if (st.parseStatus === 'needs_reimport') return <>
    {head}
    <div className="notice" style={{ marginTop: 24 }}>
      <Icon name="alert" />
      <div>
        <b>舊帳單需要重新匯入</b>
        <p>舊版沒有保存原始 PDF。請重新上傳這期帳單，再和記帳逐筆核對。</p>
        <button type="button" className="chip-btn" onClick={onImportStatement}>重新匯入並審閱</button>
      </div>
    </div>
  </>
  if (!result || !data) return head

  if (st.reviewCompleted) return <>
    {head}
    <div className="done-all" style={{ marginTop: 24 }}><Icon name="check" />這期上次已完成核對</div>
    <div className="card" style={{ padding: 20, marginTop: 12 }}>
      <p>記帳已核對 {st.reviewCompleted.bookDone}／{st.reviewCompleted.bookTotal} 筆</p>
      <p>帳單已處理 {st.reviewCompleted.statementDone}／{st.reviewCompleted.statementTotal} 筆</p>
      <p className="set-foot">完成於 {new Date(st.reviewCompleted.at).toLocaleString('zh-TW')}。重新開啟後，才會依目前記帳重新計算。</p>
      <button type="button" className="btn-primary" onClick={() => reopenStatementReview(st.id).then(() => setReviewConfirmed(false), (e) => toast(e instanceof MoneyError ? e.message : '無法重新開啟', { kind: 'error' }))}>重新開啟核對</button>
    </div>
    {statements.length > 1 && <div className="card" style={{ marginTop: 20 }}>
      {statements.filter((x) => x.id !== st.id).map((x) => <button type="button" className="rrow compact" key={x.id} onClick={() => { setChosen(x.id); setReviewConfirmed(false) }}>
        <span className="row-main"><span className="row-title">{monthKeyLabel(x.statementMonth)}</span><span className="state">{ref.payment(x.paymentMethodId).name}</span></span>
        <Icon name="chev" className="chev" />
      </button>)}
    </div>}
  </>

  const progress = result.progress
  const items = result.items
  const of = (k: Item['kind']) => items.filter((i) => i.kind === k)
  const review = [...of('ambiguous'), ...of('amount_diff'), ...of('broken'), ...of('broken_explanation')]
  const matched = [...of('matched'), ...of('explained_tx')]
  const noBook = of('explained_entry')
  const statementMissing = [...of('bank_only'), ...of('special')]
  const bookMissing = [...of('book_only'), ...of('pending_next')]
  const problems = statementMissing.length + bookMissing.length + review.length
  const card = ref.payment(st.paymentMethodId)

  const label = (it: Item) => {
    const e: StatementEntry | null = 'entry' in it ? it.entry : null
    const t = 'tx' in it ? it.tx : null
    const merchant = e?.merchant ?? t?.merchant ?? ''
    const amount = e?.amount ?? t?.amount ?? 0
    const date = e ? md(e.txDate ?? e.postDate) : t ? md(txDate(t)) : ''
    return { merchant: merchant || '（未填商店）', amount, date }
  }

  const row = (it: Item, i: number, compact = false) => {
    const l = label(it)
    const done = it.kind === 'matched' || it.kind === 'explained_entry' || it.kind === 'explained_tx'
    return (
      <button type="button" className={'rrow' + (compact ? ' compact' : '')} key={it.kind + i} onClick={() => setSelected(it)}>
        <span className="row-main">
          <span className="row-title">
            {l.merchant}
            {'entry' in it && it.entry.kind !== 'purchase' && <span className="kind-tag">{KIND_LABELS[it.entry.kind]}</span>}
            {'entry' in it && st.statementType === 'debit_card' && <span className="kind-tag">{it.entry.evidence === 'both' ? '消費＋帳戶' : it.entry.evidence === 'card' ? '金融卡消費' : '帳戶流水'}</span>}
          </span>
          <span className={'state' + (done ? '' : ' attn')}>
            {l.date}
            {!done && STATE_TEXT[it.kind] ? ` · ${STATE_TEXT[it.kind]}` : ''}
            {it.kind === 'amount_diff' && ` 差 ${fmt(Math.abs(it.diff))}`}
            {it.kind === 'explained_entry' ? ' · 不需記帳' : ''}
          </span>
          {it.kind === 'matched' && <span className="state">記帳：{it.tx.merchant || '（未填名稱）'} · {md(txDate(it.tx))} · {fmt(it.tx.amount)}</span>}
        </span>
        <span className="row-amt num">{fmt(l.amount)}</span>
        {done && <Icon name="check" className="ok" />}
      </button>
    )
  }

  const group = (title: string, basis: string, list: Item[]) =>
    list.length > 0 && (
      <>
        <div className="grp-title">
          <b>{title}</b>
          <span>{basis}</span>
        </div>
        <div className="card">{[...list].sort((a, b) => 'entry' in a && 'entry' in b ? a.entry.order - b.entry.order
          : 'tx' in a && 'tx' in b && a.tx && b.tx ? txDate(a.tx).localeCompare(txDate(b.tx)) : 0).map((it, i) => row(it, i))}</div>
      </>
    )

  return (
    <>
      {head}
      <section className="recon-head">
        <div className="eyebrow">
          <span>
            {card.name}
            {card.cardLast4 ? ` · ${card.cardLast4}` : ''}
          </span>
          <span>{monthKeyLabel(st.statementMonth)}帳單</span>
        </div>
        <div className="recon-sum">
          <div><span>記帳已核對<small>{monthKeyLabel(st.statementMonth)}・{card.name}</small></span><b>{progress.bookDone}／{progress.bookTotal}</b></div>
          <div><span>帳單已處理<small>包含本期每條金流</small></span><b>{progress.statementDone}／{progress.statementTotal}</b></div>
        </div>
        {st.parseStatus !== 'confirmed' && <p className="set-foot">帳單待檢查：可先自動配對，完成前請確認明細正確完整。</p>}
      </section>

      {/* D-119: paying the bill moves money from the paying account; the purchases were already counted. */}
      {st.statementType !== 'debit_card' && <button type="button" className="acc-link" onClick={() => onPayCard(card, balances?.get(card.id) ?? 0)}>
        <span>
          繳這期卡費
          <small>{card.payFromId ? `從 ${ref.payment(card.payFromId).name} 扣，` : ''}不算支出</small>
        </span>
        <span>
          {balances?.has(card.id) && (
            <>
              預扣 <b className="num">{fmt(balances.get(card.id)!)}</b>{' '}
            </>
          )}
          ›
        </span>
      </button>}

      {problems > 0 && (
        <div className="grp-title" style={{ marginTop: 26 }}>
          <b style={{ fontSize: '1.0625rem' }}>需要處理</b>
          <span>共 {problems} 筆</span>
        </div>
      )}
      {group('帳單找不到記帳', `${statementMissing.length} 筆・可找既有記帳、補記或註明不需記帳`, statementMissing)}
      {group('記帳找不到帳單', `${bookMissing.length} 筆・可尋找帳單或人工確認`, bookMissing)}
      {group('配對有疑問', `${review.length} 筆・請逐筆確認`, review)}
      {group('已對上', `${matched.length} 筆`, matched)}
      {group('不需記帳', `${noBook.length} 筆・已填寫原因`, noBook)}
      {problems === 0 && <div className="card" style={{ padding: 18, marginTop: 20 }}>
        <label className="check-row"><input type="checkbox" checked={reviewConfirmed} onChange={(e) => setReviewConfirmed(e.target.checked)} /><span>我已確認這份帳單的明細正確完整</span></label>
        <button type="button" className="btn-primary" disabled={!reviewConfirmed} onClick={() => completeStatementReview(st.id).then(() => toast('這期帳單已完成核對'), (e) => toast(e instanceof MoneyError ? e.message : '無法完成核對', { kind: 'error' }))}>完成本期核對</button>
      </div>}

      <div className="grp-title" style={{ marginTop: 28 }}>
        <b>帳單資訊</b>
      </div>
      <div className="set-card">
        <div className="srow">
          <span className="s-main">帳單週期</span>
          <span className="s-val">
            {st.periodStart && st.periodEnd ? `${fromYmd(st.periodStart).getMonth() + 1}/${fromYmd(st.periodStart).getDate()} – ${md(st.periodEnd)}` : '未確認'}
          </span>
        </div>
        {st.statementType !== 'debit_card' && <div className="srow">
          <span className="s-main">繳款截止日</span>
          <span className="s-val">{st.dueDate ?? '—'}</span>
        </div>}
        <div className="srow">
          <span className="s-main">
            來源檔案<span className="s-sub">{st.fileName}</span>
          </span>
          <span className="s-val">{st.parseStatus === 'confirmed' ? '已確認' : '待確認'}</span>
        </div>
      </div>

      {statements.length > 1 && (
        <>
          <div className="grp-title" style={{ marginTop: 22 }}>
            <b>其他帳單</b>
          </div>
          <div className="card">
            {statements
              .filter((x) => x.id !== st.id)
              .map((x) => (
                <button type="button" className="rrow compact" key={x.id} onClick={() => { setChosen(x.id); setReviewConfirmed(false) }}>
                  <span className="row-main">
                    <span className="row-title">{monthKeyLabel(x.statementMonth)}</span>
                    <span className="state">{ref.payment(x.paymentMethodId).name}</span>
                  </span>
                  <Icon name="chev" className="chev" />
                </button>
              ))}
          </div>
        </>
      )}

      <button type="button" className="btn-danger-quiet" style={{ marginTop: 18 }} onClick={() => setConfirmDelete(true)}>
        刪除這份帳單
      </button>

      <Overlay>
        <ReconItemSheet
          item={selected}
          statement={st}
          entries={data.entries}
          transactions={data.transactions}
          recons={data.recons}
          onClose={() => setSelected(null)}
          onEditTx={(id) => {
            setSelected(null)
            onEditTx(id)
          }}
        />
        <ActionSheet
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title="刪除這份帳單？"
          message="帳單明細與核對紀錄會一起刪除；你的記帳資料不受影響，之後可以重新匯入 PDF。"
          actions={[
            {
              label: '刪除帳單',
              danger: true,
              onClick: () => {
                setConfirmDelete(false)
                deleteStatement(st.id).then(
                  () => {
                    setChosen(null)
                    toast('已刪除帳單')
                  },
                  () => toast('刪除失敗', { kind: 'error' }),
                )
              },
            },
          ]}
        />
      </Overlay>
    </>
  )
}
