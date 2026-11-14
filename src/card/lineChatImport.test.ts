import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES } from '../db/defaults'
import { MoneyDB } from '../db/db'
import { addPaymentMethod, deleteTransaction } from '../db/repo'
import { commitNotificationImport, knownLineChatCaptures } from './cardRepo'
import { planImport } from './importPlan'
import { readLineChatText } from './lineChatFile'

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

async function plan() {
  const { captures } = await readLineChatText(text, 'chat.txt', now)
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
})
