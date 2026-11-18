import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES } from '../db/defaults'
import { MoneyDB } from '../db/db'
import { addPaymentMethod, deleteTransaction } from '../db/repo'
import { commitNotificationImport, getLineChatBaseline, knownLineChatCaptures, saveLineChatBaseline } from './cardRepo'
import { planImport } from './importPlan'
import { readLineChatText } from './lineChatFile'
import { inspectLineChat, marker, nextLineChatBaseline } from './lineChatBaseline'
import { completeUnparsed, skipLineRow } from './lineChatReview'

const now = new Date(2026, 10, 14, 14)
const text = `[LINE] 與LINE錢包的聊天記錄\n2026/11/13（五）\n12:34\tLINE錢包\t"LINE Pay 付款 NT$ 125\n付款完成。\n商店名稱: 測試商店"`
let d: MoneyDB
let cardId: string
let walletId: string
let serial = 0

beforeEach(async () => {
  d = new MoneyDB(`line-chat-${serial++}`)
  await d.open()
  cardId = (await addPaymentMethod({ name: '測試卡', type: 'credit_card' }, d)).id
  walletId = (await addPaymentMethod({ name: 'LINE Pay', type: 'mobile', cards: [cardId] }, d)).id
})
afterEach(() => d.close())

async function plan(raw = text) {
  const { captures } = await readLineChatText(raw, 'chat.txt', now)
  return planImport({
    captures,
    knownCaptureIds: await knownLineChatCaptures(d),
    transactions: await d.transactions.toArray(),
    paymentMethods: await d.paymentMethods.toArray(),
    categories: DEFAULT_CATEGORIES,
    history: [],
    defaultCards: {},
    noticeTypes: [{ id: 'test', name: 'LINE Pay', keywords: ['LINE Pay'], paymentMethodId: walletId, cardId }],
    now,
  }).filter((r) => r.status !== 'duplicate')
}

describe('LINE chat notification commit', () => {
  it('does not treat a damaged stored cursor as a first-time import', async () => {
    await d.settings.put({ key: 'lineChatBaseline', value: { id: 'bad', at: now.toISOString() } })
    await expect(getLineChatBaseline(d)).rejects.toThrow('起點資料不正確')
  })
  it('commits new rows and the cursor together; a stale preview changes neither', async () => {
    const read = await readLineChatText(`${text}\n12:35\tLINE錢包\t"LINE Pay 付款 NT$ 75\n付款完成。\n商店名稱: 第二筆"`, 'chat.txt', now)
    const first = marker(read.messages[0])
    await saveLineChatBaseline(null, first, d)
    await expect(saveLineChatBaseline(first.id, { ...first, at: new Date(2026, 10, 12).toISOString() }, d)).rejects.toThrow('只能往後移')
    const checked = inspectLineChat(read, first)
    expect(checked?.kind).toBe('ready')
    if (checked?.kind !== 'ready') return
    const rows = (await plan(`[LINE] 與LINE錢包的聊天記錄\n2026/11/13（五）\n12:35\tLINE錢包\t"LINE Pay 付款 NT$ 75\n付款完成。\n商店名稱: 第二筆"`))
      .map((row) => ({ ...row, status: 'new' as const, include: true, source: { cardId } }))
    const next = nextLineChatBaseline(read.messages, first, checked.baselineIndex, new Set())
    await expect(commitNotificationImport(rows, { files: 1, lineChatBaseline: { expectedId: 'wrong', next } }, d, now)).rejects.toThrow('起點已變更')
    expect(await d.transactions.count()).toBe(0)
    expect(await getLineChatBaseline(d)).toEqual(first)
    await commitNotificationImport(rows, { files: 1, lineChatBaseline: { expectedId: first.id, next } }, d, now)
    expect(await d.transactions.count()).toBe(1)
    expect(await getLineChatBaseline(d)).toEqual(next)
  })
  it('does not keep message text, hides repeated exports, and can re-import after deletion', async () => {
    const rows = await plan()
    expect(rows).toHaveLength(1)
    await commitNotificationImport(rows, { files: 1 }, d, now)
    const saved = (await d.importedNotifications.toArray())[0]
    expect(saved).toMatchObject({ sourceType: 'line_chat', body: null, title: null, subtitle: null, status: 'imported' })
    expect(saved.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(saved)).not.toContain('LINE Pay 付款')
    expect(await plan()).toEqual([])
    const tx = (await d.transactions.toArray())[0]
    await deleteTransaction(tx.id, d)
    const again = await plan()
    expect(again).toHaveLength(1)
    await commitNotificationImport(again, { files: 1 }, d, now)
    expect(await d.transactions.count()).toBe(1)
    expect(await d.importedNotifications.count()).toBe(1)
  })

  it('remembers explicit permanent skips but leaves ordinary unchecked rows available', async () => {
    const rows = await plan()
    await commitNotificationImport(rows.map((r) => ({ ...r, include: false })), { files: 1 }, d, now)
    expect(await plan()).toHaveLength(1)
    await commitNotificationImport(rows.map((r) => ({ ...r, include: false, permanentSkip: true })), { files: 1 }, d, now)
    expect(await plan()).toEqual([])
    expect((await d.importedNotifications.toArray())[0]).toMatchObject({ status: 'skipped', body: null, parsed: null })
  })

  it('permanently skips an unparsed payment without storing its message', async () => {
    const raw = text.replace('NT$ 125', 'NT$ 0')
    const rows = await plan(raw)
    expect(rows[0].status).toBe('unparsed')
    await commitNotificationImport(rows.map(skipLineRow), { files: 1 }, d, now)
    expect(await plan(raw)).toEqual([])
    expect((await d.importedNotifications.toArray())[0]).toMatchObject({ status: 'skipped', body: null, parsed: null })
  })

  it('imports a manually completed unparsed LINE payment with its chosen source', async () => {
    const raw = text.replace('NT$ 125', 'NT$ 0')
    const rows = await plan(raw)
    const completed = completeUnparsed({ ...rows[0], amount: 125, merchant: '補填商店', source: { cardId } })
    await commitNotificationImport([completed], { files: 1 }, d, now)
    expect((await d.transactions.toArray())[0]).toMatchObject({ merchant: '補填商店', amount: 125, cardId })
    expect((await d.importedNotifications.toArray())[0]).toMatchObject({ status: 'imported', body: null })
  })
})
