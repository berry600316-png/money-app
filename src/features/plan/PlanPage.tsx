import { useState } from 'react'
import { useLatestPayslipNet, usePlanSummary } from '../../db/hooks'
import { startPlan } from '../../db/planRepo'
import { MoneyError } from '../../db/repo'
import { addMonthKey, currentMonthKey, monthKeyLabel } from '../../lib/months'
import { fmt } from '../../lib/money'
import { planDayLabel, type PlanItemView } from '../../lib/plan'
import { AnimatedNumber } from '../../ui/AnimatedNumber'
import { Icon } from '../../ui/Icon'
import { useRefData } from '../../ui/refData'
import { useToast } from '../../ui/Toast'
import { PlanItemSheet } from './PlanItemSheet'
import { PlanNumberSheet } from './PlanNumberSheet'
import { PlanItemEditor, type PlanEditorTarget } from './PlanItemEditor'

/** D-113: how far ahead a plan can be made. */
const MAX_AHEAD = 12

export function PlanPage({
  month,
  onMonth,
  backLabel,
  onBack,
  onRecord,
  onEditTx,
  onTemplates,
}: {
  month: string
  onMonth: (m: string) => void
  backLabel: string
  onBack: () => void
  /** Opens the entry sheet pre-filled; saving adds and links in one go (D-109). */
  onRecord: (item: PlanItemView) => void
  onEditTx: (txId: string) => void
  onTemplates: () => void
}) {
  const s = usePlanSummary(month)
  const suggestion = useLatestPayslipNet()
  const toast = useToast()
  const ref = useRefData()
  const [itemId, setItemId] = useState<string | null>(null)
  const [numbers, setNumbers] = useState<'income' | 'saving' | null>(null)
  const [editor, setEditor] = useState<PlanEditorTarget | null>(null)
  const cur = currentMonthKey()
  const [y, m] = month.split('-').map(Number)

  const head = (
    <>
      <div className="page-head">
        <button type="button" className="back" onClick={onBack}>
          <Icon name="left" />
          {backLabel}
        </button>
        <h1>每月規劃</h1>
        <span />
      </div>
      <div className="month-sw plan-sw p-in" role="group" aria-label="月份">
        <button type="button" aria-label="上個月" onClick={() => onMonth(addMonthKey(month, -1))}>
          <Icon name="left" />
        </button>
        <span className="m-label" aria-live="polite">
          {y}年{m}月
        </span>
        <button type="button" aria-label="下個月" disabled={month >= addMonthKey(cur, MAX_AHEAD)} onClick={() => onMonth(addMonthKey(month, 1))}>
          <Icon name="right" />
        </button>
      </div>
    </>
  )

  if (!s) return head
  if (!s.started) {
    return (
      <>
        {head}
        <div className="plan-start p-in d1">
          <h2>{monthKeyLabel(month)}還沒開始規劃</h2>
          <p>
            {s.previousIncome !== null
              ? `會沿用上一次的預估收入 NT$ ${fmt(s.previousIncome)} 與存錢目標 NT$ ${fmt(s.previousSaving)}，`
              : '先設定這個月的預估收入與存錢目標，'}
            並依 {s.activeTemplates} 個使用中的固定項目建立必要支出。建立後都可以單獨修改，不會動到其他月份。
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              startPlan(month).then(
                () => undefined,
                (e) => toast(e instanceof MoneyError ? e.message : '無法開始規劃，請再試一次', { kind: 'error' }),
              )
            }
          >
            開始規劃 {m} 月
          </button>
        </div>
        <p className="note p-in d2">{month > cur ? '提前規劃不會產生任何記帳。' : '規劃只是試算，不會新增任何記帳。'}</p>
      </>
    )
  }

  const p = s.summary
  const over = p.spendable !== null && p.spendable < 0
  const item = itemId ? (p.items.find((v) => v.item.id === itemId) ?? null) : null

  return (
    <>
      {head}
      <section className="pl-hero p-in d1" aria-live="polite">
        {p.spendable === null ? (
          <button type="button" className="pl-setup" onClick={() => setNumbers('income')}>
            <span className="eyebrow">先設定預估收入</span>
            <span className="pl-setup-txt">知道這個月預計收入多少，才能算出還可以花多少。</span>
            <span className="pill-btn">設定預估收入</span>
          </button>
        ) : (
          <>
            <div className="eyebrow pl-eyebrow">
              <span>{over ? '已超出可運用金額' : '達成存錢目標還可花'}</span>
              <span className="estimate-tag">預估</span>
            </div>
            <div className={'pl-amt' + (over ? ' over' : '')}>
              <span className="cur">NT$</span>
              <AnimatedNumber value={p.spendable} className="num" />
            </div>
            {over && <p className="over-note">已超出可運用金額 NT$ {fmt(-p.spendable)}</p>}
            <p className="keep">
              不算存錢目標，預估可留下 <AnimatedNumber value={p.keep ?? 0} abs={false} className="num" />
            </p>
          </>
        )}
      </section>

      <div className="ledger p-in d2">
        <button type="button" className="lrow" onClick={() => setNumbers('income')}>
          <span className="op" />
          <span className="l">
            預估收入
            {p.income !== null && p.actualIncome > p.income ? (
              <small className="warn-inline">實際已收到 {fmt(p.actualIncome)}，比預估多，要更新預估嗎？</small>
            ) : (
              <small>實際已收到 {fmt(p.actualIncome)}</small>
            )}
          </span>
          <span className="r num">{p.income === null ? '未設定' : fmt(p.income)}</span>
        </button>
        <div className="lrow">
          <span className="op">−</span>
          <span className="l">
            必要支出<small>已記帳用實際金額，略過的不算</small>
          </span>
          <AnimatedNumber value={p.necessary} className="r num" />
        </div>
        <div className="lrow">
          <span className="op">−</span>
          <span className="l">
            其他已花支出<small>本月沒有對應必要支出的記帳</small>
          </span>
          <AnimatedNumber value={p.otherSpending} className="r num" />
        </div>
        <button type="button" className="lrow" onClick={() => setNumbers('saving')}>
          <span className="op">−</span>
          <span className="l">
            存錢目標<small>只是預留，不會產生記帳</small>
          </span>
          <span className="r num">{fmt(p.saving)}</span>
        </button>
      </div>

      <div className="prog p-in d3">
        <h2>必要支出</h2>
        <span>
          已記帳 <AnimatedNumber value={p.recorded} className="num" /> / {fmt(p.necessary)}
        </span>
      </div>
      <div className="ptrack p-in d3" aria-hidden="true">
        <i style={{ transform: `scaleX(${p.necessary ? Math.min(1, p.recorded / p.necessary) : 0})` }} />
      </div>
      {p.items.length > 0 ? (
        <div className="card p-in d3">
          {p.items.map((v) => (
            <PlanRow key={v.item.id} v={v} month={month} onOpen={() => setItemId(v.item.id)} hint={s.hints.get(v.item.id) ?? null} />
          ))}
        </div>
      ) : (
        <p className="note p-in d3">這個月還沒有必要支出。房租、水電、電話費這類每月一定要付的，加進來就能算出還可以花多少。</p>
      )}
      <button type="button" className="add-line p-in d3" onClick={() => setEditor({ kind: 'new', month })}>
        <Icon name="plus" />
        新增必要支出
      </button>

      <div className="sec-head p-in d3">
        <h2>每月固定項目</h2>
        <span>{s.activeTemplates} 個使用中</span>
      </div>
      <div className="card p-in d3">
        <button type="button" className="row" onClick={onTemplates}>
          <span className="row-main">
            <span className="row-title">管理固定項目</span>
            <span className="row-sub">新增、改名、預設金額、日期、刪除</span>
          </span>
          <Icon name="chev" className="chev" />
        </button>
      </div>
      <p className="note">預估金額不是銀行存款，也不是已經存下的錢；首頁的結餘只算實際記帳。</p>

      <PlanItemSheet
        view={item}
        month={month}
        onClose={() => setItemId(null)}
        onRecord={(v) => {
          setItemId(null)
          onRecord(v)
        }}
        onEditTx={onEditTx}
        onEdit={(v) => {
          setItemId(null)
          setEditor({ kind: 'item', month, item: v.item })
        }}
        catName={(id) => ref.category(id).name}
        payName={(id) => ref.payment(id).name}
        taken={s.taken}
      />
      <PlanNumberSheet field={numbers} month={month} summary={p} suggestion={suggestion} onClose={() => setNumbers(null)} />
      <PlanItemEditor target={editor} onClose={() => setEditor(null)} />
    </>
  )
}

