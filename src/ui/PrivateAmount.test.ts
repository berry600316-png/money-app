import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrivateAmount } from './PrivateAmount'

describe('private home figures', () => {
  const render = (value: number, visible: boolean) => renderToStaticMarkup(createElement(PrivateAmount, { value, visible }))
  it('does not expose the amount or its length in hidden markup', () => {
    const hidden = render(987654, false)
    expect(hidden).toBe(render(0, false))
    expect(hidden).toBe(render(-123, false))
    expect(hidden).not.toContain('987')
    expect(hidden).toContain('金額已隱藏')
    expect(hidden.match(/<i>/g)).toHaveLength(4)
  })
  it('shows the formatted value only when explicitly revealed', () => {
    expect(render(987654, true)).toContain('987,654')
    expect(render(987654, true)).not.toContain('amount-mask')
  })
})
