import { fmt } from '../lib/money'

export function PrivateAmount({ value, visible }: { value: number; visible: boolean }) {
  return visible ? (
    <span className="private-value" key="value">{fmt(value)}</span>
  ) : (
    <span className="amount-mask" role="img" aria-label="金額已隱藏" key="mask">
      <span aria-hidden="true"><i /><i /><i /><i /></span>
    </span>
  )
}