function PlanRow({ v, month, onOpen, hint }: { v: PlanItemView; month: string; onOpen: () => void; hint: string | null }) {
  const [, m] = month.split('-').map(Number)
  let sub = planDayLabel(v.item)
  if (v.state === 'linked') sub += ' · 已記帳'
  else if (v.state === 'skipped') sub += ' · 本月略過'
  else if (v.broken) sub = v.broken.kind === 'deleted' ? '原本對應的記帳已刪除' : v.broken.kind === 'moved' ? `原本對應的記帳已移到 ${Number(v.broken.month.slice(5))} 月` : '原本對應的記帳已不是支出'
  else if (hint) sub = hint
  else sub += ' · 待記帳'
  return (
    <button type="button" className={'row plan-row' + (v.state === 'skipped' ? ' skipped' : '')} onClick={onOpen} aria-label={`${v.item.name}，${sub}，${m} 月 NT$ ${fmt(v.value || v.item.amount)}`}>
      <span className={'st' + (v.state === 'linked' ? ' done' : '') + (v.state === 'skipped' ? ' skip' : '')} aria-hidden="true">
        <Icon name="check" />
      </span>
      <span className="row-main">
        <span className="row-title">{v.item.name}</span>
        <span className={'row-sub' + (v.broken ? ' warn-inline' : '')}>{sub}</span>
      </span>
      <span className="row-amt num">
        {fmt(v.state === 'skipped' ? v.item.amount : v.value)}
        {v.diff ? (
          <small className={'diff' + (v.diff < 0 ? ' less' : '')}>
            {v.diff > 0 ? '+' : '−'}
            {fmt(Math.abs(v.diff))}（預估 {fmt(v.item.amount)}）
          </small>
        ) : null}
      </span>
    </button>
  )
}
