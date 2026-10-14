/*
 * LINE Pay notification import (D-128..D-131, spec §14 A–D). The wording follows the user's LINE 錢包
 * notification of 2026-10-12 (screenshot) and the JSON the user typed (Q103 B: not yet a real shortcut
 * capture). Shop names and amounts here are changed from the user's real purchase.
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBackup, parseBackup } from '../backup/format'
import { readAllData, restoreBackup } from '../backup/store'
import { MoneyDB } from '../db/db'
import { DEFAULT_CATEGORIES } from '../db/defaults'
import { addPaymentMethod, addTransaction, setStartBalances, updatePaymentMethod, type TxInput } from '../db/repo'
import { computeBalances } from '../lib/accounts'
import { summarize } from '../lib/stats'
import { commitNotificationImport, deleteNoticeType, getNoticeMethods, getNoticeTypes, saveNoticeType } from './cardRepo'
import type { NoticeType } from './noticeTypes'
import { capture } from './fixtures'
import { planImport, type PlanRow } from './importPlan'
import { LINE_PAY_ADAPTER, matchTemplate } from './notificationAdapters'
import { MAX_CAPTURES, MAX_FILE_BYTES, readCaptureFile, readCaptureFiles, type NotificationCapture } from './notificationFile'
import { parseNotification } from './notificationParser'

const PROMO =
  '回饋：中信 LINE Pay 卡一般消費回饋 1%，指定商店加碼回饋最高享 16%，國外實體商店消費最高享 2.8%（含國內外一般消費 1% 且限信用卡），天天回饋無上限。不回饋項目含：繳稅、超商、分期、各項代扣繳費用、電信費等。實'
/** As the user typed it (spec §4.3). */
const typed = (amount: string, shop: string) => `LINE Pay 付款 NT$ ${amount} 付款完成。商店名稱：${shop}：${PROMO}`
/** As on the lock screen: spaces after the colons. */
const screen = (amount: string, shop: string) => `LINE Pay 付款 NT$ ${amount} 付款完成。 商店名稱: ${shop}： 回饋: 中信LINE Pay卡一般消費回饋(繳稅/超商等不回饋): 1% 指定商店加碼回饋最高享16%，國外實體商店消費最高享2.8%。 實`

const at = new Date(2026, 9, 13, 10, 30)
const line = (body: string, p: Partial<NotificationCapture> = {}) =>
  capture({ sourceApp: 'LINE', title: 'LINE錢包', notificationTime: at.toISOString(), capturedAt: at.toISOString(), ...p, body: p.body ?? body })

const parsed = (c: NotificationCapture) => parseNotification(c)

