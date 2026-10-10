import { usePayslips, useSalaryItems } from '../../db/hooks'
import { payslipTotals } from '../../db/salary'
import { fmt } from '../../lib/money'
import { currentMonthKey, monthKeyLabel, monthRange } from '../../lib/months'
import { defaultNewMonth } from '../../lib/salaryHistory'
import { Icon } from '../../ui/Icon'

/** D-73: every month from the latest payslip back to the first, gaps included. */
export function PayslipListPage({
  onBack,
  backLabel,
  onOpen,
  onNew,
  onSeeIncome,
}: {
  onBack: () => void
  backLabel: string
  onOpen: (id: string) => void
  onNew: (month: string) => void
  onSeeIncome: () => void
}) {
  const slips = usePayslips()
  const items = useSalaryItems()
  if (!slips || !items) return null
  const kindOf = (id: string) => items.find((i) => i.id === id)?.kind
  const byMonth = new Map(slips.map((s) => [s.month, s]))
  const next = defaultNewMonth(slips)
  const months = slips.length ? monthRange(slips[0].month, slips[slips.length - 1].month).reverse() : []
  const years = [...new Set(months.map((m) => m.slice(0, 4)))]

  return (
    <>
      <div className="page-head">
        <button type="button" className="back" onClick={onBack}>
          <Icon name="left" />
          {backLabel}
        </button>
        <h1>薪資單</h1>
        <span />
      </div>
      {next <= currentMonthKey() ? (
        <button type="button" className="add-slip" onClick={() => onNew(next)}>
          <Icon name="plus" />
          新增 {monthKeyLabel(next)}薪資單
        </button>
      ) : (
        <p className="set-foot" style={{ margin: '12px 4px 0' }}>
          本月的薪資單已建立，{monthKeyLabel(next)}的薪資單可以在 {Number(next.slice(5))} 月之後新增。
        </p>
      )}

      {slips.length === 0 && (
        <div className="empty">
          <strong>還沒有薪資單</strong>
          每個月建立一張，就能看到本薪、獎金、勞健保這些項目的歷史變化。儲存時會自動記入一筆薪資收入。
        </div>
      )}

      {years.map((y) => (
        <section key={y}>
          <div className="year-head">{y} 年</div>
          <div className="card">
            {months
              .filter((m) => m.startsWith(y))
              .map((m) => {
                const s = byMonth.get(m)
                if (!s) {
                  return (
                    <button type="button" key={m} className="row gap" onClick={() => onNew(m)}>
                      <span className="slip-month">
                        {Number(m.slice(5))}
                        <small>月</small>
                      </span>
                      <span className="row-main">
                        <span className="row-title">尚無薪資單</span>
                      </span>
                      <span className="row-act">補建 ›</span>
                    </button>
                  )
                }
                const t = payslipTotals(s.lines, kindOf)
                return (
                  <button type="button" key={m} className="row" onClick={() => onOpen(s.id)}>
                    <span className="slip-month">
                      {Number(m.slice(5))}
                      <small>月</small>
                    </span>
                    <span className="row-main">
                      <span className="slip-net">{t.net > 0 ? `NT$${fmt(t.net)}` : `實領 ${fmt(t.net)}`}</span>
                      <span className="row-sub">
                        發薪 {Number(s.payDate.slice(5, 7))}/{Number(s.payDate.slice(8))}
                        {s.company ? ` · ${s.company}` : ''}
                      </span>
                    </span>
                    <Icon name="chev" className="chev" />
                  </button>
                )
              })}
          </div>
        </section>
      ))}

      <p className="set-foot">
        每個月一張薪資單。沒有建立的月份在項目歷史裡顯示為缺口，不會被當成 0 元。      </p>
      <button type="button" className="text-link" onClick={onSeeIncome}>
        查看所有薪資收入 ›
      </button>
    </>
  )
}
