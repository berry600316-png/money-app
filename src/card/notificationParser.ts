/*
 * Parsing of card notifications (D-82, D-97). Kept apart from the UI.
 *
 * 1. A bank adapter built from real samples (./notificationAdapters.ts) is tried first; a matching
 *    template is trusted.
 * 2. D-128: anything else is NOT imported. The GENERIC rules below (best guesses from keywords) are
 *    switched off by GENERIC_GUESSING and kept only for when the user turns them back on; with real money
 *    at stake a correct record beats an automatic one.
 *
 * IMPORTANT: the generic rules were only ever tested against simulated wording.
 */
import type { ParsedSpend } from '../db/types'
import type { NotificationCapture } from './notificationFile'
import { adapterFor, matchTemplate, NOTIFICATION_ADAPTERS, type NotificationAdapter } from './notificationAdapters'
import { purchaseTime } from './purchaseTime'
import { findLast4, findTime, NTD_RE, parseAmount, toHalfWidth } from './text'

export type ParseResult =
  /** `doubt`: looks like a purchase but also reads like an offer or a code; not imported by default. */
  /** `bank`: from the adapter, null for generic guesses. `channel`: the 行動支付 it went through (D-130). */
  | { kind: 'spend'; spend: ParsedSpend; adapter: string; bank: string | null; doubt: string | null; channel?: { label: string; name: RegExp } }
  | { kind: 'not_spending'; reason: string }
  | { kind: 'unparsed'; reason: string }

/*
 * POLICY (D-96). Wording alone cannot tell "刷卡消費 NT$3,000 享 5% 回饋" (an offer) from
 * "消費 NT$85 享 NT$5 回饋" (a purchase), and no real Richart sample exists yet. So:
 *   - only a message with the full shape of a purchase notice (spending word + amount, shop, card digits
 *     or a time) and nothing else in it is imported by default;
 *   - a purchase-looking message that also reads like an offer, a code, a refund… is a spend with `doubt`
 *     (shown as "需要你確認", not ticked);
 *   - an amount followed by offer wording is never guessed: "unparsed", the user records it by hand.
 */

/** Words for one-time codes. */
const CODE_WORD = /驗證碼|OTP|動態密碼|一次性密碼|認證碼|簡訊密碼|交易密碼|驗證密碼|安全碼|確認碼|授權碼|密碼/i
/** A code standing apart ("驗證碼為 123456"); "OTP2024 選物店" is a shop and "0800-123-456" a phone number. */
const CODE_WITH_DIGITS = new RegExp(`(?:${CODE_WORD.source})(?:\\s*(?:為|是)?\\s*[:：]\\s*|\\s*(?:為|是)\\s*|\\s+)\\d{4,8}(?![\\d-])`, 'i')

/** Never a new purchase, whatever else the message says. */
const ALWAYS_NOT_SPENDING: [RegExp, string][] = [
  [/繳款成功|已繳款|繳款通知/, '繳款通知'],
  [/將於.{0,12}扣款|帳單金額|應繳金額|本期應繳|電子帳單|帳單通知|帳單已/, '帳單或扣款通知'],
]
/** Not a purchase, unless the message also states one; then it is a purchase the user must confirm. */
const NOT_SPENDING: [RegExp, string][] = [
  [/退款|退貨|退刷|刷退/, '退款'],
  [/取消交易|交易取消|已取消|撤銷|沖正/, '取消交易'],
  [/入帳成功/, '入帳'],
  [/失敗|拒絕|未成功|不成功|未獲核准|未核准|婉拒|額度不足/, '交易失敗'],
  // Paying a bill by card can be a real charge ("在中華電信自動扣款 1,299"), so these are not absolute.
  [/自動扣款|自動扣繳|繳費成功/, '代繳或扣款'],
  [CODE_WITH_DIGITS, '驗證碼'],
]
/** Offer wording: "not a purchase" when no purchase is stated. */
const OFFER =
  /(?:滿|達|累積)\s*(?:NT\$|新?[臺台]幣)?\s*[\d,]+\s*元?.{0,12}(?:享|送|贈|回饋|折)|享\s*\d+(?:\.\d+)?\s*%|登錄|抽獎|刷卡金|購物金|回饋|優惠|活動|好禮|加碼|兌換|首刷/