describe('B. LINE Pay wording (D-128)', () => {
  it('reads the amount and the shop in every spacing; the promotion is ignored', () => {
    for (const [body, amount] of [
      [typed('661', '好鄰居超市永和店'), 661],
      [typed('1,280', '好鄰居超市永和店'), 1280],
      [screen('732', '好鄰居超市永和店'), 732],
      ['LINE Pay 付款 NT$661 付款完成。商店名稱：好鄰居超市永和店', 661],
      ['LINE Pay 付款 NT$1,280 付款完成。商店名稱: 好鄰居超市永和店', 1280],
      ['LINE Pay 付款 NT$ 1,280 付款完成 商店名稱：好鄰居超市永和店', 1280],
      ['ＬＩＮＥ Ｐａｙ 付款 ＮＴ＄ ６６１ 付款完成。商店名稱：好鄰居超市永和店', 661],
    ] as const) {
      const r = parsed(line(body))
      expect(r, body).toMatchObject({ kind: 'spend', doubt: null, adapter: 'linepay-v1', channel: { label: 'LINE Pay' } })
      if (r.kind === 'spend') expect([r.spend.amount, r.spend.merchant], body).toEqual([amount, '好鄰居超市永和店'])
    }
  })
  it('never takes 1, 16 or 2.8 from the promotion, and a shop name keeps letters, digits and symbols', () => {
    const r = parsed(line(typed('88', '7-ELEVEN 永和No.2店(A棟)')))
    expect(r.kind === 'spend' && [r.spend.amount, r.spend.merchant]).toEqual([88, '7-ELEVEN 永和No.2店(A棟)'])
  })
  it('the shop name keeps its own full-width marks (matched on half-width text, cut from the original)', () => {
    const r = parsed(line(typed('99,999', '全聯福利中心（中和二店）')))
    expect(r.kind === 'spend' && [r.spend.amount, r.spend.merchant]).toEqual([99999, '全聯福利中心（中和二店）'])
    const s = parsed(line('LINE Pay 付款 NT$ 50 付款完成。\r\n商店名稱：\r\n咖啡ＡＢＣ\r\n回饋：1%'))
    expect(s.kind === 'spend' && s.spend.merchant).toBe('咖啡ＡＢＣ')
  })
  it('accepts a line break around the shop name; a name split over two lines is not guessed', () => {
    const r = parsed(line('LINE Pay 付款 NT$ 661 付款完成。\n商店名稱：\n好鄰居超市永和店\n回饋：一般消費回饋 1%'))
    expect(r.kind === 'spend' && r.spend.merchant).toBe('好鄰居超市永和店')
    expect(parsed(line('LINE Pay 付款 NT$ 661 付款完成。商店名稱：好鄰居超市\n永和店')).kind).toBe('unparsed')
  })
  it('cancel / refund / failure words glued to the shop name make it unmatched, never a purchase', () => {
    for (const shop of ['好鄰居超市 此筆交易已取消', '好鄰居超市（退款）', '好鄰居超市 付款失敗', '好鄰居超市 交易未成功']) {
      expect(parsed(line(typed('661', shop))).kind, shop).toBe('unparsed')
    }
  })
  it('a missing shop, a missing amount or a second payment sentence is not imported', () => {
    for (const body of [
      'LINE Pay 付款 NT$661 付款完成。一般消費回饋 1%，最高回饋 16%。',
      'LINE Pay 付款完成。商店名稱：好鄰居超市永和店',
      'LINE Pay 付款 NT$ 661 付款完成。商店名稱：好鄰居超市永和店：回饋：LINE Pay 付款 NT$ 700 付款完成',
      'LINE Pay 付款 NT$ 661 付款完成。商店名稱：NT$ 700',
      'LINE Pay 付款 NT$ 66,1 付款完成。商店名稱：好鄰居超市永和店',
    ]) {
      expect(parsed(line(body)).kind, body).toBe('unparsed')
    }
  })
  it('only a LINE 錢包 notice counts: a chat with the same words, offers, refunds and other apps are not imported', () => {
    // A friend can type anything into a LINE chat; only LINE 錢包 sends it under that title.
    expect(parsed(line(typed('661', '好鄰居超市'), { title: '王小明' })).kind).toBe('unparsed')
    expect(parsed(line('今天午餐 NT$500，記得還我', { title: '王小明' })).kind).toBe('unparsed')
    expect(parsed(line('LINE Pay 限時活動！消費滿 NT$500 享 10% 回饋')).kind).toBe('unparsed')
    expect(parsed(line('LINE Pay 退款 NT$ 661 退款完成。商店名稱：好鄰居超市永和店')).kind).toBe('unparsed')
    expect(parsed(line('LINE Pay 付款 NT$ 661 付款失敗。商店名稱：好鄰居超市永和店')).kind).toBe('unparsed')
    expect(parsed(line('LINE Pay 付款 NT$ 661 已取消。商店名稱：好鄰居超市永和店')).kind).toBe('unparsed')
    expect(parsed(line(typed('661', '好鄰居超市'), { sourceApp: 'Richart Life', title: '刷卡通知' })).kind).toBe('unparsed')
    // An unknown LINE wording says why, in plain words.
    const r = parsed(line('LINE Pay 付款 NT$ 661 付款失敗'))
    expect(r.kind === 'unparsed' && r.reason).toContain('不是 LINE Pay 付款完成的通知')
  })
  it('the user sample shape matches its adapter template directly', () => {
    expect(matchTemplate(line(typed('661', '好鄰居超市永和店')), LINE_PAY_ADAPTER)).toMatchObject({ kind: 'spend', amount: 661, merchant: '好鄰居超市永和店' })
  })
})

describe('A. reading notification files (D-81, D-131)', () => {
  const json = (o: unknown) => JSON.stringify(o)
  const one = (p: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    captureId: 'cap-1',
    sourceApp: 'LINE',
    sourceType: 'notification',
    title: 'LINE錢包',
    subtitle: null,
    body: typed('661', '好鄰居超市永和店'),
    notificationTime: '2026-10-13T10:30:00+08:00',
    capturedAt: '2026-10-13T10:30:00+08:00',
    ...p,
  })
  const file = (name: string, text: string, size = text.length) => ({ name, size, text: async () => text })

  it('one notice, an array, several files; a broken file or notice does not stop the others', async () => {
    const r = await readCaptureFiles([
      file('a.json', json(one())),
      file('b.json', json([one({ captureId: 'cap-2' }), one({ captureId: 'cap-3', title: null, subtitle: null, body: '' }), 'x'])),
      file('c.json', '{not json'),
      file('d.json', json(one({ captureId: 'cap-4', title: 5, body: { x: 1 }, subtitle: '' }))),
    ])
    expect(r.captures.map((c) => c.captureId)).toEqual(['cap-1', 'cap-2'])
    expect(r.errors.join('\n')).toContain('b.json 第 2 則：沒有通知內容')
    expect(r.errors.join('\n')).toContain('b.json 第 3 則：格式不正確')
    expect(r.errors.join('\n')).toContain('c.json：不是 JSON 檔')
    expect(r.errors.join('\n')).toContain('d.json：沒有通知內容')
  })
  it('the ISO time with +08:00 stays the same instant (a late-night purchase stays on its day)', () => {
    const c = readCaptureFile(json(one({ notificationTime: '2026-10-13T23:50:00+08:00' })), 'a.json').captures[0]
    expect(c.notificationTime).toBe(new Date(Date.UTC(2026, 9, 13, 15, 50)).toISOString())
  })
  it('without captureId the id comes from the content: stable, and different for different content', () => {
    const a = readCaptureFile(json(one({ captureId: undefined })), 'a.json').captures[0]
    const b = readCaptureFile(json(one({ captureId: '' })), 'b.json').captures[0]
    const c = readCaptureFile(json(one({ captureId: undefined, body: typed('662', '好鄰居超市永和店') })), 'c.json').captures[0]
    expect(a.derivedId).toBe(true)
    expect(a.captureId).toBe(b.captureId)
    expect(c.captureId).not.toBe(a.captureId)
  })
  it('quotes, newlines and HTML in the text are kept as plain text', () => {
    const body = 'LINE Pay 付款 NT$ 50 付款完成。商店名稱：<b>"阿明"</b>的店\n回饋：1%'
    const c = readCaptureFile(json(one({ body })), 'a.json').captures[0]
    expect(c.body).toBe(body)
    const r = parsed(c)
    expect(r.kind === 'spend' && r.spend.merchant).toBe('<b>"阿明"</b>的店')
  })
  it('a file over 1 MB is refused; more than 300 notices are cut with a message', async () => {
    const big = await readCaptureFiles([file('big.json', '{}', MAX_FILE_BYTES + 1)])
    expect(big.captures).toEqual([])
    expect(big.errors[0]).toContain('檔案太大')
    const many = Array.from({ length: MAX_CAPTURES + 5 }, (_, i) => one({ captureId: `m${i}` }))
    const r = await readCaptureFiles([file('many.json', json(many))])
    expect(r.captures).toHaveLength(MAX_CAPTURES)
    expect(r.errors.join('')).toContain('另外 5 則這次沒有讀')
  })
})

