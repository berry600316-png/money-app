/** New Taiwan dollar amounts are always stored as positive integers (no floats). */
export const MAX_AMOUNT = 99_999_999

export function isValidAmount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= MAX_AMOUNT
}

/** 18420 → "18,420" */
export function fmt(n: number): string {
  const sign = n < 0 ? '−' : ''
  return sign + Math.abs(Math.round(n)).toLocaleString('en-US')
}

/** Short label for chart ticks: 18420 → "1.8萬", 9200 → "9,200" */
export function compact(n: number): string {
  if (n >= 10_000) return (n / 10_000).toFixed(1).replace(/\.0$/, '') + '萬'
  return fmt(n)
}

/** Keypad input: append a key to the digit string, or undefined if it should be ignored. */
export function applyKey(current: string, key: string): string | undefined {
  if (key === 'back') return current.slice(0, -1)
  if (key === 'clear') return ''
  if (!/^\d{1,2}$/.test(key)) return undefined
  if (current === '' && /^0+$/.test(key)) return undefined
  const next = current + key
  if (Number(next) > MAX_AMOUNT) return undefined
  return next
}