/** Wording that means "not a purchase" only when the text doesn't also look like one. */
const WEAK_NOT_SPENDING: [RegExp, string][] = [
  [/登入|新裝置/i, '安全性通知'],
  [/點數|紅利/, '行銷或回饋通知'],
]
/** Offer or code wording anywhere: a purchase that mentions these is never imported without a look. */
const DOUBT = new RegExp(
  `${CODE_WORD.source}|回饋|優惠|活動|登錄|抽獎|贈|購物金|刷卡金|點數|紅利|折|滿額|利率|好禮|(?<!外)送|加碼|兌換|限定|首刷|分期|以上|現賺|賺|抵用券|好康|現折`,
  'i',
)
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
    hits.push({ at, end: at + m[0].length, hit: { value: parseAmount(token), before: t.slice(Math.max(0, at - 10), at), after: t.slice(at + m[0].length, at + m[0].length + 8) } })
  }
  for (const m of t.matchAll(new RegExp(NTD_RE.source + '\\s*[:：]?\\s*(-?\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|-?\\d+(?:\\.\\d+)?)', 'gi'))) add(m, m[m.length - 1])
  for (const m of t.matchAll(/(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.\d+)?\s*元/g)) add(m, m[1])
  return hits.sort((a, b) => a.at - b.at).map((h) => h.hit)
}

/**
 * Words directly in front of an amount that make it a threshold or a reward, not what was paid.
 * Anchored to the amount so shop names (達美樂, 每日優鮮) don't count.
 */
const NOT_PAID_BEFORE = /(?:滿額?|達到?|超過|最高|上限|回饋金?|折抵?|贈送?|送|享有?|獲得|加碼|現賺|賺|拿|得|現折|刷卡金|購物金|累積\S{0,3})\s*[:：]?\s*$/
/** Words directly in front of an amount that make it what was paid ("消費 NT$899", "交易金額：NT$500"). */
const PAID_BEFORE = /(?:消費|刷卡|交易|扣款|簽帳|授權|支付|付款|金額|繳納|費)\s*[:：]?\s*$/
/** ...or directly after it ("NT$85 刷卡成功"). */
const PAID_AFTER = /^\s*元?\s*(?:消費|刷卡|交易|扣款|支付|付款|簽帳)/
/** Offer wording right after an amount: it may be a threshold ("消費 NT$3,000 享 5% 回饋"), so never guessed. */
const OFFER_AFTER =
  /^\s*元?\s*(?:\(含\)\s*)?(?:以上|起|即|就|可|再|享|送|贈|加贈|回饋|參加|抽|折|現折|現賺|賺|拿|兌換|加碼|分\s*\d+\s*期)|^\s*元?\s*[,、]\s*(?:\(含\)\s*)?(?:以上|即|就|可|再|享|回饋|送|贈|加贈|兌換|加碼|現折|現賺|折|賺|拿|得)/