/* ---------------- planning and importing against a real database ---------------- */

let d: MoneyDB
let n = 0
const now = new Date(2026, 9, 13, 20, 0)

beforeEach(async () => {
  d = new MoneyDB(`linepay-${n++}`)
  await d.open()
})
afterEach(() => d.close())

/**
 * LINE Pay holds: 'card' = 台新信用卡; 'debit' = 台新金融卡 (each with a notice type 「LINE Pay」 → that card);
 * 'both' = both, no notice type; 'none' = nothing.
 */
async function setup(bind: 'card' | 'debit' | 'both' | 'none' = 'card') {
  const start = { date: '2026-10-01', amount: 20000 }
  const taishin = (await addPaymentMethod({ name: '台新 Richart', type: 'bank', start }, d, now)).id
  const cathay = (await addPaymentMethod({ name: '國泰世華', type: 'bank', start: { ...start, amount: 5000 } }, d, now)).id
  const tsCard = (await addPaymentMethod({ name: '台新信用卡', type: 'credit_card', payFromId: taishin, start: { ...start, amount: 0 } }, d, now)).id
  const cbCard = (await addPaymentMethod({ name: '國泰信用卡', type: 'credit_card', payFromId: cathay, start: { ...start, amount: 0 } }, d, now)).id
  const debit = (await addPaymentMethod({ name: '台新金融卡', type: 'debit_card', payFromId: taishin }, d, now)).id
  await setStartBalances([{ id: 'easycard', amount: 500 }], '2026-10-01', d, now)
  const cards = { card: [tsCard], debit: [debit], both: [tsCard, debit], none: [] }[bind]
  const linePay = (await addPaymentMethod({ name: 'LINE Pay', type: 'mobile', cards }, d, now)).id
  if (bind === 'card' || bind === 'debit') await saveNoticeType({ name: 'LINE Pay', keywords: ['LINE Pay'], paymentMethodId: linePay, cardId: cards[0] }, d)
  return { taishin, cathay, tsCard, cbCard, debit, linePay }
}

async function plan(captures: NotificationCapture[]) {
  const known = await d.importedNotifications.toArray()
  return planImport({
    captures,
    knownCaptureIds: new Map(known.map((k) => [k.captureId, k.fingerprint])),
    transactions: await d.transactions.toArray(),
    paymentMethods: await d.paymentMethods.toArray(),
    categories: DEFAULT_CATEGORIES,
    history: [],
    defaultCards: {},
    noticeMethods: await getNoticeMethods(d),
    noticeTypes: await getNoticeTypes(d),
    now,
  })
}

const balances = async () => {
  const all = await readAllData(d)
  return computeBalances(all.paymentMethods, all.transactions, all.adjustments)
}

