import { describe, expect, it } from 'vitest'
import { parseTaishinDebit } from './taishinDebit'

describe('台新簽帳金融卡對帳單', () => {
  const lines = [
    '台新銀行簽帳金融卡 10月份消費對帳單',
    '對帳單期間：2026/10/01 ~ 2026/10/31',
    '消費明細',
    '卡號末四碼：7506',
    '2026/10/01 2026/09/23  0  220',
    '2026/10/07 2026/07/03  0  -160',
    '本月消費金額共計NT$ 220',
    '本月退款金額共計NT$ -160',
    '已消費未扣款明細',
    '2026/10/29 TW 250',
    '帳戶交易明細',
    '日期  摘要  支出  存入  餘額  備註',
    '2026/10/01 刷卡消費 220 0 93,533 連加＊商店',
    '2026/10/07 刷卡退貨 0 160 93,693 連加＊商店',
    '2026/10/08 CD 提款 1,000 0 92,693',
    '2026/10/09 轉帳存入 0 500 93,193',
  ]

  it('separates card purchases, pending authorizations and bank flows; merges reliable duplicate evidence', () => {
    const parsed = parseTaishinDebit(lines)
    expect(parsed.periodStart).toBe('2026-10-01')
    expect(parsed.periodEnd).toBe('2026-10-31')
    expect(parsed.cardLast4).toBe('7506')
    expect(parsed.pendingCount).toBe(1)
    expect(parsed.entries.map((entry) => [entry.kind, entry.amount, entry.evidence])).toEqual([
      ['purchase', 220, 'both'],
      ['refund', -160, 'both'],
      ['withdrawal', 1000, 'account'],
      ['deposit', -500, 'account'],
    ])
    expect(parsed.entries[0]?.txDate).toBe('2026-09-23')
    expect(parsed.entries[0]?.postDate).toBe('2026-10-01')
    expect(parsed.cardTotalsMatch).toBe(true)
  })

  it('leaves repeated same-day amounts separate for manual review', () => {
    const parsed = parseTaishinDebit([
      '台新銀行簽帳金融卡 10月份消費對帳單',
      '對帳單期間：2026/10/01 ~ 2026/10/31',
      '消費明細',
      '2026/10/13 2026/10/07 0 35',
      '2026/10/13 2026/10/07 0 35',
      '帳戶交易明細',
      '日期 摘要 支出 存入 餘額 備註',
      '2026/10/13 刷卡消費 35 0 1000',
      '2026/10/13 刷卡消費 35 0 965',
    ])
    expect(parsed.entries).toHaveLength(4)
    expect(parsed.entries.every((entry) => entry.evidence !== 'both')).toBe(true)
    expect(parsed.warnings.some((warning) => warning.includes('重複金額'))).toBe(true)
  })
})
