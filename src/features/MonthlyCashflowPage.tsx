import { useMemo, useState } from 'react'
import { useAllTx, useMonthAdjustments, useMonthTx } from '../db/hooks'
import { sameYm, ymOf, type YearMonth } from '../lib/dates'
import { monthlyCashflow, type MonthlyMovement } from '../lib/monthlyCashflow'
import { computeFunding, fundingAvailable, fundingMonthKey, fundingMonthReport } from '../lib/funding'
import { fmt } from '../lib/money'
import { useToday } from '../lib/useToday'
import { Icon } from '../ui/Icon'
import { MonthSwitch } from '../ui/MonthSwitch'
import { useRefData } from '../ui/refData'

function Amount({ value }: { value: number }) {
  return <span className={'num' + (value < 0 ? ' neg' : '')}>{fmt(value)}</span>
}

function AccountMovement({ item, card, onOpen }: { item: MonthlyMovement; card?: boolean; onOpen: () => void }) {
  return (
    <button type="button" className="mc-account" onClick={onOpen}>
      <span className="mc-account-top">
        <strong>{item.name}</strong>
        <span className="mc-account-total"><Amount value={item.movement} /><Icon name="chev" /></span>
      </span>
      <span className="mc-account-parts">
        {item.income !== 0 && <span>收入 <Amount value={item.income} /></span>}
        {item.expense !== 0 && <span>{card ? '刷卡' : '支出'} <Amount value={item.expense} /></span>}
        {item.transfer !== 0 && <span>{card ? '繳款' : '互轉'} <Amount value={item.transfer} /></span>}
        {item.income === 0 && item.expense === 0 && item.transfer === 0 && <span>{item.transactionIds.length ? '本月進出相抵' : '只有餘額校正'}</span>}
      </span>
      {item.adjustment !== 0 && <span className="mc-adjust">餘額校正 <Amount value={item.adjustment} />（不含在上方變動）</span>}
    </button>
  )
}