/** The amount that was paid: the first one introduced by a spending word, else the first plain one. */
function amountOf(text: string): { amount: number | null; stated: boolean; offerNext: boolean } {
  const hits = amountsOf(toHalfWidth(text)).filter((h) => h.value !== null)
  const paid = hits.find((h) => (PAID_BEFORE.test(h.before) || PAID_AFTER.test(h.after)) && !NOT_PAID_BEFORE.test(h.before))
  if (paid) return { amount: paid.value, stated: true, offerNext: OFFER_AFTER.test(paid.after) }
  const plain = hits.find((h) => !NOT_PAID_BEFORE.test(h.before) && !OFFER_AFTER.test(h.after))
  return { amount: plain?.value ?? null, stated: false, offerNext: false }
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

/** The generic best guess (no bank adapter). */
function parseGeneric(c: NotificationCapture): ParseResult {
  const text = toHalfWidth([c.title, c.subtitle, c.body].filter(Boolean).join('\n'))
  for (const [re, reason] of ALWAYS_NOT_SPENDING) if (re.test(text)) return { kind: 'not_spending', reason }
  const { amount, stated, offerNext } = amountOf(text)
  const strong = NOT_SPENDING.find(([re]) => re.test(text))
  if (!stated) {
    if (strong) return { kind: 'not_spending', reason: strong[1] === '驗證碼' ? '安全性通知' : `${strong[1]}通知` }
    if (OFFER.test(text)) return { kind: 'not_spending', reason: '行銷或回饋通知' }
    if (CODE_WORD.test(text)) return { kind: 'not_spending', reason: '安全性通知' }
  }
  // The title is often generic ("刷卡通知") even for promotions, so judge by the message itself.
  const message = toHalfWidth([c.subtitle, c.body].filter(Boolean).join('\n')) || text
  if (!(SPENDING.test(message) && amount !== null)) {
    for (const [re, reason] of WEAK_NOT_SPENDING) if (re.test(text)) return { kind: 'not_spending', reason }
  }
  if (FOREIGN.test(text) && !NTD_RE.test(text)) return { kind: 'unparsed', reason: '外幣交易，請以帳單上的台幣金額記帳' }
  if (amount === null) return { kind: 'unparsed', reason: '找不到金額' }
  if (offerNext) return { kind: 'unparsed', reason: '金額後面接著優惠字樣，分不出是消費金額還是活動門檻，請自行記帳' }
  if (!SPENDING.test(text) && !NTD_RE.test(text)) return { kind: 'unparsed', reason: '看不出是不是刷卡消費' }
  if (amount <= 0) return { kind: 'unparsed', reason: '金額不正確' }
  const merchant = merchantOf(text)
  const cardLast4 = findLast4(text)
  const fullShape = stated && !!merchant && (!!cardLast4 || findTime(text) !== null)
  const doubt = strong
    ? `內容也提到「${strong[1]}」，請確認是不是一筆消費`
    : DOUBT.test(text)
      ? '內容同時提到回饋、優惠或驗證碼，請確認是不是一筆消費'
      : !fullShape
        ? '通知裡缺少商店、卡號末四碼或時間，請確認是不是一筆消費'
        : null
  return {
    kind: 'spend',
    adapter: 'generic',
    bank: null,
    doubt,
    spend: {
      amount,
      merchant,
      ...purchaseTime(text, c),
      cardLast4,
    },
  }
}

/**
 * D-128: guessing purchases from unknown wording is off. Only notifications matching a verified adapter
 * template become records; everything else is listed as 「不匯入」 with the reason.
 */
export const GENERIC_GUESSING = false

export function parseNotification(
  c: NotificationCapture,
  adapters: readonly NotificationAdapter[] = NOTIFICATION_ADAPTERS,
  opts: { generic?: boolean } = {},
): ParseResult {
  const adapter = adapterFor(c, adapters)
  if (adapter) {
    const m = matchTemplate(c, adapter)
    if (m?.kind === 'not_spending') return { kind: 'not_spending', reason: m.reason }
    if (m?.kind === 'spend') {
      return {
        kind: 'spend',
        adapter: adapter.id,
        bank: adapter.bank || null,
        doubt: null,
        ...(adapter.channel ? { channel: adapter.channel } : {}),
        spend: { amount: m.amount, merchant: m.merchant, occurredAt: m.occurredAt, cardLast4: m.last4, ...(m.timeSource ? { timeSource: m.timeSource } : {}) },
      }
    }
  }
  if (!(opts.generic ?? GENERIC_GUESSING)) {
    return {
      kind: 'unparsed',
      reason: adapter?.channel
        ? `這則「${c.sourceApp}」通知不是 ${adapter.channel.label} 付款完成的通知，不會匯入`
        : adapter
          ? `這則「${c.sourceApp}」通知的寫法和已建立的格式不同，不會匯入`
          : `目前只會匯入 LINE Pay 付款通知，「${c.sourceApp}」的通知請自己記帳`,
    }
  }
  const r = parseGeneric(c)
  if (r.kind !== 'spend') return r
  // A generic guess is never imported without a look (D-97).
  const why = adapter
    ? `這則「${c.sourceApp}」通知的寫法和已建立的格式不同（可能是銀行改版），金額和商店是推測的`
    : `還沒建立「${c.sourceApp}」的通知格式，金額和商店是推測的`
  return { ...r, bank: adapter?.bank ?? null, doubt: r.doubt ? `${why}；${r.doubt}` : `${why}，請確認` }
}