describe('C. where the money came from (D-130)', () => {
  it('spec §16: LINE Pay bound to 台新信用卡 → one NT$661 expense, the card owes 661, no bank moves', async () => {
    const a = await setup('card')
    const rows = await plan([line(typed('661', '好鄰居超市永和店'), { captureId: 'lp1' })])
    expect(rows[0]).toMatchObject({ status: 'new', include: true, channel: 'LINE Pay', paymentMethodId: a.linePay, source: { cardId: a.tsCard }, sourceIsDefault: true })
    const s = await commitNotificationImport(rows, { files: 1 }, d, now)
    expect(s.imported).toBe(1)
    const [t] = await d.transactions.toArray()
    expect(t).toMatchObject({ type: 'expense', amount: 661, merchant: '好鄰居超市永和店', paymentMethodId: a.linePay, cardId: a.tsCard, source: 'notification', externalId: 'lp1', timeSource: 'notification' })
    expect(t.sourceAccountId).toBeUndefined()
    const b = await balances()
    expect([b.get(a.tsCard), b.get(a.taishin), b.get(a.cathay)]).toEqual([661, 20000, 5000])
    expect(summarize(await d.transactions.toArray()).expense).toBe(661)
    expect(await d.importedNotifications.where('captureId').equals('lp1').first()).toMatchObject({ status: 'imported', sourceConfirmed: true, body: typed('661', '好鄰居超市永和店') })
    // The same file again adds nothing.
    const again = await plan([line(typed('661', '好鄰居超市永和店'), { captureId: 'lp1' })])
    expect(again[0].status).toBe('duplicate')
    await commitNotificationImport(again, { files: 1 }, d, now)
    expect(await d.transactions.count()).toBe(1)
  })
  it('LINE Pay holding the debit card: the bank goes down at once; never both a card and an account', async () => {
    const a = await setup('debit')
    const rows = await plan([line(typed('120', '早餐店'))])
    expect(rows[0]).toMatchObject({ status: 'new', source: { cardId: a.debit }, sourceIsDefault: true })
    await commitNotificationImport(rows, { files: 1 }, d, now)
    const [t] = await d.transactions.toArray()
    expect(t).toMatchObject({ paymentMethodId: a.linePay, cardId: a.debit })
    expect(t.sourceAccountId).toBeUndefined()
    const b = await balances()
    expect([b.get(a.taishin), b.get(a.tsCard)]).toEqual([20000 - 120, 0])
  })
  it('D-136 / Q121: no notice type matched → the row asks which card; no card is guessed', async () => {
    const a = await setup('both')
    const [r] = await plan([line(typed('80', '飲料店'))])
    expect(r).toMatchObject({ status: 'suspect', include: false, needsSource: true, source: null, autoSource: null, paymentMethodId: a.linePay, reason: '' })
    expect(r.sourceNote).toBe('沒有符合的通知類型，請選這筆用哪張卡')
  })
  it('D-136 / Q113 A: every keyword of a type must be in the notice (title too, any width or case)', async () => {
    const a = await setup('both')
    await saveNoticeType({ name: '飲料', keywords: ['ｌｉｎｅ錢包', '飲料'], paymentMethodId: a.linePay, cardId: a.debit }, d)
    const rows = await plan([line(typed('80', '飲料店')), line(typed('90', '書店'), { captureId: 'b' })])
    expect(rows[0]).toMatchObject({ status: 'new', include: true, source: { cardId: a.debit }, autoSource: { cardId: a.debit }, autoMethodId: a.linePay, sourceIsDefault: true, typeNames: ['飲料'], sourceNote: '' })
    // Only one of the two keywords: not this type.
    expect(rows[1]).toMatchObject({ status: 'suspect', source: null, typeNames: [] })
    await commitNotificationImport(rows.slice(0, 1), { files: 1 }, d, now)
    const b = await balances()
    expect([b.get(a.taishin), b.get(a.tsCard)]).toEqual([20000 - 80, 0])
  })
  it('Q120 A: a type whose keywords include another one\'s wins; types for different cards otherwise leave it to the user', async () => {
    const a = await setup('both')
    await saveNoticeType({ name: 'LINE Pay', keywords: ['LINE Pay'], paymentMethodId: a.linePay, cardId: a.tsCard }, d)
    await saveNoticeType({ name: '全聯', keywords: ['LINE Pay', '全聯'], paymentMethodId: a.linePay, cardId: a.debit }, d)
    await saveNoticeType({ name: '書店', keywords: ['書店'], paymentMethodId: a.linePay, cardId: a.tsCard }, d)
    const [pxmart, other, both, sameCard] = await plan([
      line(typed('80', '全聯福利中心')),
      line(typed('70', '麵店'), { captureId: 'o' }),
      line(typed('60', '全聯書店'), { captureId: 'x' }),
      line(typed('50', '二手書店'), { captureId: 'y' }),
    ])
    expect(pxmart).toMatchObject({ status: 'new', source: { cardId: a.debit }, typeNames: ['全聯'] })
    expect(other).toMatchObject({ status: 'new', source: { cardId: a.tsCard }, typeNames: ['LINE Pay'] })
    // 全聯 (debit) and 書店 (credit) both match and neither includes the other.
    expect(both).toMatchObject({ status: 'suspect', include: false, source: null, typeNames: ['全聯', '書店'] })
    expect(both.sourceNote).toBe('同時符合「全聯」「書店」兩種通知，請選這筆用哪張卡')
    // 「LINE Pay」 and 「書店」 both match but record to the same card: no question.
    expect(sameCard).toMatchObject({ status: 'new', source: { cardId: a.tsCard }, typeNames: ['LINE Pay', '書店'] })
  })
  it('Q127 A: a type whose card was disabled or unbound stays, and its notices ask which card', async () => {
    const a = await setup('both')
    await saveNoticeType({ name: '金融卡', keywords: ['LINE Pay'], paymentMethodId: a.linePay, cardId: a.debit }, d)
    await updatePaymentMethod(a.debit, { isActive: false }, d, now)
    const [r] = await plan([line(typed('60', '麵店'))])
    expect(r).toMatchObject({ status: 'suspect', source: null, typeNames: ['金融卡'] })
    expect(r.sourceNote).toBe('符合「金融卡」，但「台新金融卡」已刪除，請選這筆用哪張卡')
    await updatePaymentMethod(a.debit, { isActive: true }, d, now)
    await updatePaymentMethod(a.linePay, { cards: [a.tsCard] }, d, now)
    expect((await plan([line(typed('60', '麵店'))]))[0].sourceNote).toBe('符合「金融卡」，但「台新金融卡」已不在「LINE Pay」底下，請選這筆用哪張卡')
    expect(await getNoticeTypes(d)).toHaveLength(1)
  })
  it('Q119 A: a type can record under another 行動支付; LINE Pay notices are not linked to it', async () => {
    const a = await setup('both')
    const apple = (await addPaymentMethod({ name: 'Apple Pay', type: 'mobile', cards: [a.cbCard] }, d, now)).id
    await saveNoticeType({ name: '國泰', keywords: ['LINE Pay'], paymentMethodId: apple, cardId: a.cbCard }, d)
    const rows = await plan([line(typed('45', '豆漿店'))])
    expect(rows[0]).toMatchObject({ status: 'new', paymentMethodId: apple, autoMethodId: apple, channelMethodId: a.linePay, source: { cardId: a.cbCard } })
    await commitNotificationImport(rows, { files: 1 }, d, now)
    expect((await d.transactions.toArray())[0]).toMatchObject({ paymentMethodId: apple, cardId: a.cbCard })
    expect((await balances()).get(a.cbCard)).toBe(45)
    expect(await getNoticeMethods(d)).toEqual({})
  })
  it('D-135: LINE Pay notices remember their payment method by id, so renaming it keeps the link', async () => {
    const a = await setup('card')
    expect(await getNoticeMethods(d)).toEqual({})
    await commitNotificationImport(await plan([line(typed('80', '飲料店'), { captureId: 'n1' })]), { files: 1 }, d, now)
    expect(await getNoticeMethods(d)).toEqual({ linepay: a.linePay })
    await updatePaymentMethod(a.linePay, { name: '我的手機錢包' }, d, now)
    const [r] = await plan([line(typed('90', '豆花店'), { captureId: 'n2' })])
    expect(r).toMatchObject({ status: 'new', paymentMethodId: a.linePay, source: { cardId: a.tsCard } })
    await commitNotificationImport([r], { files: 1 }, d, now)
    expect((await d.paymentMethods.toArray()).filter((p) => p.type === 'mobile' && /line/i.test(p.name))).toHaveLength(0)
    expect((await d.transactions.toArray()).every((t) => t.paymentMethodId === a.linePay)).toBe(true)
    // Disabled: an active one named LINE Pay takes the notices; the type pointing at the disabled one asks.
    await updatePaymentMethod(a.linePay, { isActive: false }, d, now)
    const fresh = (await addPaymentMethod({ name: 'LINE Pay', type: 'mobile', cards: [a.debit] }, d, now)).id
    const [off] = await plan([line(typed('70', '早餐店'), { captureId: 'n3' })])
    expect(off).toMatchObject({ status: 'suspect', paymentMethodId: fresh, source: null })
    expect(off.sourceNote).toContain('「我的手機錢包」已刪除')
  })
  it('no binding: amount and shop are kept, the row asks for a source and cannot be imported without one', async () => {
    const a = await setup('none')
    const rows = await plan([line(typed('661', '好鄰居超市永和店'))])
    expect(rows[0]).toMatchObject({ status: 'suspect', include: false, needsSource: true, source: null, amount: 661, merchant: '好鄰居超市永和店' })
    expect(rows[0].sourceNote).toBe('沒有符合的通知類型，請選這筆用哪張卡')
    // Ticked without a source: refused, nothing written (a retry later works).
    await expect(commitNotificationImport([{ ...rows[0], include: true }], { files: 1 }, d, now)).rejects.toThrow('付款來源')
    expect(await d.transactions.count()).toBe(0)
    expect(await d.importedNotifications.count()).toBe(0)
    // Chosen in the preview: the debit card takes it straight from 台新.
    const chosen: PlanRow = { ...rows[0], include: true, status: 'new', needsSource: false, source: { cardId: a.debit } }
    await commitNotificationImport([chosen], { files: 1 }, d, now)
    const [t] = await d.transactions.toArray()
    expect(t).toMatchObject({ paymentMethodId: a.linePay, cardId: a.debit })
    expect((await balances()).get(a.taishin)).toBe(20000 - 661)
    // The cards LINE Pay holds are not changed by a choice in the preview (Q94).
    expect((await d.paymentMethods.get(a.linePay))!.cards).toBeUndefined()
  })
  it('a row switched to another card in the preview goes to that card only', async () => {
    const a = await setup('card')
    const rows = await plan([line(typed('300', '書店'))])
    await commitNotificationImport([{ ...rows[0], source: { cardId: a.cbCard }, sourceIsDefault: false }], { files: 1 }, d, now)
    const b = await balances()
    expect([b.get(a.cbCard), b.get(a.tsCard)]).toEqual([300, 0])
    expect((await d.paymentMethods.get(a.linePay))!.cards).toEqual([a.tsCard])
  })
  it('an amount the app cannot record is listed as 不匯入 instead of breaking the whole import', async () => {
    await setup('card')
    const rows = await plan([line(typed('99999999999999', '好鄰居超市'), { captureId: 'huge' }), line(typed('50', '豆漿店'), { captureId: 'ok' })])
    expect(rows.map((r) => r.status)).toEqual(['unparsed', 'new'])
    expect(rows[0].reason).toContain('超出可以記錄的範圍')
    expect((await commitNotificationImport(rows, { files: 1 }, d, now)).imported).toBe(1)
  })
  it('a debit card payment must name its bank account', async () => {
    const a = await setup('card')
    const base: TxInput = { type: 'expense', amount: 100, merchant: '', categoryId: 'food', paymentMethodId: a.debit, date: '2026-10-13', time: '12:00', note: '' }
    await expect(addTransaction(base, d, now)).rejects.toThrow('金融卡要從它所屬的銀行帳戶扣款')
    await expect(addTransaction({ ...base, sourceAccountId: a.cathay }, d, now)).rejects.toThrow('只能從它所屬的銀行帳戶')
    await addTransaction({ ...base, sourceAccountId: a.taishin }, d, now)
    expect((await balances()).get(a.taishin)).toBe(19900)
  })
  it('a source that is not a card or an account is refused', async () => {
    const a = await setup('card')
    const rows = await plan([line(typed('300', '書店'))])
    await expect(commitNotificationImport([{ ...rows[0], source: { cardId: a.taishin } }], { files: 1 }, d, now)).rejects.toThrow('付款來源')
    await expect(commitNotificationImport([{ ...rows[0], source: { sourceAccountId: a.tsCard } }], { files: 1 }, d, now)).rejects.toThrow('付款來源')
  })
  it('without a LINE Pay payment method yet, the first import creates one (unbound) and files the record under it', async () => {
    const a = await setup('none')
    await updatePaymentMethod(a.linePay, { name: '舊的行動支付' }, d, now)
    const rows = await plan([line(typed('80', '飲料店'))])
    expect(rows[0]).toMatchObject({ paymentMethodId: null, needsSource: true })
    await commitNotificationImport([{ ...rows[0], include: true, source: { cardId: a.tsCard } }], { files: 1 }, d, now)
    const created = (await d.paymentMethods.toArray()).filter((p) => p.name === 'LINE Pay')
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ type: 'mobile', isActive: true })
    expect((await d.transactions.toArray())[0].paymentMethodId).toBe(created[0].id)
    expect(rows[0].sourceNote).toBe('沒有符合的通知類型，請選這筆用哪張卡')
    expect(await getNoticeMethods(d)).toEqual({ linepay: created[0].id })
  })
})

