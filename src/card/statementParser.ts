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
  /合計|小計|總計|總額|應繳|應付|本期新增|本期帳單|帳單金額|前期|上期|循環|額度|餘額|帳單結帳日|結帳日|繳款截止|繳款期限|繳款日|截止|到期日|帳單日期|帳單週期|帳務期間|計息期間|消費期間|列印日期|頁\s*\d|第\s*\d+\s*頁|利率|紅利點數|帳號|戶名|統一編號|卡\s*號|筆\s*數|件\s*數|次\s*數/

const KIND_RULES: [RegExp, EntryKind][] = [
  [/繳款|自動扣繳|轉帳繳|已繳|感謝您|ATM繳/, 'payment'],
  [/退款|退貨|退刷|刷退|折讓|取消/, 'refund'],
  [/分期|期數|第\s*\d+\s*\/\s*\d+\s*期|第\s*\d+\s*期/, 'installment'],
  [/手續費|年費|服務費|國外交易服務費|海外交易手續費|利息|違約金|滯納/, 'fee'],
  [/調整|回饋|折抵|紅利|優惠折|現金回饋|帳務調整/, 'adjustment'],
]

/*
 * STRICT LINE GRAMMAR (D-96). Without a real 台新 sample we cannot know the columns, so we only read
 * lines shaped exactly like
 *     <date> [<date>] <description> <one TWD amount>
 * and only when nothing in the description could be another amount, a currency or card digits.
 * Every other line that looks like it could be an entry goes to "unread" for the user to see.
 * A wrong guess is worse than an unread line.
 */
const DATE_TOKEN = String.raw`\d{4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{3}[/.-]\d{1,2}[/.-]\d{1,2}|\d{2,4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\/\d{1,2}`
const AMOUNT_TOKEN = String.raw`\(?-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\)?-?|\(?-?\d+(?:\.\d{1,2})?\)?-?`
const ENTRY_LINE = new RegExp(
  String.raw`^(${DATE_TOKEN})(?![\d/.-])\s*(?:(${DATE_TOKEN})(?![\d/.-])\s*)?(.*?)(?<![\d.,:/$¥€£₩₫฿₱₹*A-Za-z])(${AMOUNT_TOKEN})\s*(?:元|TWD|NTD)?$`,
  'i',
)
/** Dates printed without a year ("10/05", "10月5日"): the year is our guess. */
const NO_YEAR = /^(?:\d{1,2}\/\d{1,2}|\d{1,2}\s*月)/
/** Text that looks like a date in a form we do not read (26/10/05, 20261005, 10-05, 10.05, OCT05, 10 / 05). */
const DATE_ISH =
  /(?<!\d)\d{1,2}\s*[/.-]\s*\d{1,2}(?!\d)|\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s*\d{1,2}(?!\d)|(?<!\d)(?:19|20)\d{6}(?!\d)|(?<!\d)\d{1,2}\s*月/i
