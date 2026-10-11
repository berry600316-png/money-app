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
]
/** Wording that means "not a purchase" only when the text doesn't also look like one (footers often say 密碼, 優惠…). */
const WEAK_NOT_SPENDING: [RegExp, string][] = [
  [/電子帳單|帳單已|本期應繳|帳單通知/, '帳單通知'],
  [/驗證碼|OTP|登入|新裝置/i, '安全性通知'],
  [/優惠|活動|回饋|點數|紅利|抽獎|好禮/, '行銷或回饋通知'],
]
const SPENDING = /消費|刷卡|交易|扣款|簽帳|授權|支付|付款/
const FOREIGN = /\b(USD|JPY|EUR|GBP|KRW|HKD|CNY|SGD|AUD|THB)\b|美元|日圓|日幣|歐元|韓元|港幣|人民幣/

/** Amount right after a currency marker, or "1,234 元". */
function amountOf(text: string): number | null {
  const t = toHalfWidth(text)
  const m =
    t.match(new RegExp(NTD_RE.source + '\\s*[:：]?\\s*(-?[\\d,]+(?:\\.\\d+)?)', 'i')) ??
    t.match(/(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.\d+)?\s*元/)
  if (!m) return null
  return parseAmount(m[m.length - 1])
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
  const amount = amountOf(text)
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