describe('notice types (D-136)', () => {
  it('saving: a name, 1–5 keywords of up to 10 characters no other type has, at most 10 types, a card it can use', async () => {
    const a = await setup('both')
    const base = { name: 'X', keywords: ['LINE Pay'], paymentMethodId: a.linePay, cardId: a.tsCard }
    await expect(saveNoticeType({ ...base, name: ' ' }, d)).rejects.toThrow('請輸入名稱')
    await expect(saveNoticeType({ ...base, name: '一二三四五六七八九十一二三' }, d)).rejects.toThrow('名稱最多 12 個字')
    await expect(saveNoticeType({ ...base, keywords: [] }, d)).rejects.toThrow('至少要有一個關鍵字')
    await expect(saveNoticeType({ ...base, keywords: ['a', 'b', 'c', 'd', 'e', 'f'] }, d)).rejects.toThrow('關鍵字最多 5 個')
    await expect(saveNoticeType({ ...base, keywords: ['LINE Pay', ' '] }, d)).rejects.toThrow('關鍵字不能空白')
    await expect(saveNoticeType({ ...base, keywords: ['一二三四五六七八九十一'] }, d)).rejects.toThrow('關鍵字最多 10 個字')
    await expect(saveNoticeType({ ...base, keywords: ['全聯', 'line pay', 'ＬＩＮＥ ＰＡＹ'] }, d)).rejects.toThrow('「ＬＩＮＥ ＰＡＹ」重複了')
    // The card must be one this 行動支付 holds, and both must be usable.
    await expect(saveNoticeType({ ...base, cardId: a.cbCard }, d)).rejects.toThrow('請重新選擇記到哪張卡')
    await expect(saveNoticeType({ ...base, paymentMethodId: a.tsCard }, d)).rejects.toThrow('請重新選擇記到哪張卡')
    const first = await saveNoticeType({ ...base, name: ' X ', keywords: [' LINE Pay '] }, d)
    expect(first).toMatchObject({ name: 'X', keywords: ['LINE Pay'] })
    // The keywords tell the types apart, in any order, width or case (Q120 A).
    await expect(saveNoticeType({ ...base, name: 'Y', keywords: ['line pay'] }, d)).rejects.toThrow('「X」已經用了一樣的關鍵字')
    await saveNoticeType({ ...base, name: 'Y', keywords: ['全聯', 'LINE Pay'] }, d)
    await expect(saveNoticeType({ ...base, name: 'Z', keywords: ['ｌｉｎｅ ｐａｙ', '全聯'] }, d)).rejects.toThrow('「Y」已經用了一樣的關鍵字')
    // Editing keeps its place; its own keywords are no clash.
    await saveNoticeType({ ...first, name: 'X2' }, d)
    expect((await getNoticeTypes(d)).map((t) => t.name)).toEqual(['X2', 'Y'])
    for (let i = 0; i < 8; i++) await saveNoticeType({ ...base, name: `T${i}`, keywords: [`k${i}`] }, d)
    await expect(saveNoticeType({ ...base, name: 'T9', keywords: ['k9'] }, d)).rejects.toThrow('通知類型最多 10 個')
    await deleteNoticeType(first.id, d)
    expect(await getNoticeTypes(d)).toHaveLength(9)
    await expect(saveNoticeType({ ...first, name: 'X3' }, d)).rejects.toThrow('已經不存在')
  })
  it('notice types go with a full backup; a damaged one is left out, one pointing nowhere stays', async () => {
    const a = await setup('card')
    const file = JSON.parse(JSON.stringify(buildBackup(await readAllData(d), now)))
    const saved = file.settings.find((s: { key: string }) => s.key === 'noticeTypes')
    expect(saved.value).toHaveLength(1)
    saved.value.push(
      { id: 'bad' },
      { id: 'dup', name: '重複', keywords: ['line pay'], paymentMethodId: a.linePay, cardId: a.tsCard },
      { id: 'gone', name: '舊卡', keywords: [' 全聯 ', 'x'.repeat(11)], paymentMethodId: 'nope', cardId: 'nope' },
    )
    const parsed = parseBackup(JSON.stringify(file))
    const types = parsed.settings.find((s) => s.key === 'noticeTypes')!.value as NoticeType[]
    expect(types.map((t) => [t.id, t.keywords])).toEqual([
      [saved.value[0].id, ['LINE Pay']],
      ['gone', ['全聯']],
    ])
    const other = new MoneyDB(`linepay-other-${n++}`)
    await other.open()
    await restoreBackup(parsed, other, now)
    expect((await getNoticeTypes(other)).map((t) => t.name)).toEqual(['LINE Pay', '舊卡'])
    other.close()
  })
})

