import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { commitNotificationImport, getDefaultCards, getNoticeMethods, getNoticeTypes } from '../../card/cardRepo'
import { planImport, type PaySource, type PlanRow } from '../../card/importPlan'
import { MAX_CAPTURES, readCaptureFiles, type NotificationCapture } from '../../card/notificationFile'
import { db } from '../../db/db'
import { MoneyError } from '../../db/repo'
import type { PaymentMethod } from '../../db/types'
import { isCard } from '../../lib/accounts'
import { dayLabel, timeLabel } from '../../lib/dates'
import { fmt } from '../../lib/money'
import { BottomSheet } from '../../ui/BottomSheet'
import { Icon } from '../../ui/Icon'
import { Overlay } from '../../ui/overlay'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'

const sameSource = (a: PaySource | null, b: PaySource | null) => !!a && !!b && (a.cardId ?? '') === (b.cardId ?? '') && (a.sourceAccountId ?? '') === (b.sourceAccountId ?? '')

/**
 * Pick notification JSON files → preview → one tap to import (spec §5.4, D-128..D-131).
 * Rows: 可匯入 (ticked), 需要確認 (not ticked: a possible duplicate, or no payment source yet) and 不匯入
 * (with the reason). A LINE Pay row shows where the money came from — the place its notice type says
 * (D-136) — and the user can switch it to another of their cards or debit cards for that row only (Q94).
 * No type matched, or types for different places matched: the user picks. The notice types are set up from
 * here (Q117).
 */
