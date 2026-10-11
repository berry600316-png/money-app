import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES } from '../db/defaults'
import type { CardStatement, PaymentMethod, Reconciliation, StatementEntry, Transaction } from '../db/types'
import { suggestCategory } from './categorize'
import { capture, SIM_NOTIFICATIONS, SIM_STATEMENT_LINES } from './fixtures'
import { planImport } from './importPlan'
import { readCaptureFile, readTime } from './notificationFile'
import { parseNotification } from './notificationParser'
import { reconcile } from './reconcile'
import { parseStatementLines } from './statementParser'
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
      for (const c of r.captures) kinds.push(parseNotification(c).kind)
    }
    expect(kinds.filter((k) => k === 'spend')).toHaveLength(4)
    expect(kinds.filter((k) => k === 'not_spending')).toHaveLength(1)
  })
})

describe('notification parser (simulated samples only)', () => {
  const p = (body: string) => parseNotification(capture({ body }))
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
    expect(p('交易驗證碼 889900，本次消費 NT$500，請勿告知他人')).toMatchObject({ kind: 'not_spending' })
    expect(p('即日起刷卡享 5% 回饋，登錄抽 iPhone')).toMatchObject({ kind: 'not_spending' })
    expect(p('於全家消費 NT$50 以上即享 5% 回饋')).toMatchObject({ kind: 'not_spending' })
    expect(p('本月累積消費 NT$5,000，再刷 NT$1,000 即享回饋')).toMatchObject({ kind: 'not_spending' })
  })
  it('a purchase that mentions a reward, a code or 登錄 is still a purchase', () => {
    const spend = (body: string) => {
      const r = p(body)
      return r.kind === 'spend' ? [r.spend.amount, r.spend.merchant] : r
    }
    expect(spend('您的台新卡在 蝦皮購物 消費 NT$899，本筆享 1% 現金回饋')).toEqual([899, '蝦皮購物'])
    expect(spend('您的台新卡在 全聯福利中心 消費 NT$1,200，單筆滿 3,000 元，已累積回饋點數')).toEqual([1200, '全聯福利中心'])
    expect(spend('您的台新卡單筆滿 3,000 元送點數，本次在 全聯 消費 NT$450')).toEqual([450, '全聯'])
    expect(spend('您的台新卡於 好市多 消費 NT$3,456，享 2.5% 回饋')).toEqual([3456, '好市多'])
    expect(spend('您的台新卡在 達美樂 消費 NT$500，如非本人交易請勿提供驗證碼')).toEqual([500, '達美樂'])
    expect(spend('您的台新卡在 OTP咖啡 消費 NT$120')).toEqual([120, 'OTP咖啡'])
    expect(spend('全家 NT$85 刷卡成功，享 1% 回饋')).toEqual([85, '']) // no shop wording → left for the user to fill
    expect(spend('您的台新卡在 登錄咖啡 消費 NT$95，抽獎活動進行中')).toEqual([95, '登錄咖啡'])
  })
  it('a "12/31" read in early January belongs to last year', () => {
    const r = parseNotification(capture({ body: '於12/31 23:10在全家消費NT$50', notificationTime: new Date(2027, 0, 1, 0, 5).toISOString() }))
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
    defaultCardId: null,
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
  it('same amount at the same shop on another card is NOT a duplicate', () => {
    const other = tx({ amount: 85, at: new Date(2026, 9, 11, 14, 5), merchant: '全家', paymentMethodId: 'other' })
    const rows = planImport({ ...base, captures: [capture({ body: SIM_NOTIFICATIONS.convenience })], knownCaptureIds: new Set(), transactions: [other] })
    expect(rows[0].status).toBe('new')
  })
  it('maps the card by last four digits, else the remembered card, else asks', () => {
    const c = capture({ body: SIM_NOTIFICATIONS.convenience })
    expect(planImport({ ...base, captures: [c], knownCaptureIds: new Set(), transactions: [] })[0].paymentMethodId).toBe('taishin')
    const noLast4 = capture({ body: '於10/11 14:05在全家消費NT$85' })
    expect(planImport({ ...base, captures: [noLast4], knownCaptureIds: new Set(), transactions: [] })[0].paymentMethodId).toBeNull()
    expect(planImport({ ...base, defaultCardId: 'other', captures: [noLast4], knownCaptureIds: new Set(), transactions: [] })[0].paymentMethodId).toBe('other')
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
    expect(far.warnings.join()).toContain('請確認年份')
    // A date printed WITH a year is never questioned (an installment's original purchase date).
    const printed = parseStatementLines(['帳單結帳日 2026/10/15', '2026/03/05 2026/10/07 分期 第3/6期 1,000'])
    expect(printed.warnings.join()).not.toContain('請確認年份')
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
