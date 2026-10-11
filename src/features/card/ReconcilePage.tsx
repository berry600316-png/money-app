import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { deleteStatement, saveAutoPairs, updateStatement } from '../../card/cardRepo'
import { reconcile, txDate, type Item } from '../../card/reconcile'
import { db } from '../../db/db'
import { MoneyError } from '../../db/repo'
import type { StatementEntry } from '../../db/types'
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
  pending_next: '等待下期帳單',
}

/** Spec §9.3: overview → problems → matched → statement info. */
export function ReconcilePage({
  statementId,
  onBack,
  backLabel,
  onImportStatement,
  onEditTx,
}: {
  statementId: string | null
  onBack: () => void
  backLabel: string
  onImportStatement: () => void
  onEditTx: (id: string) => void
}) {
  const ref = useRefData()
  const toast = useToast()
  const [chosen, setChosen] = useState<string | null>(statementId)
  const [selected, setSelected] = useState<Item | null>(null)
  const [showMatched, setShowMatched] = useState(false)
  const [showPending, setShowPending] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [period, setPeriod] = useState({ start: '', end: '' })

  const statements = useLiveQuery(() => db.cardStatements.toArray().then((s) => s.sort((a, b) => (a.statementMonth < b.statementMonth ? 1 : -1))), [])
  const st = statements?.find((s) => s.id === chosen) ?? statements?.[0] ?? null
  const data = useLiveQuery(async () => {
    if (!st) return null
    const [entries, transactions, recons] = await Promise.all([
      db.statementEntries.where('statementId').equals(st.id).toArray(),
      db.transactions.where('paymentMethodId').equals(st.paymentMethodId).toArray(),
      db.reconciliations.toArray(),
    ])
    return { entries, transactions, recons }
  }, [st?.id, st?.paymentMethodId])

  const result = useMemo(() => (st && data ? reconcile({ statement: st, entries: data.entries, transactions: data.transactions, recons: data.recons }) : null), [st, data])

  // Save newly found reliable pairs once; the live query then shows them as matched.
  const savedKey = useRef('')
  useEffect(() => {
    if (!st || !result?.autoPairs.length) return
    const key = st.id + result.autoPairs.map((p) => p.entryId + p.transactionId).join()
    if (savedKey.current === key) return
    savedKey.current = key
    saveAutoPairs(st.id, result.autoPairs).catch(() => toast('自動核對結果沒有存到', { kind: 'error' }))
  }, [st, result, toast])

  useEffect(() => {
    if (st) setPeriod({ start: st.periodStart ?? '', end: st.periodEnd ?? '' })
  }, [st?.id, st?.periodStart, st?.periodEnd]) // eslint-disable-line react-hooks/exhaustive-deps

  const head = (
    <div className="page-head">
      <button type="button" className="back" onClick={onBack}>
        <Icon name="left" />
        {backLabel}
      </button>
      <h1>信用卡核對</h1>
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
          匯入信用卡 PDF 電子帳單後，會自動和你記的信用卡消費比對，只把有問題的列出來。
          <br />
          <button type="button" className="btn-soft" onClick={onImportStatement}>
            匯入 PDF 帳單
          </button>
        </div>
      </>
    )
  }
  if (!result || !data) return head

  const s = result.summary
  const items = result.items
  const of = (k: Item['kind']) => items.filter((i) => i.kind === k)
  const review = [...of('ambiguous'), ...of('amount_diff'), ...of('special'), ...of('broken')]
  const matched = [...of('matched'), ...of('explained_entry'), ...of('explained_tx')]
  const pending = of('pending_next')
  const problems = s.bankOnly + (s.bookOnly ?? 0) + s.needsReview
  const card = ref.payment(st.paymentMethodId)
  const pct = s.entries ? Math.round((s.matched / s.entries) * 100) : 0

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
          </span>
          <span className={'state' + (done ? '' : ' attn')}>
            {l.date}
            {!done && STATE_TEXT[it.kind] ? ` · ${STATE_TEXT[it.kind]}` : ''}
            {it.kind === 'amount_diff' && ` 差 ${fmt(Math.abs(it.diff))}`}
            {it.kind === 'explained_entry' || it.kind === 'explained_tx' ? ' · 已說明' : ''}
          </span>
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
        <div className="card">{list.map((it, i) => row(it, i))}</div>
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
        <div className="recon-big">
          <span className="num">{s.matched}</span>
          <span className="of">/ {s.entries}</span>
          <small>{st.parseStatus === 'confirmed' ? '筆帳單明細已核對' : '筆已配對（帳單解析待確認）'}</small>
        </div>
        <div className={'progress' + (st.parseStatus === 'confirmed' ? '' : ' pending')} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="核對進度">
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="recon-sum">
          <div>
            <span>
              帳單有、記帳沒有<small>以帳單明細計</small>
            </span>
            <b className={s.bankOnly ? '' : 'zero'}>{s.bankOnly}</b>
          </div>
          <div>
            <span>
              記帳有、帳單沒有<small>{result.periodKnown ? `以本期記帳計（${md(st.periodStart)}–${md(st.periodEnd)}）` : '帳單週期未確認，暫不判斷'}</small>
            </span>
            <b className={s.bookOnly ? '' : 'zero'}>{s.bookOnly ?? '—'}</b>
          </div>
          <div>
            <span>需要確認</span>
            <b className={s.needsReview ? '' : 'zero'}>{s.needsReview}</b>
          </div>
        </div>
      </section>

      {st.parseStatus === 'needs_review' && (
        <div className="notice">
          <Icon name="alert" />
          <div>
            <b>帳單解析待確認</b>：明細是用通用格式讀取的，請對照 PDF 確認沒有漏讀或讀錯；確認前不會顯示為全部完成。
            <div className="actions">
              <button
                type="button"
                className="chip-btn"
                onClick={() => updateStatement(st.id, { parseStatus: 'confirmed' }).then(() => toast('已確認帳單解析'), () => toast('沒有存到', { kind: 'error' }))}
              >
                我已對照，解析無誤
              </button>
            </div>
          </div>
        </div>
      )}

      {!result.periodKnown && (
        <div className="notice">
          <Icon name="cal" />
          <div>
            <b>設定帳單週期</b>後才能找出「記帳有、帳單沒有」的消費。
            <div className="meta-grid" style={{ marginTop: 8 }}>
              <label>
                開始
                <input type="date" value={period.start} onChange={(e) => setPeriod((p) => ({ ...p, start: e.target.value }))} />
              </label>
              <label>
                結帳日
                <input type="date" value={period.end} onChange={(e) => setPeriod((p) => ({ ...p, end: e.target.value }))} />
              </label>
            </div>
            <div className="actions">
              <button
                type="button"
                className="chip-btn"
                disabled={!period.start || !period.end}
                onClick={() =>
                  updateStatement(st.id, { periodStart: period.start, periodEnd: period.end }).then(
                    () => toast('已設定帳單週期'),
                    (e) => toast(e instanceof MoneyError ? e.message : '沒有存到', { kind: 'error' }),
                  )
                }
              >
                儲存週期
              </button>
            </div>
          </div>
        </div>
      )}

      {problems === 0 && st.parseStatus === 'confirmed' && result.periodKnown && (
        <div className="done-all">
          <Icon name="check" />
          這期帳單已全部核對完成
        </div>
      )}

      {problems > 0 && (
        <div className="grp-title" style={{ marginTop: 26 }}>
          <b style={{ fontSize: '1.0625rem' }}>需要你確認</b>
          <span>共 {problems} 筆</span>
        </div>
      )}
      {group('帳單有、記帳沒有', '銀行有這筆，但找不到記帳', of('bank_only'))}
      {group('記帳有、帳單沒有', '本期記帳在帳單上找不到', of('book_only'))}
      {group('需要人工確認', '候選不只一筆、金額不同或特殊交易', review)}

      {pending.length > 0 && (
        <>
          <button type="button" className="summary-toggle" aria-expanded={showPending} onClick={() => setShowPending(!showPending)}>
            <span>等待下期帳單 {pending.length} 筆（不算問題）</span>
            <Icon name="chev" />
          </button>
          {showPending && <div className="card">{pending.map((it, i) => row(it, i, true))}</div>}
        </>
      )}

      {matched.length > 0 && (
        <>
          <button type="button" className="summary-toggle" aria-expanded={showMatched || matched.length <= 5} onClick={() => setShowMatched(!showMatched)}>
            <span>已核對 {matched.length} 筆</span>
            <Icon name="chev" />
          </button>
          {(showMatched || matched.length <= 5) && <div className="card">{matched.map((it, i) => row(it, i, true))}</div>}
        </>
      )}

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
        <div className="srow">
          <span className="s-main">繳款截止日</span>
          <span className="s-val">{st.dueDate ?? '—'}</span>
        </div>
        {result.payments.map((p) => (
          <div className="srow" key={p.id}>
            <span className="s-main">
              {p.merchant}
              <span className="s-sub">繳款 · {md(p.txDate ?? p.postDate)}（不參與核對）</span>
            </span>
            <span className="s-val num">{fmt(p.amount)}</span>
          </div>
        ))}
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
                <button type="button" className="rrow compact" key={x.id} onClick={() => setChosen(x.id)}>
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