/** A guessed year further than this before the cycle start gets a warning. */
const FAR_FROM_CYCLE_DAYS = 62
/** Any line ending in a number (an entry whose date we could not read, or a wrapped line). */
const TAIL_NUMBER = /(?<![\d.,:/*A-Za-z])\(?-?\d[\d,]*(?:\.\d+)?\)?-?\s*(?:元|TWD|NTD)?$/i

/** ISO 4217 codes (common English words such as ALL/TOP/CUP left out) plus US and RMB. */
const CURRENCY_CODES = new Set(
  ('AED AFN AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BRL BSD BTN BWP BYN BZD CAD CDF CHF ' +
    'CLP CNY COP CRC CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GHS GIP GMD GNF GTQ GYD HKD HNL HTG ' +
    'HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MDL ' +
    'MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PGK PHP PKR PLN PYG QAR ' +
    'RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SRD SSP STN SYP SZL THB TJS TMT TND TRY TTD TZS UAH UGX ' +
    'USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL US RMB').split(' '),
)
/** Codes also recognised when printed in lower or mixed case ("usd"). */
const COMMON_CODES = new Set('USD JPY EUR GBP KRW HKD CNY RMB SGD AUD NZD THB CAD CHF MYR VND PHP IDR INR MOP US'.split(' '))
const TWD_WORD = /^(?:NT\$|NTD|TWD|新?[臺台]幣)$/i
const CJK_CURRENCY = /^(?:外幣|美金|.{0,4}幣|[美日港澳紐加星新坡韓歐]元|日圓|韓圜|英鎊|泰銖|越南盾|.{0,3}(?:披索|比索|法郎|盧比|里拉|令吉|克朗|盧布|蘭特|第納爾|里亞爾|茲羅提))$/
const CURRENCY_SYMBOL = /[$¥€£₩₫฿₱₹]/
/** Card digits label at the end of the description: the "amount" after it is the card number. */
const CARD_LABEL_END = /(?:卡\s*末|[末後尾]\s*[四4]\s*碼|尾\s*[數号號]|卡\s*號)\s*[:：-]?$/

function isNumberToken(t: string): boolean {
  const u = t.replace(/^(?:NT\$|NTD|TWD)/i, '').replace(/(?:元|TWD|NTD)$/i, '')
  return /^\(?[-+]?\d[\d,]*(?:\.\d+)?\)?-?$/.test(u)
}

function isCurrencyToken(t: string): boolean {
  const u = t.replace(/[:：]$/, '')
  if (TWD_WORD.test(u)) return false
  if (/^[A-Z]{3}$/.test(u)) return CURRENCY_CODES.has(u)
  if (/^[a-zA-Z]{2,3}$/.test(u)) return COMMON_CODES.has(u.toUpperCase())
  if (CURRENCY_SYMBOL.test(u) && !/^NT\$/i.test(u)) return true
  return CJK_CURRENCY.test(u)
}

/** "US$32.00", "¥3,200", "USD32.00": a foreign amount in one token. */
function isGluedForeign(t: string): boolean {
  if (/^NT\$/i.test(t)) return false
  const m = t.match(/^(\D+?)[:：]?-?[\d,]+(?:\.\d+)?$/)
  return !!m && (CURRENCY_SYMBOL.test(m[1]) || isCurrencyToken(m[1])) // "日圓3,200" too
}

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

  // Month/day entries take their year from the end of the cycle (closing date, else the printed cycle end).
  const cycleEndForYear = closingDate ?? periodEnd
  const closingYear = cycleEndForYear ? Number(cycleEndForYear.slice(0, 4)) : yearHint
  const cycleStart = periodStart ?? closingDate
  const cycleEnd = closingDate ?? periodEnd
  const entries: DraftEntry[] = []
  const unreadLines: string[] = []
  const singleDate: string[] = []
  const outOfCycle: { raw: string; date: string }[] = []
  for (const original of lines) {
    // Minus signs PDFs use instead of "-" (−, –, —, ﹣).
    const line = toHalfWidth(original).replace(/[−–—﹣]/g, '-').trim()
    if (!line) continue
    const m = line.match(ENTRY_LINE)
    const unread = () => unreadLines.push(original)
    if (NOT_ENTRY.test(line)) {
      // A heading word in an entry-shaped line ("10/05 10/05 循環信用利息 235") is shown, not dropped.
      if (m) unread()
      continue
    }
    if (!m) {
      // Not an entry shape. Anything that could still be one is shown as unread, never dropped silently.
      if (findDates(line, closingYear).length || DATE_ISH.test(line) || TAIL_NUMBER.test(line)) unread()
      continue
    }
    const [, dateA, dateB, middle, amountToken] = m
    const parsedA = findDates(dateA, closingYear)[0]
    const parsedB = dateB ? findDates(dateB, closingYear)[0] : null
    if (!parsedA || (dateB && !parsedB)) {
      unread()
      continue
    }
    // The description: a foreign amount may stand at its end ("AMAZON NZD 32.00", "US$32.00").
    let tokens = middle.trim().split(/\s+/).filter(Boolean)
    let foreign: string | null = null
    const last = tokens[tokens.length - 1]
    const prev = tokens[tokens.length - 2]
    if (last && prev && isNumberToken(last) && isCurrencyToken(prev)) {
      foreign = `${prev} ${last}`
      tokens = tokens.slice(0, -2)
    } else if (last && isGluedForeign(last)) {
      foreign = last
      tokens = tokens.slice(0, -1)
    }
    while (tokens.length && TWD_WORD.test(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1) // "全家 NT$ 85"
    const description = tokens.join(' ')
    const cents = amountToken.match(/\.(\d{1,2})/)
    if (
      (cents && Number(cents[1]) !== 0) || // cents in a TWD column
      tokens.some(isNumberToken) || // another amount column, or "1 234"
      tokens.some((t) => /^[-+]$/.test(t)) || // a sign printed apart from the amount ("- 365")
      tokens.some((t) => isCurrencyToken(t) || isGluedForeign(t) || (CURRENCY_SYMBOL.test(t) && !/^NT\$/i.test(t))) || // foreign amount elsewhere
      CARD_LABEL_END.test(description) // "尾號 1234"
    ) {
      unread()
      continue
    }
    let amount = signed(amountToken)
    if (amount === null || amount === 0) {
      unread()
      continue
    }
    // Month/day dates may belong to last year in a January statement; dates printed with a year stay as printed.
    const fix = (token: string, d: string) =>
      NO_YEAR.test(token) && cycleEndForYear && d > cycleEndForYear ? `${Number(d.slice(0, 4)) - 1}${d.slice(4)}` : d
    const txDate = fix(dateA, parsedA)
    const postDate = dateB && parsedB ? fix(dateB, parsedB) : null
    if (!postDate) singleDate.push(original)
    for (const [token, d] of [[dateA, txDate], [dateB, postDate]] as const) {
      if (!token || !d) continue
      const after = cycleEnd && d > cycleEnd
      const farGuess = NO_YEAR.test(token) && cycleStart && dayDiff(d, cycleStart) > FAR_FROM_CYCLE_DAYS
      if (after || farGuess) {
        outOfCycle.push({ raw: original.trim(), date: d })
        break
      }
    }
    let merchant = description.replace(/(?:[末後尾]\s*[四4]\s*碼|尾\s*[數号號])\s*[:：]?\s*\d{4}/g, ' ')
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
  if (outOfCycle.length)
    warnings.push(
      `有 ${outOfCycle.length} 筆日期落在帳單週期之後，或沒印年份且推算後離週期超過兩個月，請確認（例：「${outOfCycle[0].raw}」→ ${outOfCycle[0].date}）`,
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
