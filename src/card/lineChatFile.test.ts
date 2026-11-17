import { describe, expect, it } from 'vitest'
import { parseNotification } from './notificationParser'
import { hasLineChatTransactionTime, readLineChatText } from './lineChatFile'

const now = new Date(2026, 10, 14, 14)
const sample = (body: string, date = '2026/11/13', time = '12:34') =>
  `[LINE] 與LINE錢包的聊天記錄\n儲存日期： 2026/11/14 14:00\n\n${date}（五）\n${time}\tLINE錢包\t"${body}"\n`

describe('LINE wallet chat text import', () => {
  it('reads a multiline payment and uses the LINE message time', async () => {
    const text = sample('LINE Pay 付款 NT$ 125\n付款完成。\n商店名稱: 測試商店\n回饋: 1%')
    const result = await readLineChatText(text, 'chat.txt', now)
    expect(result.errors).toEqual([])
    expect(result.format).toBe('zh')
    expect(result.captures).toHaveLength(1)
    expect(result.coverage).toEqual({ first: '2026-11-13', last: '2026-11-13' })
    expect(result.captures[0]).toMatchObject({ sourceApp: 'LINE', sourceType: 'line_chat', title: 'LINE錢包', notificationTime: new Date(2026, 10, 13, 12, 34).toISOString() })
    expect(parseNotification(result.captures[0])).toMatchObject({ kind: 'spend', spend: { amount: 125, merchant: '測試商店' } })
  })

  it('auto-detects the Japanese wallet export and parses multiline payments with optional points', async () => {
    const text = `[LINE] LINE錢包とのトーク履歴\n保存日時：2026/11/14 13:00\n\n2026/11/13（金）\n12:34\tLINE錢包\t"LINE Pay お支払い NT$ 1,645\nお支払いが完了しました。\n加盟店: 範例餐廳,分店\n利用ポイント: 9 P"\n12:35\tLINE錢包\t"LINE Pay お支払い NT$ 65\nお支払いが完了しました。\n加盟店: 範例商店"`
    const result = await readLineChatText(text, 'wallet-ja.txt', now)
    expect(result.errors).toEqual([])
    expect(result.format).toBe('ja')
    expect(result.coverage).toEqual({ first: '2026-11-13', last: '2026-11-13' })
    expect(result.captures).toHaveLength(2)
    expect(result.captures.map((capture) => parseNotification(capture))).toMatchObject([
      { kind: 'spend', spend: { amount: 1645, merchant: '範例餐廳,分店' } },
      { kind: 'spend', spend: { amount: 65, merchant: '範例商店' } },
    ])
  })

  it('takes a labelled transaction time but ignores promotion times', async () => {
    const body = 'LINE Pay 付款 NT$ 125\n付款完成。\n商店名稱: 測試商店\n優惠至 18:00'
    const first = await readLineChatText(sample(body), 'chat.txt', now)
    expect(first.captures[0].notificationTime).toBe(new Date(2026, 10, 13, 12, 34).toISOString())
    const second = await readLineChatText(sample(`${body}\n交易時間：2026/11/13 11:22`), 'chat.txt', now)
    expect(second.captures[0].notificationTime).toBe(new Date(2026, 10, 13, 11, 22).toISOString())
    expect(hasLineChatTransactionTime(second.captures[0].body!)).toBe(true)
    expect(hasLineChatTransactionTime(first.captures[0].body!)).toBe(false)
  })

  it('ignores nonpayments, limits to 120 days, and gives identical messages distinct identities', async () => {
    const payment = 'LINE Pay 付款 NT$ 125\n付款完成。\n商店名稱: 測試商店'
    const text = `[LINE] 與LINE錢包的聊天記錄\n2026/06/01（一）\n12:00\tLINE錢包\t"${payment}"\n2026/11/13（五）\n12:34\tLINE錢包\t"歡迎使用"\n12:35\t朋友\t"${payment}"\n12:36\tLINE錢包\t"${payment}"\n12:36\tLINE錢包\t"${payment}"`
    const result = await readLineChatText(text, 'chat.txt', now)
    expect(result.captures).toHaveLength(2)
    expect(result.captures[0].captureId).not.toBe(result.captures[1].captureId)
    expect(result.captures[0].fingerprint).toBe(result.captures[1].fingerprint)
    expect(result.ignored).toBe(2)
    expect(result.coverage).toEqual({ first: '2026-06-01', last: '2026-11-13' })
    const again = await readLineChatText(text, 'another-export.txt', now)
    expect(again.captures.map((c) => c.captureId)).toEqual(result.captures.map((c) => c.captureId))
  })

  it('rejects a different chat export', async () => {
    expect((await readLineChatText('[LINE] 與朋友的聊天記錄', 'chat.txt', now)).errors[0]).toContain('LINE 錢包')
  })

  it('shows changed payment wording as unparsed instead of silently skipping it', async () => {
    const result = await readLineChatText(sample('LINE Pay 消費 NT$ 125\n商店名稱: 測試商店'), 'chat.txt', now)
    expect(result.captures).toHaveLength(1)
    expect(parseNotification(result.captures[0]).kind).toBe('unparsed')
  })
})
