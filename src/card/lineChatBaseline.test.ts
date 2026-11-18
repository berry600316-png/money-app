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
    expect(nextLineChatBaseline(read.messages, baseline, inspection.baselineIndex, deferred)).toEqual(marker(read.messages[2]))
    expect(nextLineChatBaseline(read.messages, baseline, inspection.baselineIndex, new Set())).toEqual(marker(read.messages.at(-1)!))
  })

  it('accepts a missing marker for import but refuses backwards or same-time manual reset', async () => {
    const read = await readLineChatText(file(), 'chat.txt', now)
    const old = marker(read.messages[0])
    expect(canResetLineChatBaseline(read.messages, old)).toBe(true)
    expect(inspectLineChat(read, { ...old, id: 'line-chat:' + 'a'.repeat(64) + ':1' })?.kind).toBe('ready')
    expect(canResetLineChatBaseline(read.messages, marker(read.messages.at(-1)!))).toBe(false)
    expect(canResetLineChatBaseline(read.messages, { ...old, at: read.messages.at(-1)!.at })).toBe(false)
  })

  it('reports payments that have passed the 120-day window after an older marker', async () => {
    const raw = `[LINE] 與LINE錢包的聊天記錄\n2026/06/01（一）\n10:00\tLINE錢包\t"歡迎"\n10:01\tLINE錢包\t"${pay(10)}"\n2026/11/13（五）\n12:00\tLINE錢包\t"${pay(20)}"`
    const read = await readLineChatText(raw, 'chat.txt', now)
    expect(inspectLineChat(read, marker(read.messages[0]))).toMatchObject({ kind: 'ready', expired: 1 })
  })

  it('uses one import path for a full export followed by a newer-only fragment', async () => {
    const base = `[LINE] 與LINE錢包的聊天記錄\n2026/11/11（三）\n10:00\tLINE錢包\t"歡迎"`
    const first = await readLineChatText(`${base}\n2026/11/16（一）\n10:00\tLINE錢包\t"${pay(40)}"`, 'first.txt', new Date(2026, 10, 18, 15))
    const initial = await readLineChatText(base, 'baseline.txt', new Date(2026, 10, 18, 15))
    const firstCheck = inspectLineChat(first, marker(initial.messages.at(-1)!))
    expect(firstCheck).toMatchObject({ kind: 'ready', baselineIndex: 0 })
    if (firstCheck?.kind !== 'ready') return
    expect(firstCheck.captures).toHaveLength(1)

    const second = await readLineChatText(`[LINE] 與LINE錢包的聊天記錄\n2026/11/18（三）\n12:53\tLINE錢包\t"${pay(50)}"`, 'second.txt', new Date(2026, 10, 18, 15))
    const secondCheck = inspectLineChat(second, marker(first.messages.at(-1)!))
    expect(secondCheck).toMatchObject({ kind: 'ready', baselineIndex: -1 })
    if (secondCheck?.kind !== 'ready') return
    expect(secondCheck.captures).toHaveLength(1)
    expect(nextLineChatBaseline(second.messages, marker(first.messages.at(-1)!), secondCheck.baselineIndex, new Set()))
      .toEqual(marker(second.messages[0]))
  })

  it('includes an unseen same-minute message without requiring the old marker', async () => {
    const previous = await readLineChatText(`[LINE] 與LINE錢包的聊天記錄\n2026/11/13（五）\n12:00\tLINE錢包\t"${pay(20)}"`, 'previous.txt', now)
    const fragment = await readLineChatText(`[LINE] 與LINE錢包的聊天記錄\n2026/11/13（五）\n12:00\tLINE錢包\t"${pay(30)}"`, 'fragment.txt', now)
    expect(inspectLineChat(fragment, marker(previous.messages[0]))).toMatchObject({ kind: 'ready', baselineIndex: -1, captures: [{ captureId: fragment.messages[0].id }] })
    expect(nextLineChatBaseline(fragment.messages, marker(previous.messages[0]), -1, new Set())).toEqual(marker(previous.messages[0]))
  })

  it('surfaces a clipped identical same-minute payment as possible duplicate instead of silently losing it', async () => {
    const raw = `[LINE] 與LINE錢包的聊天記錄\n2026/11/13（五）\n12:00\tLINE錢包\t"${pay(20)}"`
    const previous = await readLineChatText(raw.replace('12:00\tLINE錢包', '11:59\tLINE錢包\t"一般訊息"\n12:00\tLINE錢包'), 'previous.txt', now)
    const fragment = await readLineChatText(raw, 'fragment.txt', now)
    const baseline = marker(previous.messages.at(-1)!, previous.exportFingerprint!)
    const inspection = inspectLineChat(fragment, baseline, new Set([baseline.id]))
    expect(inspection?.kind).toBe('ready')
    if (inspection?.kind !== 'ready') return
    expect(inspection.captures).toHaveLength(1)
    expect(inspection.captures[0].captureId).not.toBe(baseline.id)
    expect(inspection.ambiguousIds).toContain(inspection.captures[0].captureId)
    const known = new Set([baseline.id, inspection.captures[0].captureId])
    expect(inspectLineChat(fragment, baseline, known)).toMatchObject({ kind: 'ready', captures: [] })
    expect(inspectLineChat(previous, baseline, new Set([baseline.id]))).toMatchObject({ kind: 'ready', captures: [] })
  })

  it('ignores older and already processed rows in a multi-message fragment', async () => {
    const previous = await readLineChatText(`[LINE] 與LINE錢包的聊天記錄\n2026/11/13（五）\n12:00\tLINE錢包\t"${pay(20)}"`, 'previous.txt', now)
    const baseline = marker(previous.messages[0])
    const fragment = await readLineChatText(`[LINE] 與LINE錢包的聊天記錄\n2026/11/11（三）\n12:00\tLINE錢包\t"${pay(10)}"\n2026/11/14（六）\n12:00\tLINE錢包\t"${pay(30)}"\n12:01\tLINE錢包\t"${pay(40)}"`, 'fragment.txt', new Date(2026, 10, 14, 14))
    const known = new Set([fragment.messages[1].id])
    const check = inspectLineChat(fragment, baseline, known)
    expect(check).toMatchObject({ kind: 'ready', baselineIndex: -1, captures: [{ captureId: fragment.messages[2].id }] })
    expect(nextLineChatBaseline(fragment.messages, baseline, -1, new Set([fragment.messages[2].id])))
      .toEqual(marker(fragment.messages[1]))
    expect(nextLineChatBaseline(fragment.messages, baseline, -1, new Set([fragment.messages[1].id]))).toEqual(baseline)
    expect(inspectLineChat(previous, marker(fragment.messages[2]))?.kind).toBe('out_of_order')
  })

  it('keeps the baseline before a deferred possible duplicate with a file-scoped ID', async () => {
    const previous = await readLineChatText('[LINE] 與LINE錢包的聊天記錄\n2026/11/13（五）\n11:59\tLINE錢包\t"歡迎"', 'previous.txt', now)
    const baseline = marker(previous.messages.at(-1)!, previous.exportFingerprint!)
    const fragment = await readLineChatText(`[LINE] 與LINE錢包的聊天記錄\n2026/11/14（六）\n12:00\tLINE錢包\t"${pay(20)}"`, 'fragment.txt', new Date(2026, 10, 14, 14))
    const check = inspectLineChat(fragment, baseline, new Set([fragment.messages[0].id]))
    expect(check?.kind).toBe('ready')
    if (check?.kind !== 'ready') return
    const ambiguousId = check.ambiguousIds[0]
    expect(ambiguousId).toBeDefined()
    expect(nextLineChatBaseline(fragment.messages, baseline, check.baselineIndex, new Set([ambiguousId]), fragment.exportFingerprint!, check.ambiguousSourceIds))
      .toEqual(baseline)
  })

  it('does not reintroduce a genuine first-message marker when a full export adds later payments', async () => {
    const raw = `[LINE] 與LINE錢包的聊天記錄\n2026/11/13（五）\n12:00\tLINE錢包\t"${pay(20)}"`
    const previous = await readLineChatText(raw, 'previous.txt', now)
    const full = await readLineChatText(`${raw}\n12:01\tLINE錢包\t"${pay(30)}"`, 'full.txt', now)
    const check = inspectLineChat(full, marker(previous.messages[0], previous.exportFingerprint!))
    expect(check).toMatchObject({ kind: 'ready', captures: [{ captureId: full.messages[1].id }], ambiguousIds: [] })
  })
})
