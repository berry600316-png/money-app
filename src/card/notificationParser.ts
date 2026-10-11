/*
 * Rule-based parsing of card notifications (D-82). Kept apart from the UI: when Richart Life changes
 * its wording, only the rules here change.
 *
 * IMPORTANT: no real Richart Life notification sample has been provided yet. The rules below cover the
 * usual Taiwanese card-notification wording and are tested only against simulated samples.
 */
import type { ParsedSpend } from '../db/types'
import type { NotificationCapture } from './notificationFile'
import { findDates, findLast4, findTime, NTD_RE, parseAmount, toHalfWidth } from './text'

export type ParseResult =
  | { kind: 'spend'; spend: ParsedSpend; adapter: string }
  | { kind: 'not_spending'; reason: string }
  | { kind: 'unparsed'; reason: string }

/** Wording that always means "this is not a new purchase". */
const NOT_SPENDING: [RegExp, string][] = [
  [/退款|退貨|退刷|刷退/, '退款通知'],
  [/取消交易|交易取消|已取消|撤銷|沖正/, '取消交易通知'],
  [/繳款成功|已繳款|入帳成功|自動扣繳成功|繳費成功|繳款通知/, '繳款通知'],
  [/交易失敗|拒絕|未成功|額度不足/, '交易失敗通知'],
  // An actual one-time code ("驗證碼為 123456"): 3-D Secure messages also carry merchant + amount,
  // but the purchase itself arrives as a separate notification.
  [/(?:驗證碼|OTP|動態密碼)\s*(?:為|是)?\s*[:：]?\s*\d{4,8}(?!\d)/i, '安全性通知'],
]
/**
 * Wording that means "not a purchase" unless the message states a purchase outright
 * ("在 蝦皮 消費 NT$899，本筆享 1% 回饋" is a purchase that mentions a reward).
 */
const UNLESS_PURCHASE: [RegExp, string][] = [
  [/驗證碼|OTP|動態密碼/i, '安全性通知'],
  // Offers mention spending too ("刷卡消費滿 NT$3,000 享 5% 回饋"): an amount threshold or a percentage reward.
  [/(?:滿|達|累積)\s*(?:NT\$|新?[臺台]幣)?\s*[\d,]+\s*元?.{0,12}(?:享|送|贈|回饋|折)|享\s*\d+(?:\.\d+)?\s*%|登錄|抽獎/, '行銷或回饋通知'],
]
/** Wording that means "not a purchase" only when the text doesn't also look like one (footers often say 密碼, 優惠…). */
const WEAK_NOT_SPENDING: [RegExp, string][] = [
  [/電子帳單|帳單已|本期應繳|帳單通知/, '帳單通知'],
  [/登入|新裝置/i, '安全性通知'],
  [/優惠|活動|回饋|點數|紅利|抽獎|好禮/, '行銷或回饋通知'],
]
const SPENDING = /消費|刷卡|交易|扣款|簽帳|授權|支付|付款/
const FOREIGN = /\b(USD|JPY|EUR|GBP|KRW|HKD|CNY|SGD|AUD|THB)\b|美元|日圓|日幣|歐元|韓元|港幣|人民幣/

interface AmountHit {
  value: number | null
  /** Text just before the amount (currency marker included), used to tell a purchase from a threshold. */
  before: string
  /** Text just after the amount ("NT$50 以上" is a threshold). */
  after: string
}

/** Every NTD amount in the text: after a currency marker, or "1,234 元". */
function amountsOf(t: string): AmountHit[] {
  const hits: { at: number; end: number; hit: AmountHit }[] = []
  const add = (m: RegExpMatchArray, token: string) => {
    const at = m.index!
    if (hits.some((h) => at < h.end && at + m[0].length > h.at)) return
    hits.push({ at, end: at + m[0].length, hit: { value: parseAmount(token), before: t.slice(Math.max(0, at - 10), at), after: t.slice(at + m[0].length, at + m[0].length + 6) } })
  }
  for (const m of t.matchAll(new RegExp(NTD_RE.source + '\\s*[:：]?\\s*(-?[\\d,]+(?:\\.\\d+)?)', 'gi'))) add(m, m[m.length - 1])
  for (const m of t.matchAll(/(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.\d+)?\s*元/g)) add(m, m[1])
  return hits.sort((a, b) => a.at - b.at).map((h) => h.hit)
}

/**
 * Words directly in front of an amount that make it a threshold or a reward, not what was paid.
 * Anchored to the amount so shop names (達美樂, 每日優鮮) don't count.
 */
const NOT_PAID_BEFORE = /(?:滿|達到?|超過|最高|上限|回饋|折抵|贈送?|享有?|獲得|累積\S{0,3})\s*[:：]?\s*$/
/** Words directly in front of an amount that make it what was paid ("消費 NT$899", "交易金額：NT$500"). */
const PAID_BEFORE = /(?:消費|刷卡|交易|扣款|簽帳|授權|支付|付款|金額)\s*[:：]?\s*$/
const NOT_PAID_AFTER = /^\s*元?\s*(?:以上|起|即享|就送|即送|即贈)/
/** ...or directly followed by one ("NT$85 刷卡成功"). */
const PAID_AFTER = /^\s*元?\s*(?:消費|刷卡|交易|扣款|支付|付款|簽帳)/
const notPaid = (h: AmountHit) => NOT_PAID_BEFORE.test(h.before) || NOT_PAID_AFTER.test(h.after)

