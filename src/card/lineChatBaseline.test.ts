import { describe, expect, it } from 'vitest'
import { canResetLineChatBaseline, inspectLineChat, marker, nextLineChatBaseline } from './lineChatBaseline'
import { readLineChatText } from './lineChatFile'

const now = new Date(2026, 10, 14, 14)
const pay = (amount: number) => `LINE Pay 付款 NT$ ${amount}\n商店名稱: 測試`
const file = (older = false) => `[LINE] 與LINE錢包的聊天記錄\n${older ? '2026/06/01（一）\n10:00\tLINE錢包\t"' + pay(10) + '"\n' : ''}2026/11/13（五）\n12:00\tLINE錢包\t"歡迎"\n12:01\tLINE錢包\t"${pay(20)}"\n12:02\tLINE錢包\t"${pay(30)}"\n12:03\tLINE錢包\t"一般聊天"`

describe('LINE chat baseline', () => {
  it('initially skips all payment candidates including those older than 120 days; the last nonpayment is the marker', async () => {
    const read = await readLineChatText(file(true), 'chat.txt', now)
    const inspection = inspectLineChat(read, null)
    expect(inspection).toMatchObject({ kind: 'first', skippedPayments: 3 })
    expect(inspection && 'last' in inspection ? inspection.last.id : null).toBe(read.messages.at(-1)?.id)
    expect(read.captures).toHaveLength(2)
  })

  it('shows only messages after the marker, counts expired, and advances to before the first deferred item', async () => {
    const read = await readLineChatText(file(true), 'chat.txt', now)
    const baseline = marker(read.messages[0])
    const inspection = inspectLineChat(read, baseline)
    expect(inspection?.kind).toBe('ready')
    if (inspection?.kind !== 'ready') return
    expect(inspection.captures).toHaveLength(2)
    const deferred = new Set([read.messages[3].id])
    expect(nextLineChatBaseline(read.messages, inspection.baselineIndex, deferred)).toEqual(marker(read.messages[2]))
    expect(nextLineChatBaseline(read.messages, inspection.baselineIndex, new Set())).toEqual(marker(read.messages.at(-1)!))
  })

  it('stops on a missing marker and refuses backwards or same-time reset', async () => {
    const read = await readLineChatText(file(), 'chat.txt', now)
    const old = marker(read.messages[0])
    expect(canResetLineChatBaseline(read.messages, old)).toBe(true)
    expect(inspectLineChat(read, { ...old, id: 'line-chat:' + 'a'.repeat(64) + ':1' })?.kind).toBe('missing')
    expect(canResetLineChatBaseline(read.messages, marker(read.messages.at(-1)!))).toBe(false)
    expect(canResetLineChatBaseline(read.messages, { ...old, at: read.messages.at(-1)!.at })).toBe(false)
  })

  it('reports payments that have passed the 120-day window after an older marker', async () => {
    const raw = `[LINE] 與LINE錢包的聊天記錄\n2026/06/01（一）\n10:00\tLINE錢包\t"歡迎"\n10:01\tLINE錢包\t"${pay(10)}"\n2026/11/13（五）\n12:00\tLINE錢包\t"${pay(20)}"`
    const read = await readLineChatText(raw, 'chat.txt', now)
    expect(inspectLineChat(read, marker(read.messages[0]))).toMatchObject({ kind: 'ready', expired: 1 })
  })
})