describe('D. duplicates (Q97, D-131)', () => {
  it('the same notice in two different files is imported once', async () => {
    await setup('card')
    const c = line(typed('661', '好鄰居超市永和店'), { captureId: 'same' })
    const rows = await plan([c, { ...c, fileName: 'copy.json' }])
    expect(rows.map((r) => r.status)).toEqual(['new', 'duplicate'])
    await commitNotificationImport(rows, { files: 2 }, d, now)
    expect(await d.transactions.count()).toBe(1)
  })
  it('a manual record of the same amount on the same day is flagged, not imported by default', async () => {
    const a = await setup('card')
    const input: TxInput = { type: 'expense', amount: 150, merchant: '午餐', categoryId: 'food', paymentMethodId: 'cash', date: '2026-10-13', time: '12:00', note: '' }
    await addTransaction(input, d, now)
    const rows = await plan([line(typed('150', '便當店'), { notificationTime: new Date(2026, 9, 13, 12, 10).toISOString() })])
    expect(rows[0]).toMatchObject({ status: 'suspect', include: false, duplicate: true, source: { cardId: a.tsCard } })
    expect(rows[0].reason).toContain('可能與 10/13 的既有交易「午餐」重複')
  })
  it('two purchases at the same shop the same day: different amounts are both new; the same amount is flagged', async () => {
    await setup('card')
    const rows = await plan([
      line(typed('45', '咖啡店'), { captureId: 'a' }),
      line(typed('60', '咖啡店'), { captureId: 'b' }),
      line(typed('45', '咖啡店'), { captureId: 'c' }),
    ])
    expect(rows.map((r) => [r.status, r.include])).toEqual([
      ['new', true],
      ['new', true],
      ['suspect', false],
    ])
    expect(rows[2].reason).toContain('同一天、同金額')
  })
  it('the same id with different content is a conflict (check the shortcut), never silently skipped or overwritten', async () => {
    await setup('card')
    const first = line(typed('661', '好鄰居超市永和店'), { captureId: 'dup-id' })
    await commitNotificationImport(await plan([first]), { files: 1 }, d, now)
    const other = line(typed('99', '別家店'), { captureId: 'dup-id' })
    const rows = await plan([other])
    expect(rows[0].status).toBe('unparsed')
    expect(rows[0].reason).toContain('編號和另一則已處理的通知相同，但內容不同')
    await commitNotificationImport(rows, { files: 1 }, d, now)
    expect((await d.transactions.toArray()).map((t) => t.amount)).toEqual([661])
    // Within one batch too.
    const b = await plan([line(typed('1', 'x'), { captureId: 'z' }), line(typed('2', 'y'), { captureId: 'z' })])
    expect(b.map((r) => r.status)).toEqual(['new', 'unparsed'])
  })
  it('after a full backup and restore, the same notice is still known (no second record)', async () => {
    await setup('card')
    const c = line(typed('661', '好鄰居超市永和店'), { captureId: 'kept' })
    await commitNotificationImport(await plan([c]), { files: 1 }, d, now)
    const file = parseBackup(JSON.stringify(buildBackup(await readAllData(d), now)))
    const other = new MoneyDB(`linepay-other-${n++}`)
    await other.open()
    await restoreBackup(file, other, now)
    d.close()
    d = other
    const rows = await plan([c])
    expect(rows[0].status).toBe('duplicate')
    expect((await d.transactions.toArray())[0]).toMatchObject({ amount: 661, cardId: expect.any(String) })
  })
})

