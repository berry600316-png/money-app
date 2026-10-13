import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES } from '../db/defaults'
import type { CardStatement, PaymentMethod, Reconciliation, StatementEntry, Transaction } from '../db/types'
import { suggestCategory } from './categorize'
import { capture, SIM_NOTIFICATION_ADAPTER, SIM_NOTIFICATIONS, SIM_STATEMENT_LINES } from './fixtures'
import { planImport } from './importPlan'
import { readCaptureFile, readTime } from './notificationFile'
import { parseNotification } from './notificationParser'
import { reconcile } from './reconcile'
import { purchaseTime } from './purchaseTime'
import type { StatementAdapter } from './statementAdapters'
import { GENERIC_STATEMENT_WARNING, parseStatement, parseStatementLines } from './statementParser'
import { findDates, findLast4, merchantSimilarity, normalizeMerchant, parseAmount } from './text'

describe('text helpers', () => {
  it('reads NTD amounts in common forms', () => {
    expect(parseAmount('NT$1,234')).toBe(1234)
    expect(parseAmount('新臺幣 85 元')).toBe(85)
    expect(parseAmount('ＴＷＤ１２３')).toBe(123)
    expect(parseAmount('1,234.00')).toBe(1234)
    expect(parseAmount('無')).toBeNull()
  })
  it('reads dates incl. ROC years and month/day with a year hint', () => {
    expect(findDates('2026/10/05 與 115/10/06')).toEqual(['2026-10-05', '2026-10-06'])
    expect(findDates('2026年10月7日')).toEqual(['2026-10-07'])
    expect(findDates('10/11 14:05', 2026)).toEqual(['2026-10-11'])
    expect(findDates('10月5日', 2026)).toEqual(['2026-10-05'])
    expect(findDates('10月5日')).toEqual([])
    expect(findDates('2026/02/31')).toEqual([])
  })
  it('finds last four digits', () => {
    expect(findLast4('末四碼1234')).toBe('1234')
    expect(findLast4('卡號 ****-5678')).toBe('5678')
    expect(findLast4('沒有卡號')).toBeNull()
  })
  it('normalises merchant names and aliases', () => {
    expect(normalizeMerchant('統一超商股份有限公司')).toBe(normalizeMerchant('7-ELEVEN'))
    expect(normalizeMerchant('UBER *EATS')).toBe('ubereats')
    expect(merchantSimilarity('全家便利商店台北店', 'FamilyMart')).toBe(1)
    expect(merchantSimilarity('UNIQLO 站前店', 'UNIQLO')).toBeGreaterThanOrEqual(0.5)
    expect(merchantSimilarity('NETFLIX.COM', '全聯')).toBeLessThan(0.5)
  })
})

describe('notification files (D-81)', () => {
  it('reads one object or an array, derives an id when missing', () => {
    const one = readCaptureFile(JSON.stringify({ schemaVersion: 1, captureId: 'a', sourceApp: 'Richart Life', body: 'x' }), 'a.json')
    expect(one.captures).toHaveLength(1)
    const many = readCaptureFile(JSON.stringify([{ body: 'x' }, { body: 'x' }, { title: '' }]), 'b.json')
    expect(many.captures).toHaveLength(2)
    expect(many.captures[0].derivedId).toBe(true)
    expect(many.captures[0].captureId).toBe(many.captures[1].captureId) // same content → same id
    expect(many.errors).toHaveLength(1)
    expect(readCaptureFile('not json', 'c.json').errors[0]).toContain('不是 JSON')
    expect(readCaptureFile(JSON.stringify({ schemaVersion: 9, body: 'x' }), 'd.json').errors[0]).toContain('版本')
  })
  it('accepts ISO or localized times', () => {
    expect(readTime('2026-10-11T06:05:00.000Z')).toBe('2026-10-11T06:05:00.000Z')
    expect(new Date(readTime('2026年10月11日 下午2:05')!).getHours()).toBe(14)
    expect(readTime('')).toBeNull()
  })
})

