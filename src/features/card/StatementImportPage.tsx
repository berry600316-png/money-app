import { useRef, useState } from 'react'
import { findSameStatement, saveStatement } from '../../card/cardRepo'
import { parseStatement, type DraftEntry, type ParsedStatement } from '../../card/statementParser'
import { db } from '../../db/db'
import { MoneyError } from '../../db/repo'
import type { CardStatement, EntryKind } from '../../db/types'
import { fromYmd, toYmd } from '../../lib/dates'
import { fmt } from '../../lib/money'
import { currentMonthKey } from '../../lib/months'
import { ActionSheet } from '../../ui/ActionSheet'
import { BottomSheet } from '../../ui/BottomSheet'
import { useCloseGuard, useDirtyCheck } from '../../ui/discard'
import { Icon } from '../../ui/Icon'
import { Overlay } from '../../ui/overlay'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'

export const KIND_LABELS: Record<EntryKind, string> = {
  purchase: '消費',
  refund: '退款',
  fee: '手續費',
  installment: '分期',
  payment: '繳款',
  adjustment: '調整',
  other: '其他',
}

type Stage = { kind: 'pick' } | { kind: 'password'; data: ArrayBuffer; name: string; hash: string; wrong: boolean } | { kind: 'review' }

/** Previous closing date + 1 day, assuming a monthly cycle; shown as a suggestion only. */
function suggestStart(end: string): string {
  const d = fromYmd(end)
  d.setMonth(d.getMonth() - 1)
  d.setDate(d.getDate() + 1)
  return toYmd(d)
}