describe('privacy: what is kept of notices that are not imported (D-131)', () => {
  it('only an imported notice keeps its text; the rest keep the id, the outcome and a fingerprint', async () => {
    await setup('card')
    const chat = line('今天午餐 NT$500，記得還我', { title: '王小明', captureId: 'chat' })
    const pay = line(typed('661', '好鄰居超市永和店'), { captureId: 'pay' })
    await commitNotificationImport(await plan([chat, pay]), { files: 1 }, d, now)
    const kept = await d.importedNotifications.where('captureId').equals('chat').first()
    expect(kept).toMatchObject({ status: 'unparsed', title: null, subtitle: null, body: null, fingerprint: chat.fingerprint })
    expect((await d.importedNotifications.where('captureId').equals('pay').first())!.body).toContain('付款完成')
    // A backup holds no chat text either, and an older backup with text is cleaned when read.
    const raw = JSON.parse(JSON.stringify(buildBackup(await readAllData(d), now)))
    expect(JSON.stringify(raw)).not.toContain('記得還我')
    raw.importedNotifications.find((x: { captureId: string }) => x.captureId === 'chat').body = '舊備份裡的私人訊息'
    delete raw.importedNotifications.find((x: { captureId: string }) => x.captureId === 'chat').fingerprint
    const back = parseBackup(JSON.stringify(raw))
    const restored = back.importedNotifications.find((x) => x.captureId === 'chat')!
    expect(restored.body).toBeNull()
    expect(restored.fingerprint).toMatch(/^[0-9a-f]{14}$/)
  })
  it('upgrading to database version 6 clears stored text of notices that were not imported, keeping fingerprints', async () => {
    const name = `linepay-up-${n++}`
    const old = new Dexie(name)
    old.version(1).stores({ transactions: 'id, occurredAt, type, categoryId, paymentMethodId, [source+externalId]', categories: 'id, type', paymentMethods: 'id', settings: 'key' })
    old.version(2).stores({ salaryItems: 'id, kind', payslips: 'id, &month, payDate' })
    old.version(3).stores({ importedNotifications: 'id, &captureId, batchId, transactionId', importBatches: 'id, createdAt', cardStatements: 'id, paymentMethodId, &fileHash, statementMonth', statementEntries: 'id, statementId', reconciliations: 'id, statementId, entryId, transactionId' })
    old.version(4).stores({ monthlyPlans: 'month', planTemplates: 'id', plannedExpenses: 'id, month, &[month+templateId], transactionId' })
    old.version(5).stores({ transactions: 'id, occurredAt, type, categoryId, paymentMethodId, toAccountId, sourceAccountId, feeOf, [source+externalId]', adjustments: 'id, accountId, occurredAt' })
    await old.open()
    const rec = (captureId: string, status: string, body: string) => ({ id: captureId, captureId, sourceApp: 'LINE', sourceType: 'notification', title: 'X', subtitle: null, body, notificationTime: null, capturedAt: null, status, parsed: null, transactionId: null, batchId: 'b', importedAt: now.toISOString() })
    await old.table('importedNotifications').bulkAdd([rec('kept', 'imported', '付款完成'), rec('chat', 'unparsed', '私人訊息'), rec('ad', 'not_spending', '優惠')])
    old.close()
    const up = new MoneyDB(name)
    await up.open()
    const all = await up.importedNotifications.toArray()
    expect(all.find((x) => x.captureId === 'kept')).toMatchObject({ title: 'X', body: '付款完成' })
    for (const id of ['chat', 'ad']) expect(all.find((x) => x.captureId === id)).toMatchObject({ title: null, subtitle: null, body: null })
    expect(all.every((x) => /^[0-9a-f]{14}$/.test(x.fingerprint ?? ''))).toBe(true)
    up.close()
  })
})
