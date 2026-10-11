import { useRef, useState } from 'react'
import { commitNotificationImport, DEFAULT_CARD_SETTING } from '../../card/cardRepo'
import { planImport, type PlanRow } from '../../card/importPlan'
import { readCaptureFile, type NotificationCapture } from '../../card/notificationFile'
import { db } from '../../db/db'
import { MoneyError } from '../../db/repo'
import { dayLabel, timeLabel } from '../../lib/dates'
import { fmt } from '../../lib/money'
import { Icon } from '../../ui/Icon'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'

/** Phase 1: pick notification JSON files → preview → one tap to import (spec §5.4). */
export function CardImportPage({ onBack, backLabel }: { onBack: () => void; backLabel: string }) {
  const ref = useRefData()
  const toast = useToast()
  const input = useRef<HTMLInputElement | null>(null)
  const [rows, setRows] = useState<PlanRow[] | null>(null)
  const [files, setFiles] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [chosenCard, setChosenCard] = useState('')
  const [showSkipped, setShowSkipped] = useState(false)
  const cards = ref.payments.filter((p) => p.type === 'credit_card' && p.isActive)
  const expenseCats = ref.categories.filter((c) => c.type === 'expense' && c.isActive)

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return
    setBusy(true)
    try {
      const captures: NotificationCapture[] = []
      const errs: string[] = []
      for (const f of Array.from(list)) {
        const r = readCaptureFile(await f.text(), f.name)
        captures.push(...r.captures)
        errs.push(...r.errors)
      }
      const since = new Date(Date.now() - 120 * 864e5).toISOString()
      const [known, recent, defaultCard] = await Promise.all([
        db.importedNotifications.toArray(),
        db.transactions.where('occurredAt').above(since).toArray(),
        db.settings.get(DEFAULT_CARD_SETTING),
      ])
      const history = [...recent]
        .filter((t) => t.type === 'expense' && t.merchant)
        .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
        .map((t) => ({ merchant: t.merchant, categoryId: t.categoryId }))
      const plan = planImport({
        captures,
        knownCaptureIds: new Set(known.map((k) => k.captureId)),
        transactions: recent,
        paymentMethods: ref.payments,
        categories: ref.categories,
        history,
        defaultCardId: (defaultCard?.value as string | undefined) ?? null,
      })
      setRows(plan)
      setFiles(list.length)
      setErrors(errs)
      setChosenCard((defaultCard?.value as string | undefined) ?? cards[0]?.id ?? '')
    } catch {
      toast('無法讀取這些檔案', { kind: 'error' })
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const importable = rows?.filter((r) => r.status === 'new' || r.status === 'suspect') ?? []
  const chosen = importable.filter((r) => r.include)
  const needsCard = chosen.some((r) => !r.paymentMethodId)
  const skipped = rows?.filter((r) => r.status === 'duplicate' || r.status === 'not_spending' || r.status === 'unparsed') ?? []
  const count = (s: PlanRow['status']) => rows?.filter((r) => r.status === s).length ?? 0

  const patch = (r: PlanRow, p: Partial<PlanRow>) => setRows((rs) => rs?.map((x) => (x === r ? { ...x, ...p } : x)) ?? null)

  const commit = async () => {
    if (!rows || busy) return
    if (needsCard && !chosenCard) {
      toast('請先選擇信用卡', { kind: 'error' })
      return
    }
    setBusy(true)
    try {
      const final = rows.map((r) => (r.include && !r.paymentMethodId ? { ...r, paymentMethodId: chosenCard } : r))
      const s = await commitNotificationImport(final, { files, rememberCardId: needsCard ? chosenCard : null })
      toast(s.imported ? `已匯入 ${s.imported} 筆刷卡紀錄` : '沒有新的刷卡紀錄')
      onBack()
    } catch (e) {
      toast(e instanceof MoneyError ? e.message : '匯入失敗，沒有任何資料被寫入', { kind: 'error' })
      setBusy(false)
    }
  }

  const when = (iso: string) => {
    const d = new Date(iso)
    return `${dayLabel(d, { short: true })} ${timeLabel(d)}`
  }

  const row = (r: PlanRow, i: number) => (
    <div className="irow" key={r.capture.captureId + i}>
      <button type="button" className="tick" aria-pressed={r.include} aria-label={r.include ? '不要匯入這筆' : '匯入這筆'} onClick={() => patch(r, { include: !r.include })}>
        {r.include && <Icon name="check" />}
      </button>
      <span className="row-main">
        <span className="row-title">{r.merchant || '（未辨識商店）'}</span>
        <span className="row-sub">
          {when(r.occurredAt)}
          {r.paymentMethodId ? ` · ${ref.payment(r.paymentMethodId).name}` : ''}
        </span>
        {r.reason && <span className="why">{r.reason}</span>}
      </span>
      <select className="cat-pill" aria-label="分類" value={r.categoryId} onChange={(e) => patch(r, { categoryId: e.target.value })}>
        {expenseCats.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <span className="row-amt num">{fmt(r.amount)}</span>
    </div>
  )

  return (
    <>
      <div className="page-head">
        <button type="button" className="back" onClick={onBack}>
          <Icon name="left" />
          {backLabel}
        </button>
        <h1>匯入刷卡紀錄</h1>
        <span />
      </div>

      <input ref={input} type="file" accept="application/json,.json" multiple hidden onChange={(e) => void onFiles(e.target.files)} />

      {!rows && (
        <>
          <p className="lead">
            選擇捷徑存下的刷卡通知（JSON 檔，通常在「檔案 › 我的 iPhone › MoneyApp › Inbox」）。可以一次選很多個，
            <b>重複選到已匯入的檔案也不會重複記帳</b>。
          </p>
          <button type="button" className="pick-btn" onClick={() => input.current?.click()} disabled={busy}>
            <Icon name="inbox" />
            {busy ? '讀取中…' : '選擇刷卡紀錄檔案'}
            <small>只在這支 iPhone 上解析，不會上傳</small>
          </button>
          {cards.length === 0 && <p className="err-line">還沒有信用卡：請先到「設定 › 付款方式」新增，類型選「信用卡」並填末四碼。</p>}
        </>
      )}

      {rows && (
        <>
          <div className="counts">
            <span>
              <b>{chosen.length}</b>筆將匯入
            </span>
            {count('suspect') > 0 && (
              <span>
                <b>{count('suspect')}</b>筆疑似重複
              </span>
            )}
            {skipped.length > 0 && (
              <span>
                <b>{skipped.length}</b>則不匯入
              </span>
            )}
          </div>

          {needsCard && (
            <div className="select-row">
              <label htmlFor="imp-card">這些刷卡是哪張卡？</label>
              <select id="imp-card" value={chosenCard} onChange={(e) => setChosenCard(e.target.value)}>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.cardLast4 ? ` ${c.cardLast4}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {importable.filter((r) => r.status === 'new').length > 0 && (
            <>
              <div className="grp-title">
                <b>新的刷卡紀錄</b>
                <span>點左邊圓圈可取消</span>
              </div>
              <div className="card">{importable.filter((r) => r.status === 'new').map(row)}</div>
            </>
          )}
          {count('suspect') > 0 && (
            <>
              <div className="grp-title">
                <b>可能已經記過</b>
                <span>預設不匯入</span>
              </div>
              <div className="card">{importable.filter((r) => r.status === 'suspect').map(row)}</div>
            </>
          )}

          {skipped.length > 0 && (
            <>
              <button type="button" className="summary-toggle" aria-expanded={showSkipped} onClick={() => setShowSkipped(!showSkipped)}>
                <span>不會匯入的 {skipped.length} 則（已匯入過、非消費、無法辨識）</span>
                <Icon name="chev" />
              </button>
              {showSkipped && (
                <div className="card">
                  {skipped.map((r, i) => (
                    <div className="irow muted-row" key={r.capture.captureId + 's' + i}>
                      <span className="row-main">
                        <span className="row-title">{r.reason}</span>
                        <span className="row-sub">{[r.capture.title, r.capture.body].filter(Boolean).join(' ')}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {errors.length > 0 && (
            <ul className="warn-list">
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}

          <p className="set-foot">匯入後可以到「檔案」App 刪除這些 JSON；之後再選到也不會重複記帳。</p>
          <div className="foot-bar">
            <button type="button" className="btn-primary" onClick={commit} disabled={busy || !chosen.length || (needsCard && !chosenCard)}>
              {busy ? '匯入中…' : chosen.length ? `匯入 ${chosen.length} 筆` : '沒有要匯入的紀錄'}
            </button>
            <button type="button" className="btn-quiet" onClick={() => setRows(null)} disabled={busy}>
              重新選擇檔案
            </button>
          </div>
        </>
      )}
    </>
  )
}
