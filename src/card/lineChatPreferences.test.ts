import { describe, expect, it } from 'vitest'
import { findLineChatMerchantAlias, lineChatMerchantIndex, lineChatMerchantSuggestions, roundLineChatMinute, saveLineChatMerchantAlias } from './lineChatPreferences'
import type { Transaction } from '../db/types'

describe('LINE chat import preferences', () => {
  it('rounds only odd minutes and carries to the next hour or day', () => {
    expect(roundLineChatMinute(new Date(2026, 10, 13, 17, 1).toISOString())).toBe(new Date(2026, 10, 13, 17, 2).toISOString())
    expect(roundLineChatMinute(new Date(2026, 10, 13, 16, 59).toISOString())).toBe(new Date(2026, 10, 13, 17, 0).toISOString())
    expect(roundLineChatMinute(new Date(2026, 10, 13, 23, 59).toISOString())).toBe(new Date(2026, 10, 14, 0, 0).toISOString())
    expect(roundLineChatMinute(new Date(2026, 10, 13, 17, 2).toISOString())).toBe(new Date(2026, 10, 13, 17, 2).toISOString())
  })

  it('prefers exact originals, then latest similar correction, and can cancel an alias', () => {
    const a = saveLineChatMerchantAlias([], '統一超商中山店', '7-11', 'daily', '2026-11-13T00:00:00.000Z')
    const b = saveLineChatMerchantAlias(a, '統一超商台北店', '小七', 'food', '2026-11-14T00:00:00.000Z')
    expect(findLineChatMerchantAlias('統一超商中山店', b)?.preferred).toBe('7-11')
    expect(findLineChatMerchantAlias('統一超商新竹店', b)?.preferred).toBe('小七')
    const cancelled = saveLineChatMerchantAlias(b, '統一超商中山店', '統一超商中山店', 'daily', '2026-11-15T00:00:00.000Z')
    expect(findLineChatMerchantAlias('統一超商中山店', cancelled)?.preferred).toBe('統一超商中山店')
    expect(findLineChatMerchantAlias('統一超商新竹店', cancelled)?.preferred).toBe('小七')
  })

  it('suggests distinct previously recorded expense merchants', () => {
    const tx = (merchant: string, at: string, type: Transaction['type'] = 'expense') => ({ merchant, occurredAt: at, updatedAt: at, type, categoryId: 'food' }) as Transaction
    const index = lineChatMerchantIndex([tx('7-11', '2026-11-13'), tx('7-11', '2026-11-12'), tx('7-Eleven', '2026-11-11'), tx('7薪資', '2026-11-14', 'income')])
    expect(lineChatMerchantSuggestions('7', index).map((x) => x.merchant)).toEqual(['7-11', '7-Eleven'])
  })
})
