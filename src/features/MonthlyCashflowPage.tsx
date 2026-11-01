import { useMemo, useState } from 'react'
import { useMonthAdjustments, useMonthTx } from '../db/hooks'
import { sameYm, ymOf, type YearMonth } from '../lib/dates'
import { monthlyCashflow, type MonthlyMovement } from '../lib/monthlyCashflow'
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
  const adjustments = useMonthAdjustments(month)
  const ref = useRefData()
  const report = useMemo(() => monthlyCashflow(month, ref.payments, tx ?? [], adjustments ?? []), [month, ref.payments, tx, adjustments])
  const empty = tx !== undefined && report.totals.income === 0 && report.totals.expense === 0
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
        <div className="mc-result"><span>結餘</span><strong className={report.totals.balance < 0 ? 'neg num' : 'num'}>NT$ {fmt(report.totals.balance)}</strong></div>
        <div className="mc-math">
          <div><span>實際收入</span><b className="num pos">{fmt(report.totals.income)}</b></div>
          <span aria-hidden="true">−</span>
          <div><span>實際支出</span><b className="num">{fmt(report.totals.expense)}</b></div>
          <span aria-hidden="true">＝</span>
          <div><span>本月結餘</span><b className={'num' + (report.totals.balance < 0 ? ' neg' : '')}>{fmt(report.totals.balance)}</b></div>
        </div>
        <p>只計這個月記下的實際收支；互轉與繳卡費不會重複計入。</p>
      </section>
      {empty && <div className="empty mc-empty"><strong>這個月還沒有收支紀錄</strong>各帳戶若有互轉或校正，仍會列在下方。</div>}

      <section className="mc-section">
        <h2>各帳戶本月變動</h2>
        <p>這裡是本月進出，不是帳戶目前餘額。點帳戶看完整明細。</p>
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
