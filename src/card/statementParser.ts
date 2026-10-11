/*
 * Statement parsing, layer 2 (D-87): text lines → statement info + entries.
 * Layer 1 (PDF → lines) lives in ./pdf/extract.ts and knows nothing about banks.
 *
 * Only a GENERIC adapter exists: no real 台新 statement has been provided, so we do not guess fixed
 * column positions. It reads any line that has a date and an amount, classifies it by wording, and
 * the result is always "needs review" unless the totals check out.
 */
import type { EntryKind } from '../db/types'
import { dayDiff, findDates, findLast4, parseAmount, toHalfWidth } from './text'

export interface DraftEntry {
  txDate: string | null
  postDate: string | null
  merchant: string
  amount: number
  currency: string
  foreign: string | null
  reference: string | null
  kind: EntryKind
  raw: string
}

export interface ParsedStatement {
  adapter: string
  bank: string | null
  cardLast4: string | null
  closingDate: string | null
  dueDate: string | null
  periodStart: string | null
  periodEnd: string | null
  entries: DraftEntry[]
  /** The statement's own "new charges this period" figure, if printed. */
  declaredNewCharges: number | null
  /** True only when the parsed entries add up to the declared figure. */
  totalsMatch: boolean | null
  warnings: string[]
  /** Lines that contained a date or amount but could not be read as an entry or a heading. */
  unreadLines: string[]
}

const BANKS = ['台新', '國泰世華', '國泰', '中國信託', '中信', '玉山', '台北富邦', '富邦', '永豐', '聯邦', '第一銀行', '兆豐', '花旗', '星展', '滙豐', '新光', '元大', '凱基', '遠東', '華南', '彰化', '合作金庫', '土地銀行', '樂天', '將來', 'LINE Bank', '連線銀行']

/** Summary / heading lines: never entries. */
const NOT_ENTRY =
  /合計|小計|總計|總額|應繳|應付|本期新增|本期帳單|帳單金額|前期|上期|循環|額度|餘額|帳單結帳日|結帳日|繳款截止|繳款期限|繳款日|到期日|帳單日期|帳單週期|帳務期間|計息期間|消費期間|列印日期|頁\s*\d|第\s*\d+\s*頁|利率|紅利點數|帳號|戶名|統一編號|筆\s*數|件\s*數/