export function CardImportPage({ onBack, backLabel, onNoticeTypes }: { onBack: () => void; backLabel: string; onNoticeTypes: () => void }) {
  const ref = useRefData()
  const toast = useToast()
  const input = useRef<HTMLInputElement | null>(null)
  const [rows, setRows] = useState<PlanRow[] | null>(null)
  /** The notices read from the chosen files, planned again when the notice types change. */
  const [captures, setCaptures] = useState<NotificationCapture[] | null>(null)
  const noticeTypes = useLiveQuery(() => getNoticeTypes(), [])
  const [files, setFiles] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  /** Card per source app for card notices without card digits (D-84). */
  const [chosenCards, setChosenCards] = useState<Record<string, string>>({})
  const [showSkipped, setShowSkipped] = useState(false)
  /** The row whose payment source is being chosen. */
  const [picking, setPicking] = useState<PlanRow | null>(null)
  const cards = ref.payments.filter((p) => p.type === 'credit_card' && p.isActive)
  const expenseCats = ref.categories.filter((c) => c.type === 'expense' && c.isActive)
  const byId = (id?: string) => ref.payments.find((p) => p.id === id)

  const plan = async (captures: NotificationCapture[]) => {
    const since = new Date(Date.now() - 120 * 864e5).toISOString()
    const [known, recent, defaultCards, noticeMethods, types] = await Promise.all([
      db.importedNotifications.toArray(),
      db.transactions.where('occurredAt').above(since).toArray(),
      getDefaultCards(),
      getNoticeMethods(),
      getNoticeTypes(),
    ])
    const history = [...recent]
      .filter((t) => t.type === 'expense' && t.merchant)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
      .map((t) => ({ merchant: t.merchant, categoryId: t.categoryId }))
    setRows(
      planImport({
        captures,
        knownCaptureIds: new Map(known.map((k) => [k.captureId, k.fingerprint])),
        transactions: recent,
        paymentMethods: await db.paymentMethods.toArray(),
        categories: ref.categories,
        history,
        defaultCards,
        noticeMethods,
        noticeTypes: types,
      }),
    )
    setChosenCards(defaultCards)
  }

  // Back from the notice types (or after a card was disabled or unbound): the preview follows them (cards
  // picked by hand start over).
  const typesKey = JSON.stringify([noticeTypes ?? null, ref.payments.map((p) => [p.id, p.isActive, p.cards ?? []])])
  const planned = useRef(typesKey)
  useEffect(() => {
    if (planned.current === typesKey) return
    planned.current = typesKey
    if (captures && rows && !busy) void plan(captures)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typesKey])

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return
    setBusy(true)
    try {
      const { captures: read, errors: errs } = await readCaptureFiles(Array.from(list))
      await plan(read)
      setCaptures(read)
      setFiles(list.length)
      setErrors(errs)
    } catch {
      toast('無法讀取這些檔案', { kind: 'error' })
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const ready = rows?.filter((r) => r.status === 'new') ?? []
  const check = rows?.filter((r) => r.status === 'suspect') ?? []
  const skipped = rows?.filter((r) => r.status === 'duplicate' || r.status === 'not_spending' || r.status === 'unparsed') ?? []
  const chosen = [...ready, ...check].filter((r) => r.include)
  const needsCardApps = [...new Set(chosen.filter((r) => !r.channel && !r.paymentMethodId).map((r) => r.capture.sourceApp))]
  const cardOf = (app: string) => (chosenCards[app] && cards.some((c) => c.id === chosenCards[app]) ? chosenCards[app] : (cards[0]?.id ?? ''))
  const missingCard = needsCardApps.some((a) => !cardOf(a))
  const missingSource = chosen.some((r) => r.channel && !r.source)

  const patch = (r: PlanRow, p: Partial<PlanRow>) => setRows((rs) => rs?.map((x) => (x === r ? { ...x, ...p } : x)) ?? null)

  /** Q128: the notice types that chose the card, shown next to it. */
  const autoNote = (r: PlanRow) => r.typeNames.join('、')
  /** 「LINE Pay · 台新金融卡」: the 行動支付 of the notice type and its card. */
  const autoLabel = (r: PlanRow) => `${byId(r.autoMethodId ?? undefined)?.name ?? r.channel ?? ''} · ${labelOf(r.autoSource!)}`

  /** Q102 / Q104: only what the user set up: the default, their credit cards (預扣) and debit cards (直接扣). */
  const sourceOptions = (r: PlanRow): { source: PaySource; name: string; note: string }[] => {
    const out: { source: PaySource; name: string; note: string }[] = []
    const add = (source: PaySource, name: string, note: string) => {
      if (!out.some((o) => sameSource(o.source, source) && (o.source.via ?? '') === (source.via ?? ''))) out.push({ source, name, note })
    }
    const def = r.autoSource
    if (def) add(def, autoLabel(r), `${isCard(byId(def.cardId)) ? '預扣' : '直接扣'} · 通知類型：${autoNote(r)}`)
    for (const c of cards) add({ cardId: c.id }, c.name, '預扣，繳卡費時才扣')
    // D-132: a debit card is recorded as the card used; the money leaves its bank at once.
    for (const m of ref.payments.filter((p) => p.type === 'debit_card' && p.isActive && byId(p.payFromId)?.type === 'bank')) {
      add({ cardId: m.id }, m.name, `直接從 ${byId(m.payFromId)!.name} 扣`)
    }
    return out
  }

  const labelOf = (s: PaySource): string => {
    const target: PaymentMethod | undefined = byId(s.via) ?? byId(s.cardId ?? s.sourceAccountId)
    return target?.name ?? '已刪除的帳戶'
  }

  const pickSource = (r: PlanRow, source: PaySource) => {
    // Choosing the source settles a row that only lacked one; a possible duplicate stays for the user to tick.
    // The notice type's card keeps its 行動支付; another card is recorded under the notice's own (LINE Pay).
    const auto = sameSource(source, r.autoSource) && !source.via
    patch(r, {
      source,
      sourceIsDefault: auto,
      paymentMethodId: auto ? r.autoMethodId : r.channelMethodId,
      needsSource: false,
      sourceNote: '',
      ...(r.status === 'suspect' && !r.duplicate && !r.reason ? { status: 'new' as const, include: true } : {}),
    })
  }

  const commit = async () => {
    if (!rows || busy) return
    if (missingCard) {
      toast('請先選擇信用卡', { kind: 'error' })
      return
    }
    if (missingSource) {
      toast('還有勾選的消費沒有選付款來源', { kind: 'error' })
      return
    }
    setBusy(true)
    try {
      const final = rows.map((r) => (r.include && !r.channel && !r.paymentMethodId ? { ...r, paymentMethodId: cardOf(r.capture.sourceApp) } : r))
      const rememberCards = Object.fromEntries(needsCardApps.map((a) => [a, cardOf(a)]))
      const s = await commitNotificationImport(final, { files, rememberCards })
      toast(s.imported ? `已匯入 ${s.imported} 筆消費` : '沒有新的消費')
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
      <button
        type="button"
        className="tick"
        aria-pressed={r.include}
        aria-label={r.include ? '不要匯入這筆' : '匯入這筆'}
        onClick={() => {
          if (!r.include && r.channel && !r.source) {
            toast('請先選這筆的付款來源', { kind: 'error' })
            return
          }
          patch(r, { include: !r.include })
        }}
      >
        {r.include && <Icon name="check" />}
      </button>
      <span className="row-main">
        <span className="row-title">{r.merchant || '（未辨識商店）'}</span>
        <span className="row-sub">
          {when(r.occurredAt)}
          {r.timeSource === 'notification' ? '（通知時間）' : ''}
          {r.channel ? ` · ${r.channel}` : r.paymentMethodId ? ` · ${ref.payment(r.paymentMethodId).name}` : ''}
        </span>
        {r.channel && (
          <button type="button" className={'src-chip' + (r.source ? '' : ' need')} onClick={() => setPicking(r)}>
            <Icon name="card" />
            {r.source && r.sourceIsDefault && r.autoSource ? (
              <span>
                {autoLabel(r)}
                <small>通知類型：{autoNote(r)}</small>
              </span>
            ) : (
              <span>{r.source ? labelOf(r.source) : '選擇付款來源'}</span>
            )}
            <Icon name="chev" />
          </button>
        )}
        {r.sourceNote && <span className="why">{r.sourceNote}</span>}
        {r.reason && <span className="why">{r.reason}</span>}
      </span>
      <span className="irow-end">
        <span className="row-amt num">{fmt(r.amount)}</span>
        <select className="cat-pill" aria-label="分類" value={r.categoryId} onChange={(e) => patch(r, { categoryId: e.target.value })}>
          {expenseCats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </span>
    </div>
  )

  const options = picking ? sourceOptions(picking) : []

  /** Q117 / Q124 B: the notice types are set up from the import page. */
  const typesRow = (
    <div className="set-card types-link">
      <button type="button" className="srow" onClick={onNoticeTypes}>
        <span className="s-main">通知類型</span>
        <span className="s-val">{noticeTypes ? (noticeTypes.length ? `${noticeTypes.length} 個` : '還沒設定') : ''}</span>
        <Icon name="chev" className="chev" />
      </button>
    </div>
  )
  const current = picking ? (rows?.find((x) => x.capture === picking.capture) ?? picking) : null

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
            選擇捷徑存下的通知檔（JSON，通常在「檔案 › 我的 iPhone › MoneyApp › Inbox」），可以一次選很多個。
            目前會自動辨識 <b>LINE Pay 付款完成</b>的通知；其他通知會列出原因，不會匯入。
            <b>重複選到已匯入的檔案也不會重複記帳</b>。
          </p>
          <button type="button" className="pick-btn" onClick={() => input.current?.click()} disabled={busy}>
            <Icon name="inbox" />
            {busy ? '讀取中…' : '選擇通知檔案'}
            <small>只在這支 iPhone 上解析，不會上傳；一次最多 {MAX_CAPTURES} 則</small>
          </button>
          {typesRow}
          <p className="set-foot">依「通知類型」的關鍵字判斷每則付款通知要記到哪張卡；沒有符合的，匯入前會請你選。</p>
        </>
      )}

      {rows && (
        <>
          <div className="counts">
            <span>
              <b>{ready.length}</b>筆可匯入
            </span>
            {check.length > 0 && (
              <span>
                <b>{check.length}</b>筆需要確認
              </span>
            )}
            {skipped.length > 0 && (
              <span>
                <b>{skipped.length}</b>則不匯入
              </span>
            )}
          </div>

          {needsCardApps.map((app, i) => (
            <div className="select-row" key={app}>
              <label htmlFor={`imp-card-${i}`}>{needsCardApps.length > 1 ? `「${app}」的刷卡是哪張卡？` : '這些刷卡是哪張卡？'}</label>
              <select id={`imp-card-${i}`} value={cardOf(app)} onChange={(e) => setChosenCards((m) => ({ ...m, [app]: e.target.value }))}>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.cardLast4 ? ` ${c.cardLast4}` : ''}
                  </option>
                ))}
              </select>
            </div>
          ))}

          {ready.length > 0 && (
            <>
              <div className="grp-title">
                <b>可匯入</b>
                <span>確認付款來源後一次匯入</span>
              </div>
              <div className="card">{ready.map(row)}</div>
            </>
          )}
          {check.length > 0 && (
            <>
              <div className="grp-title">
                <b>需要確認</b>
                <span>預設不匯入，確認後再勾選</span>
              </div>
              <div className="card">{check.map(row)}</div>
            </>
          )}

          {skipped.length > 0 && (
            <>
              <button type="button" className="summary-toggle" aria-expanded={showSkipped} onClick={() => setShowSkipped(!showSkipped)}>
                <span>不匯入的 {skipped.length} 則（已處理過、不是 LINE Pay 付款、無法辨識）</span>
                <Icon name="chev" />
              </button>
              {showSkipped && (
                <div className="card">
                  {skipped.map((r, i) => (
                    <div className="irow muted-row" key={r.capture.captureId + 's' + i}>
                      <span className="row-main">
                        <span className="row-title">{r.reason}</span>
                        <span className="row-sub">{[r.capture.sourceApp, r.capture.title, r.capture.body].filter(Boolean).join(' · ')}</span>
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

          {typesRow}
          <p className="set-foot">卡片依「通知類型」自動帶入，每筆都可以點開改。匯入後可以到「檔案」App 刪除這些 JSON；之後再選到也不會重複記帳。</p>
          <div className="foot-bar">
            <button type="button" className="btn-primary" onClick={commit} disabled={busy || !chosen.length || missingCard || missingSource}>
              {busy ? '匯入中…' : chosen.length ? `匯入 ${chosen.length} 筆` : '沒有要匯入的消費'}
            </button>
            <button type="button" className="btn-quiet" onClick={() => setRows(null)} disabled={busy}>
              重新選擇檔案
            </button>
          </div>
        </>
      )}

      <Overlay>
        <BottomSheet
          open={picking !== null}
          onClose={() => setPicking(null)}
          labelledBy="src-picker-title"
          className="picker-sheet"
          head={
            <div className="sheet-bar">
              <button type="button" className="txt-btn" onClick={() => setPicking(null)}>
                關閉
              </button>
              <h2 id="src-picker-title">這筆從哪裡付</h2>
              <span />
            </div>
          }
        >
          <div className="pk-body">
            {options.length === 0 ? (
              <p className="range-help" style={{ margin: '8px 8px 0' }}>
                還沒有信用卡或金融卡。請先到「設定 › 帳戶與付款方式」新增一張卡，再綁到 LINE Pay。
              </p>
            ) : (
              <div className="set-card">
                {options.map((o) => {
                  const on = !!current?.source && sameSource(current.source, o.source) && (current.source.via ?? '') === (o.source.via ?? '')
                  return (
                    <button
                      type="button"
                      key={(o.source.cardId ?? o.source.sourceAccountId ?? '') + (o.source.via ?? '') + o.note}
                      className="pk-row"
                      aria-pressed={on}
                      onClick={() => {
                        if (current) pickSource(current, o.source)
                        setPicking(null)
                      }}
                    >
                      <span className="pk-m">
                        <b>{o.name}</b>
                        {isCard(byId(o.source.cardId)) && byId(o.source.cardId)?.cardLast4 && <small>···{byId(o.source.cardId)!.cardLast4}</small>}
                      </span>
                      <span className="pk-r small">{o.note}</span>
                      {on && <Icon name="check" className="pk-ck" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </BottomSheet>
      </Overlay>
    </>
  )
}
