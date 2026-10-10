import type { CSSProperties } from 'react'

export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  label: string
  className?: string
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value))
  const style = { '--n': options.length, '--i': idx } as CSSProperties
  return (
    <div className={'seg' + (className ? ' ' + className : '')} role="group" aria-label={label} style={style}>
      <span className="seg-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