/** The amount that was paid: the first one introduced by a spending word, else the first non-threshold one. */
function amountOf(text: string): { amount: number | null; stated: boolean } {
  const hits = amountsOf(toHalfWidth(text)).filter((h) => h.value !== null)
  const paid = hits.find((h) => (PAID_BEFORE.test(h.before) || PAID_AFTER.test(h.after)) && !notPaid(h))
  if (paid) return { amount: paid.value, stated: true }
  const plain = hits.find((h) => !notPaid(h))
  return { amount: plain?.value ?? null, stated: false }
}

const MERCHANT_PATTERNS = [
  /(?:商店|特店|商家|店家|消費地點|交易商店|特約商店)\s*[:：]\s*([^\n，,。；;]+)/,
  /(?:於|在)\s*([^\n，,。；;]+?)\s*(?:消費|刷卡|交易|扣款|支付|付款)/,
  /(?:消費|交易)\s*[:：]\s*([^\n，,。；;]+?)\s*(?:NT\$|NTD|TWD|新[臺台]幣|台幣|\d)/i,
]

function cleanMerchant(s: string): string {
  return toHalfWidth(s)
    .replace(new RegExp(NTD_RE.source + '\\s*[\\d,]+(?:\\.\\d+)?', 'gi'), '')
    .replace(/\d{2,4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}\/\d{1,2}/g, '')
    .replace(/(上午|下午)?\s*\d{1,2}:\d{2}(:\d{2})?/g, '')
    .replace(/(您的|你的|台新|Richart|信用卡|簽帳金融卡|卡片|末四碼\d{4}|\*+\d{4})/gi, '')
    .replace(/^[\s:：,，-]+|[\s:：,，-]+$/g, '')
    .replace(/^.*?(?:於|在)\s*/, '') // "10/11 14:05在全家" → "全家"
    .trim()
}

function merchantOf(text: string): string {
  for (const re of MERCHANT_PATTERNS) {
    const m = toHalfWidth(text).match(re)
    if (m) {
      const name = cleanMerchant(m[1])
      if (name) return name.slice(0, 40)
    }
  }
  return ''
}

/** Purchase time: date/time printed in the text, else the notification time, else capture time. */
function timeOf(text: string, ref: string | null): string | null {
  const refDate = ref ? new Date(ref) : null
  const yearHint = (refDate ?? new Date()).getFullYear()
  const [ymd] = findDates(text, yearHint)
  if (!ymd) return ref
  const [y, m, d] = ymd.split('-').map(Number)
  const hm = findTime(text.replace(/\d{2,4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}\/\d{1,2}/g, ' '))
  let dt = new Date(y, m - 1, d, hm?.[0] ?? 12, hm?.[1] ?? 0)
  // "12/31" read in January belongs to last year.
  if (refDate && dt.getTime() - refDate.getTime() > 2 * 864e5) dt = new Date(y - 1, m - 1, d, hm?.[0] ?? 12, hm?.[1] ?? 0)
  return dt.toISOString()
}

export function parseNotification(c: NotificationCapture): ParseResult {
  const text = [c.title, c.subtitle, c.body].filter(Boolean).join('\n')
  for (const [re, reason] of NOT_SPENDING) if (re.test(text)) return { kind: 'not_spending', reason }
  const { amount, stated } = amountOf(text)
  // A purchase is "stated" when an amount is introduced by a spending word, or a non-threshold amount
  // comes with a named shop ("商店：X", "於 X 消費").
  if (!(stated || (amount !== null && merchantOf(text)))) for (const [re, reason] of UNLESS_PURCHASE) if (re.test(text)) return { kind: 'not_spending', reason }
  // The title is often generic ("刷卡通知") even for promotions, so judge by the message itself.
  const message = [c.subtitle, c.body].filter(Boolean).join('\n') || text
  if (!(SPENDING.test(message) && amount !== null)) {
    for (const [re, reason] of WEAK_NOT_SPENDING) if (re.test(text)) return { kind: 'not_spending', reason }
  }
  if (FOREIGN.test(text) && !NTD_RE.test(text)) return { kind: 'unparsed', reason: '外幣交易，請以帳單上的台幣金額記帳' }
  if (amount === null) return { kind: 'unparsed', reason: '找不到金額' }
  if (!SPENDING.test(text) && !NTD_RE.test(text)) return { kind: 'unparsed', reason: '看不出是不是刷卡消費' }
  if (amount <= 0) return { kind: 'unparsed', reason: '金額不正確' }
  return {
    kind: 'spend',
    adapter: /richart|台新/i.test(c.sourceApp) ? 'richart-generic' : 'generic',
    spend: {
      amount,
      merchant: merchantOf(text),
      occurredAt: timeOf(text, c.notificationTime ?? c.capturedAt),
      cardLast4: findLast4(text),
    },
  }
}