describe('sample files in docs/samples/notifications stay importable', () => {
  const files = import.meta.glob('../../docs/samples/notifications/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
  it('every sample parses, and purchases are recognised', () => {
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(4)
    const kinds: string[] = []
    for (const [path, text] of Object.entries(files)) {
      const r = readCaptureFile(text, path)
      expect(r.errors).toEqual([])
      for (const c of r.captures) kinds.push(parseNotification(c, undefined, { generic: true }).kind)
    }
    expect(kinds.filter((k) => k === 'spend')).toHaveLength(4)
    expect(kinds.filter((k) => k === 'not_spending')).toHaveLength(1)
  })
})

describe('bank adapters (D-97)', () => {
  const sim = (body: string, sourceApp = 'Richart Life') => parseNotification(capture({ body, sourceApp }), [SIM_NOTIFICATION_ADAPTER], { generic: true })
  it('a notification matching a bank template is trusted: no doubt, bank known', () => {
    const r = sim(SIM_NOTIFICATIONS.convenience)
    expect(r).toMatchObject({ kind: 'spend', adapter: 'sim-v1', bank: '台新', doubt: null })
    if (r.kind !== 'spend') return
    expect(r.spend).toMatchObject({ amount: 85, merchant: '全家便利商店', cardLast4: '1234' })
    const d = new Date(r.spend.occurredAt!)
    expect([d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]).toEqual([10, 11, 14, 5])
    expect(sim(SIM_NOTIFICATIONS.clothing)).toMatchObject({ kind: 'spend', doubt: null, spend: { amount: 1280, merchant: 'UNIQLO 台北站前店', cardLast4: '5678' } })
    expect(sim(SIM_NOTIFICATIONS.refund)).toMatchObject({ kind: 'not_spending', reason: '退款通知' })
  })
  it('the same app with unknown wording falls back to a guess the user must confirm', () => {
    const r = sim('於10/11 14:05在全家消費NT$85')
    expect(r).toMatchObject({ kind: 'spend', adapter: 'generic', bank: '台新' })
    expect(r.kind === 'spend' && r.doubt).toContain('寫法和已建立的格式不同')
  })
  it('an app without an adapter is always a guess the user must confirm', () => {
    const r = sim(SIM_NOTIFICATIONS.convenience, '某銀行 App')
    expect(r).toMatchObject({ kind: 'spend', adapter: 'generic', bank: null })
    expect(r.kind === 'spend' && r.doubt).toContain('還沒建立「某銀行 App」的通知格式')
  })
  it('with the generic reader on, an app without an adapter is a guess the user must confirm', () => {
    const r = parseNotification(capture({ body: SIM_NOTIFICATIONS.convenience }), undefined, { generic: true })
    expect(r.kind === 'spend' && r.doubt).toContain('還沒建立')
  })
  it('D-128: in production (generic reader off) a bank notice is never guessed: it is not imported', () => {
    const r = parseNotification(capture({ body: SIM_NOTIFICATIONS.convenience }))
    expect(r).toMatchObject({ kind: 'unparsed' })
    expect(r.kind === 'unparsed' && r.reason).toContain('目前只會匯入 LINE Pay 付款通知')
  })
  it('statements: a bank adapter is used when it recognises the layout; otherwise the generic reader says so', () => {
    const fake: StatementAdapter = {
      id: 'fake-v1',
      bank: '測試銀行',
      detect: (lines) => lines.some((l) => l.includes('測試銀行信用卡帳單')),
      parse: (lines) => ({ ...parseStatementLines(lines), adapter: 'x', bank: '測試銀行', warnings: [] }),
    }
    const mine = parseStatement(['測試銀行信用卡帳單', ...SIM_STATEMENT_LINES], [fake])
    expect(mine).toMatchObject({ adapter: 'fake-v1', bank: '測試銀行' })
    expect(mine.warnings).not.toContain(GENERIC_STATEMENT_WARNING)
    const other = parseStatement(SIM_STATEMENT_LINES, [fake])
    expect(other.adapter).toBe('generic')
    expect(other.warnings[0]).toBe(GENERIC_STATEMENT_WARNING)
  })
})

describe('generic notification rules (no bank adapter: always confirmed by the user)', () => {
  const p = (body: string) => parseNotification(capture({ body }), undefined, { generic: true })
  it('reads a purchase with merchant, amount, time and card', () => {
    const r = p(SIM_NOTIFICATIONS.convenience)
    expect(r.kind).toBe('spend')
    if (r.kind !== 'spend') return
    expect(r.spend).toMatchObject({ amount: 85, merchant: '全家便利商店', cardLast4: '1234' })
    const d = new Date(r.spend.occurredAt!)
    expect([d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]).toEqual([10, 11, 14, 5])
  })
  it('reads "商店：" style', () => {
    const r = p(SIM_NOTIFICATIONS.clothing)
    expect(r.kind === 'spend' && r.spend).toMatchObject({ amount: 1280, merchant: 'UNIQLO 台北站前店', cardLast4: '5678' })
  })
  it('recognises non-purchases and unreadable ones', () => {
    expect(p(SIM_NOTIFICATIONS.refund)).toMatchObject({ kind: 'not_spending', reason: '退款通知' })
    expect(p(SIM_NOTIFICATIONS.payment)).toMatchObject({ kind: 'not_spending', reason: '繳款通知' })
    expect(p(SIM_NOTIFICATIONS.otp)).toMatchObject({ kind: 'not_spending' })
    expect(p(SIM_NOTIFICATIONS.promo)).toMatchObject({ kind: 'not_spending' })
    expect(p(SIM_NOTIFICATIONS.foreign)).toMatchObject({ kind: 'unparsed' })
    expect(p(SIM_NOTIFICATIONS.noAmount)).toMatchObject({ kind: 'unparsed' })
    expect(p('刷卡消費滿 NT$3,000 享 5% 回饋')).toMatchObject({ kind: 'not_spending' })
    const notAuto = (body: string) => {
      const r = p(body)
      return r.kind !== 'spend' || r.doubt !== null
    }
    expect(notAuto('交易驗證碼 889900，本次消費 NT$500，請勿告知他人')).toBe(true)
    expect(p('即日起刷卡享 5% 回饋，登錄抽 iPhone')).toMatchObject({ kind: 'not_spending' })
    expect(notAuto('於全家消費 NT$50 以上即享 5% 回饋')).toBe(true)
    expect(notAuto('本月累積消費 NT$5,000，再刷 NT$1,000 即享回饋')).toBe(true)
  })
  it('offers that state an amount are never silently imported (adversarial set, round 3)', () => {
    const offers = [
      '即日起刷卡消費 NT$3,000 享 5% 回饋',
      '週末刷卡消費滿額 NT$2,000，回饋 NT$200',
      '台新卡友限定：於 蝦皮 消費 NT$500 送 50 元購物金',
      '單筆消費 NT$1,000 即可參加抽獎',
      '刷卡 NT$999 享 6 期 0 利率',
    ]
    for (const body of offers) {
      const r = p(body)
      // Either recognised as not a purchase / unreadable, or a purchase the user must confirm.
      expect(r.kind !== 'spend' || r.doubt !== null, body).toBe(true)
    }
  })
  it('shops named like codes and phone numbers after 驗證碼 do not hide a purchase', () => {
    const r1 = p('您的台新卡在 OTP2024 選物店 消費 NT$450')
    expect(r1.kind === 'spend' && r1.spend.amount).toBe(450)
    const r2 = p('您的台新卡在 全家 消費 NT$85，本行不會索取驗證碼 0800-123-456')
    expect(r2.kind === 'spend' && r2.spend.amount).toBe(85)
    expect(p('3D 驗證 OTP：556677')).toMatchObject({ kind: 'not_spending' })
    expect(p('動態密碼是 889900')).toMatchObject({ kind: 'not_spending' })
  })
  it('generic guesses always carry a reason to confirm (D-96, D-97)', () => {
    const full = p('您的台新卡末四碼1234於10/11 14:05在全家便利商店消費新臺幣85元，本筆享 1% 回饋')
    expect(full.kind === 'spend' && full.doubt).toContain('請確認')
    const noShape = p('您的台新卡消費 NT$85')
    expect(noShape.kind === 'spend' && noShape.doubt).toContain('缺少')
    expect(p('台新卡消費通知：您於 Uber Eats 外送 消費 NT$320，末四碼1234').kind === 'spend').toBe(true)
    const bare = p('您的台新卡在 蝦皮購物 消費 NT$899，本筆享 1% 現金回饋')
    expect(bare.kind === 'spend' && bare.doubt).toContain('請確認')
    expect(p(SIM_NOTIFICATIONS.convenience)).toMatchObject({ kind: 'spend' })
  })
  it('a purchase that mentions a reward, a code or 登錄 is still a purchase', () => {
    const spend = (body: string) => {
      const r = p(body)
      return r.kind === 'spend' ? [r.spend.amount, r.spend.merchant] : r
    }
    expect(spend('您的台新卡在 蝦皮購物 消費 NT$899，本筆享 1% 現金回饋')).toEqual([899, '蝦皮購物'])
    expect(spend('您的台新卡在 全聯福利中心 消費 NT$1,200，單筆滿 3,000 元，已累積回饋點數')).toEqual([1200, '全聯福利中心'])
    expect(spend('您的台新卡單筆滿 3,000 元送點數，本次在 全聯 消費 NT$450')).toEqual([450, '全聯'])
    // "金額，享 X% 回饋" reads the same as an offer threshold, so it is left for the user (unparsed), never not_spending.
    expect(p('您的台新卡於 好市多 消費 NT$3,456，享 2.5% 回饋').kind).toBe('unparsed')
    expect(spend('您的台新卡在 達美樂 消費 NT$500，如非本人交易請勿提供驗證碼')).toEqual([500, '達美樂'])
    expect(spend('您的台新卡在 OTP咖啡 消費 NT$120')).toEqual([120, 'OTP咖啡'])
    expect(spend('全家 NT$85 刷卡成功，享 1% 回饋')).toEqual([85, '']) // no shop wording → left for the user to fill
    expect(spend('您的台新卡在 登錄咖啡 消費 NT$95，抽獎活動進行中')).toEqual([95, '登錄咖啡'])
  })
  it('adversarial set, round 4: real purchases are never "not spending"; offers and codes are never imported by default or valued at a threshold', () => {
    const purchases = [
      '您的台新卡末四碼1234於10/11 14:05在全家消費 NT$85 享 NT$5 回饋',
      '您於全家消費NT$85 可享5%回饋',
      '您的台新卡在全家消費NT$85 即享優惠',
      '您的台新卡在全家消費NT$85，若非本人交易請致電客服協助取消交易',
      '您的台新卡在拒絕平庸咖啡消費NT$150',
      '您的台新卡末四碼1234於10/11 14:05在中華電信自動扣款新臺幣1,299元',
      '您以信用卡末四碼1234於10/11 14:05繳納臺北自來水費NT$300，繳費成功',
    ]
    for (const body of purchases) expect(p(body).kind, body).not.toBe('not_spending')
    const offersAndCodes: [string, number[]][] = [
      ['您的一次性密碼為 482913，用於網路交易 NT$1,280', [1280]],
      ['您的交易認證碼為 482913，網路刷卡 NT$1,280', [1280]],
      ['簡訊密碼 482913，刷卡金額NT$1,280，請勿外流', [1280]],
      ['【台新】消費NT$3000，送電影票一張', []],
      ['台新卡消費NT$3,000(含)以上送星巴克咖啡', []],
      ['台新卡消費NT$3,000（含）以上送星巴克咖啡', []],
      ['週末指定商店單筆消費NT$1,000折NT$100', []],
      ['台新卡刷卡消費 NT$1,000 折 NT$100', []],
      ['恭喜您獲得刷卡金 NT$100', []],
      ['刷卡金NT$100已入帳', []],
      ['台新卡友專屬！消費NT$2,000，即可兌換好禮', []],
      ['刷卡消費每滿 NT$1,000 加碼 NT$50', []],
      ['刷卡消費 NT$2,000 再享 3 期 0 利率', []],
      ['您的台新卡將於10/15扣款 NT$12,345', []],
      ['本期帳單金額 NT$12,345，將於10/15自動扣款', []],
      // round 5
      ['您的3D驗證密碼為482913，於UNIQLO刷卡交易NT$1,280，卡號末四碼1234，10/11 14:05', [1280]],
      ['交易確認碼482913，於UNIQLO刷卡消費NT$1,280，卡號末四碼1234，10/11 14:05', [1280]],
      ['密碼：482913，您正於UNIQLO網路刷卡交易NT$1,280，卡號末四碼1234，10/11 14:05', [1280]],
      ['週末於新光三越刷卡消費NT$5,000，現賺NT$500，至10/31 23:59止', []],
      ['於新光三越刷卡消費NT$3,000，拿NT$300好康，末四碼1234 10/11 14:05', []],
      ['於全家刷卡消費NT$300，得50元抵用券，末四碼1234 10/11 14:05', []],
      ['即日起刷卡消費NT$3,000，享5%回饋', []],
      ['刷卡消費NT$3,000，回饋NT$300', []],
      ['刷卡消費NT$3,000，加贈NT$300', []],
      ['刷卡消費NT$3,000，現折NT$300', []],
      ['於新光三越刷卡消費NT$3,000加贈NT$300，至10/31 23:59止', []],
      ['於新光三越刷卡消費NT$3,000現折NT$300，至10/31 23:59止', []],
      ['您的台新卡末四碼1234於10/11 14:05在UNIQLO刷卡NT$1,280未獲核准', [1280]],
      ['您的台新卡末四碼1234於10/11 14:05在UNIQLO刷卡NT$1,280授權失敗', [1280]],
    ]
    for (const [body, allowed] of offersAndCodes) {
      const r = p(body)
      if (r.kind !== 'spend') continue
      expect(r.doubt, body).not.toBeNull()
      expect(allowed, body).toContain(r.spend.amount)
    }
  })
  it('a "12/31" read in early January belongs to last year', () => {
    const r = parseNotification(capture({ body: '於12/31 23:10在全家消費NT$50', notificationTime: new Date(2027, 0, 1, 0, 5).toISOString() }), undefined, { generic: true })
    expect(r.kind === 'spend' && new Date(r.spend.occurredAt!).getFullYear()).toBe(2026)
  })
})

const card = (id: string, last4?: string): PaymentMethod => ({ id, name: id, type: 'credit_card', isActive: true, sortOrder: 0, ...(last4 ? { cardLast4: last4 } : {}) })
function tx(p: Partial<Transaction> & { amount: number; at: Date }): Transaction {
  const iso = p.at.toISOString()
  return {
    id: p.id ?? 't' + Math.random().toString(36).slice(2),
    type: 'expense',
    amount: p.amount,
    merchant: p.merchant ?? '',
    categoryId: 'food',
    paymentMethodId: p.paymentMethodId ?? 'taishin',
    occurredAt: iso,
    note: '',
    source: 'manual',
    externalId: null,
    createdAt: iso,
    updatedAt: iso,
  }
}

describe('import planning: duplicates, cards, categories (D-83..D-85)', () => {
  const base = {
    paymentMethods: [card('taishin', '1234'), card('other', '9999')],
    categories: DEFAULT_CATEGORIES,
    history: [{ merchant: '全家便利商店', categoryId: 'food' }],
    defaultCards: {},
    adapters: [SIM_NOTIFICATION_ADAPTER],
    // These cases exercise the card rules through the (switched-off) generic reader (D-128).
    generic: true,
    now: new Date(2026, 9, 11, 20),
  }
  it('same captureId (already imported, or twice in one batch) is a duplicate', () => {
    const c = capture({ captureId: 'x1', body: SIM_NOTIFICATIONS.convenience })
    const rows = planImport({ ...base, captures: [c, c], knownCaptureIds: new Set(), transactions: [] })
    expect(rows.map((r) => r.status)).toEqual(['new', 'duplicate'])
    expect(planImport({ ...base, captures: [c], knownCaptureIds: new Set(['x1']), transactions: [] })[0].status).toBe('duplicate')
  })
  it('different ids but same card, amount and time → suspected duplicate, not imported by default', () => {
    const a = capture({ captureId: 'a', body: SIM_NOTIFICATIONS.convenience })
    const b = capture({ captureId: 'b', body: SIM_NOTIFICATIONS.convenience })
    const rows = planImport({ ...base, captures: [a, b], knownCaptureIds: new Set(), transactions: [] })
    expect(rows.map((r) => [r.status, r.include])).toEqual([
      ['new', true],
      ['suspect', false],
    ])
  })
  it('an existing manual record of the same purchase is flagged', () => {
    const manual = tx({ amount: 85, at: new Date(2026, 9, 11, 14, 9), merchant: '全家', paymentMethodId: 'taishin' })
    const rows = planImport({ ...base, captures: [capture({ body: SIM_NOTIFICATIONS.convenience })], knownCaptureIds: new Set(), transactions: [manual] })
    expect(rows[0].status).toBe('suspect')
  })
  it('Q97: same amount on the same day is shown as a possible duplicate even on another card (a hint, never merged)', () => {
    const other = tx({ amount: 85, at: new Date(2026, 9, 11, 9, 0), merchant: '早餐店', paymentMethodId: 'other' })
    const rows = planImport({ ...base, captures: [capture({ body: SIM_NOTIFICATIONS.convenience })], knownCaptureIds: new Set(), transactions: [other] })
    expect(rows[0]).toMatchObject({ status: 'suspect', include: false, duplicate: true })
    expect(rows[0].reason).toContain('可能與 10/11 的既有交易「早餐店」重複')
    // Another day is not flagged.
    const yesterday = tx({ amount: 85, at: new Date(2026, 9, 10, 14, 5), merchant: '全家', paymentMethodId: 'taishin' })
    expect(planImport({ ...base, captures: [capture({ body: SIM_NOTIFICATIONS.convenience })], knownCaptureIds: new Set(), transactions: [yesterday] })[0].status).toBe('new')
  })
  it('maps the card by last four digits, else the remembered card, else asks', () => {
    const c = capture({ body: SIM_NOTIFICATIONS.convenience })
    expect(planImport({ ...base, captures: [c], knownCaptureIds: new Set(), transactions: [] })[0].paymentMethodId).toBe('taishin')
    const noLast4 = capture({ body: '於10/11 14:05在全家消費NT$85' })
    expect(planImport({ ...base, captures: [noLast4], knownCaptureIds: new Set(), transactions: [] })[0].paymentMethodId).toBeNull()
    expect(planImport({ ...base, defaultCards: { 'Richart Life': 'other' }, captures: [noLast4], knownCaptureIds: new Set(), transactions: [] })[0].paymentMethodId).toBe('other')
    // Each app has its own remembered card: another bank's notification never borrows Richart's.
    const fromOther = capture({ body: '於10/11 14:05在全家消費NT$85', sourceApp: '某銀行 App' })
    expect(planImport({ ...base, defaultCards: { 'Richart Life': 'other' }, captures: [fromOther], knownCaptureIds: new Set(), transactions: [] })[0].paymentMethodId).toBeNull()
    // No digits: the adapter's bank picks the only card of that bank.
    const banks = [{ ...card('taishin'), bank: '台新' }, { ...card('ctbc'), bank: '中國信託' }]
    expect(planImport({ ...base, paymentMethods: banks, captures: [noLast4], knownCaptureIds: new Set(), transactions: [] })[0].paymentMethodId).toBe('taishin')
  })
  it('categories: history first, then keywords, else 其他', () => {
    expect(suggestCategory('全家便利商店', base.history, DEFAULT_CATEGORIES)).toBe('food')
    expect(suggestCategory('台灣中油', [], DEFAULT_CATEGORIES)).toBe('transport')
    expect(suggestCategory('Uber Eats', [], DEFAULT_CATEGORIES)).toBe('food')
    expect(suggestCategory('某某工作室', [], DEFAULT_CATEGORIES)).toBe('other')
  })
})

describe('statement parser (generic adapter, simulated layout)', () => {
  const s = parseStatementLines(SIM_STATEMENT_LINES)
  it('reads statement info without mixing up the three kinds of date', () => {
    expect(s).toMatchObject({ bank: '台新', cardLast4: '1234', closingDate: '2026-10-15', dueDate: '2026-11-02', periodStart: '2026-09-16', periodEnd: '2026-10-15' })
  })
  it('reads every entry with purchase and posting dates, kinds and signs', () => {
    expect(s.entries.map((e) => [e.txDate, e.postDate, e.amount, e.kind])).toEqual([
      ['2026-09-18', '2026-09-20', 85, 'purchase'],
      ['2026-09-20', '2026-09-22', 320, 'purchase'],
      ['2026-10-01', '2026-10-03', 390, 'purchase'],
      ['2026-10-05', '2026-10-07', 1015, 'purchase'],
      ['2026-10-08', '2026-10-10', 1280, 'purchase'],
      ['2026-10-09', '2026-10-09', -365, 'refund'],
      ['2026-09-25', '2026-09-25', -12000, 'payment'],
    ])
    expect(s.entries[1].merchant).toBe('UBER *EATS')
  })
  it('checks totals against "本期新增款項" and never uses the amount due', () => {
    expect(s.declaredNewCharges).toBe(2725)
    expect(s.totalsMatch).toBe(true)
  })
  it('flags a missing line through the totals check', () => {
    const missing = parseStatementLines(SIM_STATEMENT_LINES.filter((l) => !l.includes('NETFLIX')))
    expect(missing.totalsMatch).toBe(false)
    expect(missing.warnings.join()).toContain('不同')
  })
  it('never misreads: dates with a year stay as printed; cents, trailing foreign amounts and header lines are not entries', () => {
    const r = parseStatementLines([
      '帳單結帳日 2026/10/15',
      '2026/10/14 2026/10/17 全家 500',
      '10/01 10/03 全家 1234.5',
      '10/02 10/04 AMAZON US 395 USD 12.50',
      '應繳總額 2026/11/02 14,725',
      '應繳總額 14,725 繳款到期日 2026/11/02',
      '帳單金額 14,725 2026/10/15',
      '115/10/05 115/10/06 誠品書店 1,200.00',
    ])
    expect(r.entries.map((e) => [e.txDate, e.postDate, e.amount])).toEqual([
      ['2026-10-14', '2026-10-17', 500],
      ['2026-10-05', '2026-10-06', 1200],
    ])
    expect(r.unreadLines).toHaveLength(2)
    expect(r.warnings.join()).toContain('無法辨識')
  })
  it('never reads a wrong amount from the end of a line: it goes to "unread" instead', () => {
    const head = ['帳單結帳日 2026/10/15', '帳單週期 2026/09/16 ~ 2026/10/15']
    const unread = [
      '10/02 10/04 AMAZON 1,000 NZD 32', // currency not in the code list before → foreign last
      '10/02 10/04 淘寶 1,000 RMB 200',
      '10/02 10/04 AMAZON 1,000 美金 32',
      '10/02 10/04 AMAZON 1,000 日圓 3,200',
      '10/02 10/04 AMAZON 1,000 US 32',
      '10/02 10/04 某商店 1,234.567', // 3 decimals
      '10/02 10/04 全家 尾號1234', // card digits
      '10/02 10/04 全家 末四碼 1234',
      '10/02 10/04 全家 500 1,000', // two amount columns
      '10/02 10/04 全家 1 234', // thousands split by a space
      '26/10/05 26/10/06 全家 500', // unsupported date formats are never guessed
      '20261005 20261006 全家 500',
      '10-05 10-06 全家 500',
      '10.05 10.06 全家 500',
    ]
    const r = parseStatementLines([...head, ...unread])
    expect(r.entries).toEqual([])
    expect(r.unreadLines).toEqual(unread)
  })
  it('round-3 adversarial lines: unread, never a wrong amount or date', () => {
    const head = ['帳單結帳日 2026/10/15', '帳單週期 2026/09/16 ~ 2026/10/15']
    const unread = [
      '10/02 10/04 AMAZON 1,000 US$32',
      '10/02 10/04 AMAZON 1,000 US$ 32.00',
      '10/02 10/04 東京書店 680 ¥3,200',
      '10/02 10/04 PARIS 900 €25',
      '10/02 10/04 HK SHOP 500 HK$120',
      '10/02 10/04 PRAHA 1,000 CZK 500',
      '10/02 10/04 PRAHA CZK 500',
      '10/02 10/04 AMAZON 1,000 usd 32',
      '10/02 10/04 書店 680 加幣 30',
      '10/02 10/04 書店 新加坡幣 30',
      '10/02 10/04 書店 韓幣 3,000',
      '10/02 10/04 全家 後四碼 1234',
      '10/02 10/04 全家 卡號後4碼1234',
      '10/02 10/04 全家 *1234',
      '10/02 10/04 全家 NT$500 1,000',
      '10/02 10/04 全家 500元 1,000',
      '10/02 10/04 全家 500 TWD 1,000',
      '10/05 10/07 全家 12:30',
      '10/05/2026 10/07/2026 全家 85',
      'OCT05 OCT07 AMAZON 85',
      '10 / 05 10 / 07 全家 85',
      '全家 2026/10/05 85',
    ]
    // '繳費截止日 …' is a heading (dropped); '2026/10/15 消費次數 5' has an entry's shape, so it is shown.
    const r = parseStatementLines([...head, ...unread, '繳費截止日 2026/11/02 1,000', '2026/10/15 消費次數 5'])
    expect(r.entries).toEqual([])
    expect(r.unreadLines).toEqual([...unread, '2026/10/15 消費次數 5'])
  })
  it('adversarial set, round 4: signs, card digits, heading words and undated lines', () => {
    const head = ['帳單結帳日 2026/10/15']
    const unread = [
      '10/09 10/09 UNIQLO - 365',
      '10/02 10/04 全聯 XXXX1234',
      '10/02 10/04 全聯 卡末1234',
      '10/05 10/05 循環信用利息 235',
      '10/05 10/05 紅利點數折抵 -100',
      '全家便利商店 85',
      'UBER *EATS 320',
      '10/02 10/04 AMAZONUSD32',
    ]
    const r = parseStatementLines([...head, ...unread, '卡號 ****-****-****-1234'])
    expect(r.entries).toEqual([])
    expect(r.unreadLines).toEqual(unread)
    // Round 5: date-first lines with heading words, day-month dates, currencies inside words, and wording
    // that contradicts the printed sign are all shown, never dropped or re-signed.
    const r5 = [
      '10/05 10/05 循環信用利息 NT$235',
      '10/03 10/05 額度調整手續費 100元整',
      '18SEP 20SEP AMAZON 32 USD',
      '10/05 10/07 中華電信 自動扣繳 1,299',
      '10/05 10/07 退貨手續費 30',
      '10/05 10/07 超商繳款手續費 15',
      '10/05 10/07 取消訂閱補收費用 120',
      '09/18 09/20 AMAZON(USD) 32',
      '09/18 09/20 AMAZON/USD 32',
      '09/18 09/20 東京迪士尼日圓 3200',
      '09/18 09/20 東京 円 3200',
      '09/18 09/20 附卡 5678',
    ]
    const round5 = parseStatementLines([...head, ...r5])
    expect(round5.entries).toEqual([])
    expect(round5.unreadLines).toEqual(r5)
    // Unicode minus signs are read as minus.
    const minus = parseStatementLines([...head, '10/09 10/09 UNIQLO −365', '10/09 10/09 UNIQLO –365'])
    expect(minus.entries.map((e) => e.amount)).toEqual([-365, -365])
    // A currency name glued to its amount is the foreign column; "NT$" before the amount is not part of the shop.
    const glued = parseStatementLines([...head, '10/02 10/04 AMAZON 日圓3,200 1,015', '10/02 10/04 全家 NT$ 85'])
    expect(glued.entries.map((e) => [e.merchant, e.amount, e.foreign])).toEqual([
      ['AMAZON', 1015, '日圓3,200'],
      ['全家', 85, null],
    ])
    // No closing date: the year comes from the printed cycle end, so a January cycle reads 01/05 as this year.
    const jan = parseStatementLines(['帳單週期 2025/12/16 ~ 2026/01/15', '12/28 12/30 全家 85', '01/05 01/06 全聯 120'])
    expect(jan.entries.map((e) => e.txDate)).toEqual(['2025-12-28', '2026-01-05'])
    // No closing date, only a cycle: a month/day after the cycle is flagged, not trusted.
    const noClose = parseStatementLines(['帳單週期 2026/09/16 ~ 2026/10/15', '12/28 12/30 全家 85'])
    expect(noClose.warnings.join()).toContain('週期之後')
    // A date printed with a year after the closing date is flagged too.
    const after = parseStatementLines(['帳單結帳日 2026/10/15', '2026/11/02 2026/11/03 全家 85'])
    expect(after.warnings.join()).toContain('週期之後')
  })
  it('a foreign amount printed before the TWD amount is fine', () => {
    const r = parseStatementLines(['帳單結帳日 2026/10/15', '10/02 10/04 AMAZON NZD 32.00 650', '10/03 10/05 東京書店 日幣 3,200 680'])
    expect(r.entries.map((e) => [e.amount, e.foreign, e.merchant])).toEqual([
      [650, 'NZD 32.00', 'AMAZON'],
      [680, '日幣 3,200', '東京書店'],
    ])
  })
  it('summary lines with a date and a number are not entries', () => {
    const r = parseStatementLines(['帳單結帳日 2026/10/15', '繳款日 2026/11/02 1,000', '消費 筆數 2026/10/15 5', '10/05 10/07 全家 85'])
    expect(r.entries.map((e) => [e.merchant, e.amount, e.kind])).toEqual([['全家', 85, 'purchase']])
    expect(r.unreadLines).toEqual([])
  })
  it('reads 10月5日 and warns about one-date lines and far-off guessed years', () => {
    const one = parseStatementLines(['帳單結帳日 2026/10/15', '10月05日 全家 85', '10/06 全聯 120'])
    expect(one.entries.map((e) => [e.txDate, e.postDate])).toEqual([
      ['2026-10-05', null],
      ['2026-10-06', null],
    ])
    expect(one.warnings.join()).toContain('只讀到一個日期')
    const mixed = parseStatementLines(['帳單結帳日 2026/10/15', '10/05 10/07 全家 85', '10/06 國外交易服務費 15'])
    expect(mixed.warnings.join()).toContain('有 1 筆明細只讀到一個日期')
    const far = parseStatementLines(['帳單結帳日 2026/10/15', '帳單週期 2026/09/16 ~ 2026/10/15', '12/28 12/30 全家 85', '10/05 10/07 全聯 120'])
    expect(far.entries[0].txDate).toBe('2025-12-28')
    expect(far.warnings.join()).toContain('週期之後，或沒印年份')
    // A date printed WITH a year is never questioned (an installment's original purchase date).
    const printed = parseStatementLines(['帳單結帳日 2026/10/15', '2026/03/05 2026/10/07 分期 第3/6期 1,000'])
    expect(printed.warnings.join()).not.toContain('週期之後，或沒印年份')
  })
  it('no text → no entries and a clear warning', () => {
    expect(parseStatementLines([]).warnings).toContain('沒有讀到任何交易明細')
  })
})

describe('reconciliation engine (spec §7, §8)', () => {
  const statement: CardStatement = {
    id: 'st',
    paymentMethodId: 'taishin',
    bank: '台新',
    statementMonth: '2026-10',
    periodStart: '2026-09-16',
    periodEnd: '2026-10-15',
    dueDate: null,
    fileHash: 'h',
    fileName: 'f.pdf',
    parseStatus: 'confirmed',
    adapter: 'generic',
    batchId: 'b',
    createdAt: '',
    updatedAt: '',
  }
  const entries: StatementEntry[] = parseStatementLines(SIM_STATEMENT_LINES).entries.map((e, i) => ({ ...e, id: 'e' + i, statementId: 'st', order: i }))
  const at = (m: number, d: number, h = 12) => new Date(2026, m - 1, d, h)
  const records = [
    tx({ id: 'family', amount: 85, at: at(9, 18), merchant: '全家' }),
    tx({ id: 'uber', amount: 320, at: at(9, 20), merchant: 'Uber Eats' }),
    tx({ id: 'cpc', amount: 1000, at: at(10, 5), merchant: '中油' }), // statement says 1,015
    tx({ id: 'uniqlo', amount: 1280, at: at(10, 8), merchant: 'UNIQLO' }),
    tx({ id: 'louisa', amount: 150, at: at(9, 28), merchant: '路易莎' }), // not on the statement
    tx({ id: 'mcd', amount: 200, at: at(10, 13), merchant: '麥當勞' }), // 2 days before closing
    tx({ id: 'later', amount: 99, at: at(10, 20), merchant: '之後' }), // after the cycle
    tx({ id: 'cash', amount: 85, at: at(9, 18), merchant: '全家', paymentMethodId: 'cash' }), // another payment method
  ]
  const r = reconcile({ statement, entries, transactions: records, recons: [] })
  const kindOf = (id: string) => r.items.find((i) => ('entry' in i && i.entry.id === id) || ('tx' in i && i.tx?.id === id))?.kind

  it('auto-matches reliable one-to-one pairs only', () => {
    expect(r.autoPairs.map((p) => p.transactionId).sort()).toEqual(['family', 'uber', 'uniqlo'])
  })
  it('bank-only, amount difference and special entries', () => {
    expect(kindOf('e2')).toBe('bank_only') // NETFLIX
    const diff = r.items.find((i) => i.kind === 'amount_diff')
    expect(diff && diff.kind === 'amount_diff' && [diff.tx.id, diff.diff]).toEqual(['cpc', 15])
    expect(kindOf('e5')).toBe('special') // refund
    expect(r.payments.map((p) => p.amount)).toEqual([-12000])
  })
  it('record-only within the cycle; near the closing date waits for next statement; other cards ignored', () => {
    expect(kindOf('louisa')).toBe('book_only')
    expect(kindOf('mcd')).toBe('pending_next')
    expect(kindOf('later')).toBeUndefined()
    expect(kindOf('cash')).toBeUndefined()
  })
  it('summary keeps statement-side and record-side counts separate', () => {
    expect(r.summary).toEqual({ entries: 6, matched: 3, bankOnly: 1, bookOnly: 1, needsReview: 2, pendingNext: 1 })
  })
  it('two identical candidates → needs confirmation, never a random pick', () => {
    const twin = [tx({ id: 'a', amount: 85, at: at(9, 18), merchant: '全家' }), tx({ id: 'b', amount: 85, at: at(9, 18), merchant: '全家' })]
    const res = reconcile({ statement, entries: [entries[0]], transactions: twin, recons: [] })
    expect(res.autoPairs).toEqual([])
    expect(res.items[0].kind).toBe('ambiguous')
  })
  it('purchase date differs from posting date: the record date is used, never changed', () => {
    const res = reconcile({ statement, entries: [entries[1]], transactions: [tx({ id: 'u', amount: 320, at: at(9, 21), merchant: 'Uber Eats' })], recons: [] })
    expect(res.autoPairs).toEqual([{ entryId: 'e1', transactionId: 'u' }])
  })
  it('unknown billing cycle → no record-only judgement', () => {
    const res = reconcile({ statement: { ...statement, periodStart: null }, entries, transactions: records, recons: [] })
    expect(res.summary.bookOnly).toBeNull()
    expect(res.items.some((i) => i.kind === 'book_only')).toBe(false)
  })
  it('a saved pair breaks when the record is edited or deleted (D-92)', () => {
    const saved: Reconciliation = { id: 'r1', statementId: 'st', entryId: 'e0', transactionId: 'family', status: 'matched', method: 'auto', snapshot: { amount: 85, date: '2026-09-18', paymentMethodId: 'taishin' }, note: '', createdAt: '' }
    const edited = records.map((t) => (t.id === 'family' ? { ...t, amount: 90 } : t))
    expect(reconcile({ statement, entries, transactions: edited, recons: [saved] }).items.find((i) => i.kind === 'broken')).toBeTruthy()
    const deleted = records.filter((t) => t.id !== 'family')
    const b = reconcile({ statement, entries, transactions: deleted, recons: [saved] }).items.find((i) => i.kind === 'broken')
    expect(b && b.kind === 'broken' && b.reason).toContain('刪除')
    expect(reconcile({ statement, entries, transactions: records, recons: [saved] }).items.find((i) => 'entry' in i && i.entry.id === 'e0')?.kind).toBe('matched')
  })
  it('a record held by a broken pair is not offered to another entry', () => {
    const saved: Reconciliation = { id: 'r9', statementId: 'st', entryId: 'e0', transactionId: 'family', status: 'matched', method: 'auto', snapshot: { amount: 80, date: '2026-09-18', paymentMethodId: 'taishin' }, note: '', createdAt: '' }
    const twin = { ...entries[0], id: 'e0b', order: 99 }
    const res = reconcile({ statement, entries: [entries[0], twin], transactions: records, recons: [saved] })
    expect(res.items.find((i) => 'entry' in i && i.entry.id === 'e0')?.kind).toBe('broken')
    expect(res.items.find((i) => 'entry' in i && i.entry.id === 'e0b')?.kind).toBe('bank_only')
    expect(res.autoPairs).toEqual([])
  })
  it('a record paired on another statement is not offered again', () => {
    const elsewhere: Reconciliation = { id: 'r2', statementId: 'other', entryId: 'x', transactionId: 'family', status: 'matched', method: 'manual', snapshot: { amount: 85, date: '2026-09-18', paymentMethodId: 'taishin' }, note: '', createdAt: '' }
    const res = reconcile({ statement, entries: [entries[0]], transactions: records, recons: [elsewhere] })
    expect(res.items[0].kind).toBe('bank_only')
  })
  it('deferred records stay "waiting for next statement"', () => {
    const d: Reconciliation = { id: 'r3', statementId: 'st', entryId: null, transactionId: 'louisa', status: 'deferred', method: 'manual', snapshot: null, note: '', createdAt: '' }
    expect(reconcile({ statement, entries, transactions: records, recons: [d] }).items.find((i) => 'tx' in i && i.tx?.id === 'louisa')?.kind).toBe('pending_next')
  })
})

describe('purchase time (D-100)', () => {
  const arrived = new Date(2026, 9, 11, 14, 6, 20).toISOString()
  const captured = new Date(2026, 9, 11, 18, 30).toISOString()
  const hm = (iso: string | null) => {
    const t = new Date(iso!)
    return `${t.getMonth() + 1}/${t.getDate()} ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`
  }
  it('date and time in the message are exact', () => {
    const r = purchaseTime('於10/11 14:05在全家消費', { notificationTime: arrived, capturedAt: captured })
    expect([hm(r.occurredAt), r.timeSource]).toEqual(['10/11 14:05', undefined])
  })
  it('no time in the message: the arrival time, marked as such', () => {
    const r = purchaseTime('在全家消費 NT$85', { notificationTime: arrived, capturedAt: captured })
    expect([r.occurredAt, r.timeSource]).toEqual([arrived, 'notification'])
    const sameDay = purchaseTime('10/11 在全家消費', { notificationTime: arrived, capturedAt: captured })
    expect([sameDay.occurredAt, sameDay.timeSource]).toEqual([arrived, 'notification'])
  })
  it('a date that is not the arrival day: that date at 12:00, marked date-only', () => {
    const r = purchaseTime('10/09 在全家消費', { notificationTime: arrived, capturedAt: captured })
    expect([hm(r.occurredAt), r.timeSource]).toEqual(['10/9 12:00', 'date'])
  })
  it('only a time: that time on the arrival day', () => {
    const r = purchaseTime('14:01 在全家消費', { notificationTime: arrived, capturedAt: captured })
    expect([hm(r.occurredAt), r.timeSource]).toEqual(['10/11 14:01', undefined])
  })
  it('the capture time is never used as the purchase time', () => {
    const r = purchaseTime('在全家消費', { notificationTime: null, capturedAt: captured })
    expect([hm(r.occurredAt), r.timeSource]).toEqual(['10/11 12:00', 'date'])
    expect(purchaseTime('在全家消費', { notificationTime: null, capturedAt: null })).toEqual({ occurredAt: null })
  })
  it('the import plan and the record carry the marker', () => {
    const rows = planImport({
      captures: [capture({ body: '在全家消費 NT$85', notificationTime: arrived })],
      knownCaptureIds: new Set(),
      transactions: [],
      paymentMethods: [card('taishin', '1234')],
      categories: DEFAULT_CATEGORIES,
      history: [],
      defaultCards: {},
      generic: true,
      now: new Date(2026, 9, 11, 20),
    })
    expect(rows[0]).toMatchObject({ occurredAt: arrived, timeSource: 'notification' })
  })
})