export function MonthlyCashflowPage({ backLabel, onBack, onOpenAccount, onOpenTx }: {
  backLabel: string
  onBack: () => void
  onOpenAccount: (id: string) => void
  onOpenTx: (id: string) => void
}) {
  const today = useToday()
  const current = ymOf(new Date(`${today}T12:00:00`))
  const [month, setMonth] = useState<YearMonth>(current)
  const tx = useMonthTx(month)
  const allTx = useAllTx(true)
  const adjustments = useMonthAdjustments(month)
  const ref = useRefData()
  const report = useMemo(() => monthlyCashflow(month, ref.payments, tx ?? [], adjustments ?? []), [month, ref.payments, tx, adjustments])
  const funding = useMemo(() => computeFunding(ref.payments, allTx ?? []), [ref.payments, allTx])
  const totals = fundingMonthReport(funding.transactions, month)
  const key = fundingMonthKey(month)
  const bucketRows = ref.payments.filter((p) => (p.type === 'cash' || p.type === 'bank' || p.type === 'stored_value') && funding.buckets.has(`${key}|${p.id}`))
  const available = bucketRows.reduce((sum, p) => sum + fundingAvailable(funding.buckets.get(`${key}|${p.id}`)), 0)
  const opening = bucketRows.reduce((sum, p) => {
    const b = funding.buckets.get(`${key}|${p.id}`)!
    return sum + Math.max(0, b.opening + Math.min(0, b.earned))
  }, 0)
  const laterUses = funding.transactions.filter((t) => t.funding?.some((a) => a.month === key) && new Date(t.occurredAt) >= new Date(month.y, month.m + 1, 1))
  const laterExpense = laterUses.filter((t) => t.type === 'expense').reduce((sum, t) => sum + (t.funding?.find((a) => a.month === key)?.earnedAmount ?? 0), 0)
  const empty = allTx !== undefined && totals.income === 0 && totals.expense === 0
  const unknown = report.unassigned

  return (
    <>
      <div className="page-head">
        <button type="button" className="back" onClick={onBack}><Icon name="left" />{backLabel}</button>
        <h1>月度收支</h1>
        <span />
      </div>
      <div className="mc-month"><MonthSwitch value={month} onChange={setMonth} /></div>
      <section className="mc-summary" aria-label="本月收支">
        <div className="mc-summary-title">{sameYm(month, current) ? '截至目前' : `${month.y} 年 ${month.m + 1} 月`}</div>
        <div className="mc-result"><span>結餘</span><strong className={totals.balance < 0 ? 'neg num' : 'num'}>NT$ {fmt(totals.balance)}</strong></div>
        <div className="mc-math">
          <div><span>本月收入</span><b className="num pos">{fmt(totals.income)}</b></div>
          <span aria-hidden="true">−</span>
          <div><span>本月資金支出</span><b className="num">{fmt(totals.expense)}</b></div>
          <span aria-hidden="true">＝</span>
          <div><span>本月結餘</span><b className={'num' + (totals.balance < 0 ? ' neg' : '')}>{fmt(totals.balance)}</b></div>
        </div>
        <p>收入按入帳月份；支出按選定的資金月份。實際操作日期仍留在交易明細。</p>
        {laterExpense > 0 && <p>其中當月操作支出 NT$ {fmt(totals.expense - laterExpense)}；後續月份使用本月收入 NT$ {fmt(laterExpense)}。</p>}
      </section>
      <section className="mc-section">
        <h2>本月可用資金</h2>
        <p>包含期初資金；期初資金不算收入。這是月份分配，不是帳戶目前餘額。</p>
        <div className="mc-card">
          <div className="mc-unassigned">全部帳戶 <Amount value={available} /></div>
          <div className="mc-unassigned">其中期初可用 <Amount value={opening} /></div>
          {totals.openingUsed > 0 && <div className="mc-unassigned">後續使用期初資金 <Amount value={-totals.openingUsed} /></div>}
          {bucketRows.map((p) => <button type="button" className="mc-unknown-tx" key={p.id} onClick={() => onOpenAccount(p.id)}><span>{p.name}</span><Amount value={fundingAvailable(funding.buckets.get(`${key}|${p.id}`))} /></button>)}
        </div>
      </section>
      {laterUses.length > 0 && <section className="mc-section">
        <h2>後續月份使用此月資金</h2>
        <div className="mc-card">{laterUses.map((t) => <button type="button" className="mc-unknown-tx" key={t.id} onClick={() => onOpenTx(t.id)}><span>{new Date(t.occurredAt).getMonth() + 1} 月 {new Date(t.occurredAt).getDate()} 日 · {t.type === 'transfer' ? '互轉' : t.merchant || '支出'}{t.type === 'expense' && (t.funding!.find((a) => a.month === key)!.earnedAmount ?? 0) < t.funding!.find((a) => a.month === key)!.amount ? '（含期初資金）' : ''}</span><Amount value={t.funding!.find((a) => a.month === key)!.amount} /></button>)}</div>
      </section>}
      {empty && <div className="empty mc-empty"><strong>這個月還沒有收入或資金支出</strong>若有互轉、期初資金或校正，仍會列在下方。</div>}

      <section className="mc-section">
        <h2>按操作日期的帳戶變動</h2>
        <p>這裡記錄實際在這個月發生的進出，與上方資金月份不同。點帳戶看完整明細。</p>
        {report.accounts.length ? <div className="mc-card">{report.accounts.map((item) => <AccountMovement key={item.id} item={item} onOpen={() => onOpenAccount(item.id)} />)}</div> : <div className="mc-none">這個月沒有帳戶資金變動</div>}
      </section>

      {report.cards.length > 0 && <section className="mc-section">
        <h2>信用卡預扣變動</h2>
        <p>刷卡會增加預扣；繳款會減少預扣，銀行扣款列在上方。</p>
        <div className="mc-card">{report.cards.map((item) => <AccountMovement key={item.id} item={item} card onOpen={() => onOpenAccount(item.id)} />)}</div>
      </section>}

      {unknown.transactionIds.length > 0 && <section className="mc-section">
        <h2>未指定帳戶</h2>
        <p>這些收支已算進上方結餘，但尚未對應到帳戶。</p>
        <div className="mc-card">
          <div className="mc-unassigned">本月變動 <Amount value={unknown.movement} /></div>
          {unknown.transactionIds.map((id) => {
            const item = tx?.find((t) => t.id === id)
            return item && <button type="button" className="mc-unknown-tx" key={id} onClick={() => onOpenTx(id)}>
              <span>{item.merchant || (item.type === 'income' ? '收入' : '支出')}</span>
              <Amount value={item.type === 'income' ? item.amount : -item.amount} />
            </button>
          })}
        </div>
      </section>}
    </>
  )
}