/** Phase 2: PDF → local parse → review/correct → save (spec §6). */
export function StatementImportPage({ onBack, backLabel, onSaved }: { onBack: () => void; backLabel: string; onSaved: (statementId: string) => void }) {
  const ref = useRefData()
  const toast = useToast()
  const input = useRef<HTMLInputElement | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'pick' })
  const [busy, setBusy] = useState(false)
  const [pw, setPw] = useState('')
  const [file, setFile] = useState<{ name: string; hash: string } | null>(null)
  const [parsed, setParsed] = useState<ParsedStatement | null>(null)
  const [entries, setEntries] = useState<DraftEntry[]>([])
  const [meta, setMeta] = useState({ paymentMethodId: '', bank: '', statementMonth: currentMonthKey(), periodStart: '', periodEnd: '', dueDate: '' })
  const [confirmed, setConfirmed] = useState(false)
  const [editing, setEditing] = useState<{ index: number | null; entry: DraftEntry } | null>(null)
  const [replace, setReplace] = useState<CardStatement | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const cards = ref.payments.filter((p) => p.type === 'credit_card' && p.isActive)

  const read = async (data: ArrayBuffer, name: string, hash: string, password?: string) => {
    setBusy(true)
    try {
      const { extractPdfText, PdfPasswordError } = await import('../../card/pdf/extract')
      try {
        const text = await extractPdfText(data, password)
        if (text.items === 0) {
          toast('這份 PDF 沒有可擷取的文字（可能是掃描圖片），目前不支援', { kind: 'error' })
          setStage({ kind: 'pick' })
          return
        }
        const p = parseStatement(text.lines)
        const card =
          cards.find((c) => p.cardLast4 && c.cardLast4 === p.cardLast4) ?? cards.find((c) => p.bank && c.bank && c.bank.includes(p.bank)) ?? cards[0]
        const end = p.periodEnd ?? p.closingDate ?? ''
        setParsed(p)
        setEntries(p.entries)
        setFile({ name, hash })
        setMeta({
          paymentMethodId: card?.id ?? '',
          bank: p.bank ?? card?.bank ?? '',
          statementMonth: (p.closingDate ?? toYmd(new Date())).slice(0, 7),
          periodStart: p.periodStart ?? (end ? suggestStart(end) : ''),
          periodEnd: end,
          dueDate: p.dueDate ?? '',
        })
        // D-87: never pre-confirmed; matching totals is a hint, the user still compares with the PDF.
        setConfirmed(false)
        setStage({ kind: 'review' })
      } catch (e) {
        if (e instanceof PdfPasswordError) setStage({ kind: 'password', data, name, hash, wrong: e.wrong })
        else toast(e instanceof Error ? e.message : '無法讀取這份 PDF', { kind: 'error' })
      }
    } catch {
      toast('PDF 元件載入失敗，請連上網路開啟一次 App 後再試', { kind: 'error' })
    } finally {
      setPw('') // the password is used once and never kept (spec §6.2)
      setBusy(false)
    }
  }

  const onFile = async (f: File | undefined) => {
    if (input.current) input.current.value = ''
    if (!f) return
    setBusy(true)
    try {
      const data = await f.arrayBuffer()
      const { sha256 } = await import('../../card/pdf/extract')
      const hash = await sha256(data)
      if (await db.cardStatements.where('fileHash').equals(hash).first()) {
        toast('這份帳單已經匯入過', { kind: 'error' })
        setBusy(false)
        return
      }
      await read(data, f.name, hash)
    } catch {
      toast('無法讀取這個檔案', { kind: 'error' })
      setBusy(false)
    }
  }

  const save = async (replaceId?: string) => {
    if (!file || busy) return
    if (!meta.paymentMethodId) {
      toast('請選擇信用卡', { kind: 'error' })
      return
    }
    setBusy(true)
    try {
      if (!replaceId) {
        const same = await findSameStatement(meta.paymentMethodId, meta.statementMonth)
        if (same) {
          setReplace(same)
          setBusy(false)
          return
        }
      }
      const st = await saveStatement(
        {
          paymentMethodId: meta.paymentMethodId,
          bank: meta.bank,
          statementMonth: meta.statementMonth,
          periodStart: meta.periodStart || null,
          periodEnd: meta.periodEnd || null,
          dueDate: meta.dueDate || null,
          fileHash: file.hash,
          fileName: file.name,
          adapter: parsed?.adapter ?? 'generic',
          confirmed,
          entries,
        },
        { replaceId },
      )
      toast(`已匯入 ${entries.length} 筆帳單明細`)
      onSaved(st.id)
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '沒有存到，請再試一次', { kind: 'error' })
      setBusy(false)
    }
  }

  const setM = (k: keyof typeof meta) => (e: { target: { value: string } }) => setMeta((m) => ({ ...m, [k]: e.target.value }))
  const total = entries.filter((e) => e.kind !== 'payment').reduce((s, e) => s + e.amount, 0)

  return (
    <>
      <div className="page-head">
        <button type="button" className="back" onClick={onBack}>
          <Icon name="left" />
          {backLabel}
        </button>
        <h1>匯入信用卡帳單</h1>
        <span />
      </div>
      <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => void onFile(e.target.files?.[0])} />

      {stage.kind === 'pick' && (
        <>
          <p className="lead">
            選擇銀行寄來的 PDF 電子帳單。PDF 只在這支 iPhone 上讀取，<b>不會上傳，也不會保存檔案本身</b>。
          </p>
          <button type="button" className="pick-btn" onClick={() => input.current?.click()} disabled={busy}>
            <Icon name="doc" />
            {busy ? '讀取中…' : '選擇 PDF 帳單'}
            <small>有密碼的 PDF 會請你輸入密碼</small>
          </button>
          {cards.length === 0 && <p className="err-line">還沒有信用卡：請先到「設定 › 付款方式」新增，類型選「信用卡」。</p>}
        </>
      )}

      {stage.kind === 'password' && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (pw) void read(stage.data, stage.name, stage.hash, pw)
          }}
        >
          <p className="lead">
            「{stage.name}」有密碼保護。密碼只用來打開這一次，<b>不會被記住</b>。
          </p>
          <div className="pw-row">
            <label htmlFor="pdf-pw" className="sr">
              PDF 密碼
            </label>
            <input id="pdf-pw" className="field" type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="PDF 密碼" />
            <button type="submit" disabled={busy || !pw}>
              {busy ? '…' : '開啟'}
            </button>
          </div>
          {stage.wrong && <p className="err-line">密碼不正確，請再試一次。</p>}
          <button type="button" className="btn-quiet" onClick={() => setStage({ kind: 'pick' })}>
            取消
          </button>
        </form>
      )}

      {stage.kind === 'review' && parsed && (
        <>
          <p className="lead">請對照 PDF 確認以下內容；可以修改、刪除或補登明細。</p>
          <div className="meta-grid">
            <label className="full">
              信用卡
              <select value={meta.paymentMethodId} onChange={setM('paymentMethodId')}>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.cardLast4 ? ` ${c.cardLast4}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              帳單月份
              <input type="month" value={meta.statementMonth} onChange={setM('statementMonth')} />
            </label>
            <label>
              繳款截止日
              <input type="date" value={meta.dueDate} onChange={setM('dueDate')} />
            </label>
            <label>
              週期開始{!parsed.periodStart && meta.periodStart ? '（推算）' : ''}
              <input type="date" value={meta.periodStart} onChange={setM('periodStart')} />
            </label>
            <label>
              結帳日（週期結束）
              <input type="date" value={meta.periodEnd} onChange={setM('periodEnd')} />
            </label>
          </div>

          {parsed.warnings.length > 0 && (
            <ul className="warn-list">
              {parsed.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          {parsed.unreadLines.length > 0 && (
            <>
              <button type="button" className="summary-toggle" aria-expanded={showRaw} onClick={() => setShowRaw(!showRaw)}>
                <span>看無法辨識的 {parsed.unreadLines.length} 行</span>
                <Icon name="chev" />
              </button>
              {showRaw && <div className="raw-lines">{parsed.unreadLines.join('\n')}</div>}
            </>
          )}

          <div className="grp-title">
            <b>帳單明細 {entries.length} 筆</b>
            <span>
              不含繳款合計 <span className="num">{fmt(total)}</span>
            </span>
          </div>
          <div className="card">
            {entries.map((e, i) => (
              <button type="button" className="rrow" key={i} onClick={() => setEditing({ index: i, entry: e })}>
                <span className="row-main">
                  <span className="row-title">
                    {e.merchant}
                    {e.kind !== 'purchase' && <span className="kind-tag">{KIND_LABELS[e.kind]}</span>}
                  </span>
                  <span className="row-sub">
                    消費 {e.txDate ?? '—'}
                    {e.postDate ? ` · 入帳 ${e.postDate}` : ''}
                    {e.foreign ? ` · ${e.foreign}` : ''}
                  </span>
                </span>
                <span className="row-amt num">{fmt(e.amount)}</span>
              </button>
            ))}
            <button
              type="button"
              className="srow add"
              onClick={() => setEditing({ index: null, entry: { txDate: meta.periodEnd || null, postDate: null, merchant: '', amount: 0, currency: 'TWD', foreign: null, reference: null, kind: 'purchase', raw: '（手動補登）' } })}
            >
              <span className="s-main">補登一筆明細</span>
              <Icon name="plus" className="chev" />
            </button>
          </div>

          <label className="check-row" htmlFor="st-ok">
            <input id="st-ok" type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              我已對照 PDF，明細正確完整
              {parsed.totalsMatch === true && <span className="s-sub">明細加總與帳單「本期新增」相符，仍請對照逐筆內容</span>}
            </span>
          </label>
          <p className="set-foot">沒勾選也可以先匯入，帳單會標示「解析待確認」，核對結果不會顯示為全部完成。</p>

          <div className="foot-bar">
            <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy || !entries.length || !meta.paymentMethodId}>
              {busy ? '儲存中…' : '匯入並開始核對'}
            </button>
            <button type="button" className="btn-quiet" onClick={() => setStage({ kind: 'pick' })} disabled={busy}>
              換一份 PDF
            </button>
          </div>
        </>
      )}

      <Overlay>
        <EntryEditor
          target={editing}
          onClose={() => setEditing(null)}
          onSave={(entry) => {
            setEntries((es) => (editing?.index === null || editing?.index === undefined ? [...es, entry] : es.map((x, i) => (i === editing.index ? entry : x))))
            setEditing(null)
          }}
          onDelete={() => {
            setEntries((es) => es.filter((_, i) => i !== editing?.index))
            setEditing(null)
          }}
        />
        <ActionSheet
          open={replace !== null}
          onClose={() => setReplace(null)}
          title="這張卡這個月已經有帳單"
          message="要用這份 PDF 取代舊帳單嗎？舊帳單的明細與核對紀錄會一起移除，記帳資料不受影響。"
          actions={[
            {
              label: '取代舊帳單',
              danger: true,
              onClick: () => {
                const id = replace!.id
                setReplace(null)
                void save(id)
              },
            },
          ]}
        />
      </Overlay>
    </>
  )
}

/** Edit / add / delete one parsed entry before saving. */
function EntryEditor({
  target,
  onClose,
  onSave,
  onDelete,
}: {
  target: { index: number | null; entry: DraftEntry } | null
  onClose: () => void
  onSave: (e: DraftEntry) => void
  onDelete: () => void
}) {
  const [e, setE] = useState<DraftEntry | null>(null)
  const [amount, setAmount] = useState('')
  const [err, setErr] = useState('')
  const [lastTarget, setLastTarget] = useState<typeof target>(null)
  if (target !== lastTarget) {
    setLastTarget(target)
    if (target) {
      setE(target.entry)
      setAmount(target.entry.amount ? String(target.entry.amount) : '')
      setErr('')
    }
  }
  const set = (p: Partial<DraftEntry>) => setE((x) => (x ? { ...x, ...p } : x))
  // D-101
  useDirtyCheck(
    'statementEntry',
    target !== null,
    () => !!target && !!e && (JSON.stringify(e) !== JSON.stringify(target.entry) || amount !== (target.entry.amount ? String(target.entry.amount) : '')),
  )
  const guard = useCloseGuard('statementEntry')
  const requestClose = () => guard(onClose)
  return (
    <BottomSheet
      open={target !== null}
      onClose={requestClose}
      labelledBy="entry-ed-title"
      head={
        <div className="sheet-bar">
          <button type="button" className="txt-btn" onClick={requestClose}>
            取消
          </button>
          <h2 id="entry-ed-title">{target?.index === null ? '補登明細' : '修改明細'}</h2>
          <span />
        </div>
      }
    >
      {e && (
        <form
          className="form"
          onSubmit={(ev) => {
            ev.preventDefault()
            const n = Number(amount.replace(/,/g, ''))
            if (!Number.isSafeInteger(n) || n === 0) return setErr('金額需為不等於 0 的整數（退款、繳款用負數）')
            if (!e.txDate && !e.postDate) return setErr('至少要有消費日或入帳日')
            onSave({ ...e, amount: n, merchant: e.merchant.trim() || '（未辨識）' })
          }}
        >
          <div className="meta-grid" style={{ marginTop: 0 }}>
            <label>
              消費日
              <input type="date" value={e.txDate ?? ''} onChange={(x) => set({ txDate: x.target.value || null })} />
            </label>
            <label>
              入帳日
              <input type="date" value={e.postDate ?? ''} onChange={(x) => set({ postDate: x.target.value || null })} />
            </label>
            <label className="full">
              交易說明
              <input value={e.merchant} maxLength={60} onChange={(x) => set({ merchant: x.target.value })} />
            </label>
            <label>
              金額（台幣）
              <input inputMode="numeric" value={amount} onChange={(x) => setAmount(x.target.value.replace(/[^\d-]/g, ''))} />
            </label>
            <label>
              類型
              <select value={e.kind} onChange={(x) => set({ kind: x.target.value as EntryKind })}>
                {Object.entries(KIND_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="form-err" role="alert">
            {err}
          </p>
          <button type="submit" className="btn-primary">
            完成
          </button>
          {target?.index !== null && (
            <button type="button" className="btn-danger-quiet" onClick={onDelete}>
              刪除這筆明細
            </button>
          )}
        </form>
      )}
    </BottomSheet>
  )
}
