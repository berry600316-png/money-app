import { addMonths, monthLabel, sameYm, ymOf, type YearMonth } from '../lib/dates'
import { Icon } from './Icon'

export function MonthSwitch({ value, onChange, dim }: { value: YearMonth; onChange: (ym: YearMonth) => void; dim?: boolean }) {
  const isCurrent = sameYm(value, ymOf(new Date()))
  return (
    <div className={'month-sw' + (dim ? ' dim' : '')}>
      <button type="button" aria-label="上個月" onClick={() => onChange(addMonths(value, -1))}>
        <Icon name="left" />
      </button>
      <span className="m-label" aria-live="polite">
        {monthLabel(value)}
      </span>
      <button type="button" aria-label="下個月" disabled={isCurrent} onClick={() => onChange(addMonths(value, 1))}>
        <Icon name="right" />
      </button>
    </div>
  )
}