/** A line ending in a date: its "tail amount" would really be the day of month. */
const ENDS_WITH_DATE = /(\d{1,2}\s*月\s*\d{1,2}\s*日|\d{2,4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{3,4}[/.-]\d{1,2}[/.-]\d{1,2}|(?<![\d,])\d{1,2}\/\d{1,2})\s*$/

const KIND_RULES: [RegExp, EntryKind][] = [
  [/繳款|自動扣繳|轉帳繳|已繳|感謝您|ATM繳/, 'payment'],
  [/退款|退貨|退刷|刷退|折讓|取消/, 'refund'],
  [/分期|期數|第\s*\d+\s*\/\s*\d+\s*期|第\s*\d+\s*期/, 'installment'],
  [/手續費|年費|服務費|國外交易服務費|海外交易手續費|利息|違約金|滯納/, 'fee'],
  [/調整|回饋|折抵|紅利|優惠折|現金回饋|帳務調整/, 'adjustment'],
]

/** Currency codes and words that mean "not NTD". Upper case only: banks print codes in capitals. */
const CURRENCY =
  '(?:\\b(?:USD|JPY|EUR|GBP|KRW|HKD|CNY|RMB|SGD|AUD|NZD|THB|CAD|CHF|MYR|VND|PHP|IDR|INR|MOP|SEK|NOK|DKK|AED|TRY|MXN|BRL|ZAR|US)\\b|美金|美元|日圓|日元|日幣|人民幣|歐元|韓元|韓圜|港幣|港元|英鎊|澳幣|紐幣|新幣|泰銖|越南盾|外幣)'
const FOREIGN_RE = new RegExp(CURRENCY + '\\s*-?[\\d,]+(?:\\.\\d+)?')
/** A foreign currency right before the tail amount: that amount is the foreign one. */
const CURRENCY_BEFORE_TAIL = new RegExp(CURRENCY + '\\s*[:：]?\\s*$')
/** Amount at the end of the line, allowing "1,234", "-1,234", "(1,234)", "1,234-", "1,234.00". Never part of a longer number. */
const TAIL_AMOUNT = /(?<![\d.,])(\(?-?[\d]{1,3}(?:,\d{3})+(?:\.\d{1,2})?\)?-?|\(?-?\d+(?:\.\d{1,2})?\)?-?)\s*(?:元|TWD|NTD)?\s*$/i
/** Card digits right before the tail: "尾號1234" — the tail is not an amount. */
const CARD_BEFORE_TAIL = /(?:尾\s*[數号號]|末\s*[四4]\s*碼|卡\s*號|[*xX•●]{2,})\s*[:：-]?\s*$/
/** Another number right before the tail: two amount columns, or "1 234" split by a space. */
const NUMBER_BEFORE_TAIL = /(?:^|\s)\(?-?\d[\d,]*(?:\.\d+)?\)?-?\s*$/
/** Date-looking text the reader does not support (26/10/05, 20261005, 10-05, 10.05): never guessed. */
const UNSUPPORTED_DATE =
  /(?<!\d)\d{2}\/\d{1,2}\/\d{1,2}(?!\d)|(?<!\d)(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)|(?<![\d/.,-])\d{1,2}[-.]\d{1,2}(?![\d/.-])/
/** A guessed year (month/day printed without one) further than this from the cycle start gets a warning. */
const FAR_FROM_CYCLE_DAYS = 62

function signed(token: string): number | null {
  const neg = /^\(.*\)$/.test(token) || token.startsWith('-') || token.endsWith('-')
  const n = parseAmount(token.replace(/[()]/g, '').replace(/-$/, ''))
  if (n === null) return null
  return neg ? -Math.abs(n) : n
}

function findLabeledDate(text: string, label: RegExp, yearHint?: number): string | null {
  for (const line of text.split('\n')) {
    if (label.test(line)) {
      const after = line.slice(line.search(label))
      const [d] = findDates(after, yearHint)
      if (d) return d
    }
  }
  return null
}

function findLabeledAmount(text: string, label: RegExp): number | null {
  for (const line of text.split('\n')) {
    const i = line.search(label)
    if (i >= 0) {
      const m = toHalfWidth(line.slice(i)).match(/-?[\d]{1,3}(?:,\d{3})+|-?\d+/g)
      if (m) return parseAmount(m[m.length - 1])
    }
  }
  return null
}

function classify(merchant: string, amount: number): EntryKind {
  for (const [re, kind] of KIND_RULES) if (re.test(merchant)) return kind
  return amount < 0 ? 'refund' : 'purchase'
}

export function parseStatementLines(lines: readonly string[]): ParsedStatement {
  const text = lines.map((l) => toHalfWidth(l)).join('\n')
  const warnings: string[] = []

  const bank = BANKS.find((b) => text.includes(b)) ?? null
  const cardLast4 = findLast4(text)
  // Year hint for "MM/DD" entries: from the first full date in the document.
  const firstFull = findDates(text)[0]
  const yearHint = firstFull ? Number(firstFull.slice(0, 4)) : undefined
  const closingDate = findLabeledDate(text, /結帳日|帳單日/, yearHint)
  const dueDate = findLabeledDate(text, /繳款截止|繳款期限|最後繳款日/, yearHint)
  let periodStart: string | null = null
  let periodEnd: string | null = null
  for (const line of text.split('\n')) {
    if (/帳單週期|帳務期間|計息期間|消費期間/.test(line)) {
      const ds = findDates(line, yearHint)
      if (ds.length >= 2) {
        periodStart = ds[0]
        periodEnd = ds[1]
        break
      }
    }
  }
  if (!periodEnd && closingDate) periodEnd = closingDate

  const closingYear = closingDate ? Number(closingDate.slice(0, 4)) : yearHint
  const entries: DraftEntry[] = []
  const unreadLines: string[] = []
  const singleDate: string[] = []
  const farGuess: { raw: string; date: string }[] = []
  for (const original of lines) {
    const line = toHalfWidth(original).trim()
    if (!line) continue
    if (NOT_ENTRY.test(line)) continue
    const dates = findDates(line, closingYear)
    const tail = line.match(TAIL_AMOUNT)
    if (!dates.length || !tail || ENDS_WITH_DATE.test(line)) {
      if (dates.length || (tail && (/,\d{3}/.test(tail[1]) || UNSUPPORTED_DATE.test(line)))) unreadLines.push(original)
      continue
    }
    // Never guess: cents in a TWD column, a foreign amount printed last, card digits, or two numbers at
    // the end of the line all leave the TWD amount unclear.
    const head = line.slice(0, tail.index)
    const foreignMatch = line.match(FOREIGN_RE)
    const foreignEnd = foreignMatch ? foreignMatch.index! + foreignMatch[0].length : -1
    const cents = tail[1].match(/\.(\d{1,2})/)
    const twoNumbers = NUMBER_BEFORE_TAIL.test(head) && foreignEnd !== head.trimEnd().length
    if (
      (cents && Number(cents[1]) !== 0) ||
      (foreignMatch && foreignEnd >= tail.index!) ||
      CURRENCY_BEFORE_TAIL.test(head) ||
      CARD_BEFORE_TAIL.test(head) ||
      twoNumbers
    ) {
      unreadLines.push(original)
      continue
    }
    let amount = signed(tail[1])
    if (amount === null || amount === 0) {
      unreadLines.push(original)
      continue
    }
    // Only "MM/DD" dates (no year printed) may belong to last year in a January statement;
    // dates printed with a year are taken exactly as printed.
    const printedWithYear = new Set(findDates(line))
    const fix = (d: string) => (!printedWithYear.has(d) && closingDate && d > closingDate ? `${Number(d.slice(0, 4)) - 1}${d.slice(4)}` : d)
    const txDate = fix(dates[0])
    const postDate = dates[1] ? fix(dates[1]) : null
    if (!dates[1]) singleDate.push(original)
    const cycleStart = periodStart ?? closingDate
    for (const d of [txDate, postDate]) {
      if (d && cycleStart && !printedWithYear.has(d) && dayDiff(d, cycleStart) > FAR_FROM_CYCLE_DAYS) {
        farGuess.push({ raw: original.trim(), date: d })
        break
      }
    }
    const foreign = foreignMatch?.[0] ?? null
    let merchant = head
      .replace(/(?:尾\s*[數号號]|末\s*[四4]\s*碼)\s*[:：]?\s*\d{4}/g, ' ')
      .replace(/(?:\d{2,4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日|\d{2,4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{3,4}[/.-]\d{1,2}[/.-]\d{1,2}|(?<![\d/])\d{1,2}\/\d{1,2}(?![\d/])/g, ' ')
    if (foreign) merchant = merchant.replace(foreign, ' ')
    const reference = merchant.match(/\b[A-Z0-9]{10,}\b/)?.[0] ?? null
    if (reference) merchant = merchant.replace(reference, ' ')
    merchant = merchant.replace(/\s{2,}/g, ' ').replace(/^[\s|:：-]+|[\s|:：-]+$/g, '').trim()
    const kind = classify(merchant, amount)
    if (kind === 'payment' || kind === 'refund') amount = -Math.abs(amount)
    entries.push({ txDate, postDate, merchant: merchant || '（未辨識）', amount, currency: 'TWD', foreign, reference, kind, raw: original })
  }

  // Sanity checks (spec §6.4). The amount due includes earlier balances etc., so we only compare
  // with a printed "new charges" figure when there is one.
  if (!entries.length) warnings.push('沒有讀到任何交易明細')
  const seen = new Map<string, number>()
  for (const e of entries) seen.set(e.raw.trim(), (seen.get(e.raw.trim()) ?? 0) + 1)
  const repeated = [...seen.values()].filter((n) => n > 1).length
  if (repeated) warnings.push(`有 ${repeated} 行內容完全相同，請確認不是重複讀取（也可能真的是兩筆）`)
  if (singleDate.length)
    warnings.push(
      singleDate.length === entries.length
        ? '每筆明細只讀到一個日期，已當作消費日；如果帳單印的是入帳日，請逐筆修正'
        : `有 ${singleDate.length} 筆明細只讀到一個日期，已當作消費日，請確認（例：「${singleDate[0].trim()}」）`,
    )
  if (farGuess.length)
    warnings.push(
      `有 ${farGuess.length} 筆日期沒印年份，推算後離帳單週期超過兩個月，請確認年份（例：「${farGuess[0].raw}」→ ${farGuess[0].date}）`,
    )
  if (unreadLines.length) warnings.push(`有 ${unreadLines.length} 行含日期或金額但無法辨識，可能是漏掉的明細`)
  if (!closingDate) warnings.push('找不到結帳日')
  const declaredNewCharges = findLabeledAmount(text, /本期新增款項|本期新增|本期消費金額|本期消費/)
  const charges = entries.filter((e) => e.kind !== 'payment').reduce((s, e) => s + e.amount, 0)
  const totalsMatch = declaredNewCharges === null ? null : declaredNewCharges === charges
  if (totalsMatch === false) warnings.push(`明細加總 ${charges.toLocaleString('en-US')} 與帳單「本期新增」${declaredNewCharges!.toLocaleString('en-US')} 不同`)
  if (totalsMatch === null) warnings.push('帳單上找不到「本期新增款項」可以比對，無法自動確認明細是否完整')

  return {
    adapter: 'generic',
    bank,
    cardLast4,
    closingDate,
    dueDate,
    periodStart,
    periodEnd,
    entries,
    declaredNewCharges,
    totalsMatch,
    warnings,
    unreadLines,
  }
}
