/** The 台新簽帳金融卡 PDF has two transaction tables in one document. */
import { toHalfWidth } from './text'

export type DebitEvidence = 'card' | 'account' | 'both'
export type DebitKind = 'purchase' | 'refund' | 'withdrawal' | 'deposit' | 'transfer_out' | 'fee'

export interface DebitEntry {
  txDate: string | null
  postDate: string | null
  merchant: string
  amount: number
  kind: DebitKind
  evidence: DebitEvidence
  raw: string
}

export interface ParsedDebitStatement {
  periodStart: string | null
  periodEnd: string | null
  cardLast4: string | null
  entries: DebitEntry[]
  pendingCount: number
  cardTotalsMatch: boolean | null
  unreadLines: string[]
  warnings: string[]
}

const DATE = String.raw`\d{4}[/.-]\d{1,2}[/.-]\d{1,2}`
const CARD_ROW = new RegExp(String.raw`^(${DATE})\s+(${DATE})\s*(.*?)\s+0\s+(-?[\d,]+)(?:\s+.*)?$`)
const ACCOUNT_ROW = new RegExp(String.raw`^(${DATE})\s+(.+?)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)(?:\s+(.+))?$`)
const date = (value: string): string => value.replace(/[/.]/g, '-').split('-').map((part, i) => i ? part.padStart(2, '0') : part).join('-')
const money = (value: string): number => Number(value.replace(/,/g, ''))
const cleanedMerchant = (value: string): string => value.replace(/\s*\/\s*TW\b/g, ' ').replace(/\s+/g, ' ').trim()

export function isTaishinDebit(lines: readonly string[]): boolean {
  const text = lines.join('\n')
  return /對帳單期間/.test(text) && /扣款日\s+消費日/.test(text) && /日期\s+摘要\s+支出\s+存入\s+餘額/.test(text)
}

export function parseTaishinDebit(lines: readonly string[]): ParsedDebitStatement {
  let section: 'intro' | 'card' | 'pending' | 'account' = 'intro'
  let periodStart: string | null = null
  let periodEnd: string | null = null
  let cardLast4: string | null = null
  let pendingCount = 0
  let declaredPurchases: number | null = null
  let declaredRefunds: number | null = null
  const card: DebitEntry[] = []
  const account: DebitEntry[] = []
  const unreadLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    let source = lines[i]
    // The account balance occasionally wraps onto the next visual line.
    if (section === 'account' && new RegExp(String.raw`^${DATE}`).test(source) && !ACCOUNT_ROW.test(toHalfWidth(source).trim())
      && /^\s*[\d,]+(?:\s|$)/.test(lines[i + 1] ?? '')) source += `  ${lines[++i]}`
    const line = toHalfWidth(source).trim()
    const cycle = line.match(new RegExp(String.raw`對帳單期間[:：]?\s*(${DATE})\s*[~～-]\s*(${DATE})`))
    if (cycle) [periodStart, periodEnd] = [date(cycle[1]), date(cycle[2])]
    const last4 = line.match(/卡號末四碼[:：]?\s*(\d{4})/)
    if (last4) cardLast4 = last4[1]
    const purchases = line.match(/本月消費金額共計\s*NT\$?\s*([\d,]+)/)
    if (purchases) declaredPurchases = money(purchases[1])
    const refunds = line.match(/本月退款金額共計\s*NT\$?\s*(-?[\d,]+)/)
    if (refunds) declaredRefunds = money(refunds[1])

    if (/^消費明細$|扣款日\s+消費日/.test(line)) { section = 'card'; continue }
    if (/^已消費未扣款明細|消費日\s+原始交易幣/.test(line)) { section = 'pending'; continue }
    if (/^帳戶交易明細$|日期\s+摘要\s+支出\s+存入\s+餘額/.test(line)) { section = 'account'; continue }
    if (section === 'intro') continue
    if (section === 'card' && /本月消費金額共計/.test(line)) { section = 'intro'; continue }
    if (section === 'pending') {
      if (new RegExp(String.raw`^${DATE}\s+TW\s+[\d,]+$`).test(line)) pendingCount++
      continue
    }
    if (section === 'card') {
      const m = line.match(CARD_ROW)
      if (m) {
        const amount = money(m[4])
        card.push({ txDate: date(m[2]), postDate: date(m[1]), merchant: cleanedMerchant(m[3]), amount,
          kind: amount < 0 ? 'refund' : 'purchase', evidence: 'card', raw: source })
      } else if (new RegExp(`^${DATE}`).test(line)) unreadLines.push(source)
      continue
    }
    const m = line.match(ACCOUNT_ROW)
    if (!m) {
      if (new RegExp(`^${DATE}`).test(line)) unreadLines.push(source)
      continue
    }
    const debit = money(m[3]), credit = money(m[4])
    if ((debit === 0) === (credit === 0)) { unreadLines.push(source); continue }
    const action = m[2].trim()
    const amount = debit > 0 ? debit : -credit
    const kind: DebitKind = /刷卡退貨|刷卡退款/.test(action) ? 'refund'
      : /刷卡消費/.test(action) ? 'purchase'
        : /提款|提領/.test(action) ? 'withdrawal'
          : /手續費/.test(action) ? 'fee'
            : debit > 0 ? 'transfer_out' : 'deposit'
    account.push({ txDate: date(m[1]), postDate: null, merchant: cleanedMerchant(m[6] || action), amount, kind,
      evidence: 'account', raw: source })
  }

  // The bank account row uses the debit date; the card row also carries the original purchase date.
  // A repeated amount on the same day is not enough evidence to merge two different purchases.
  const entries: DebitEntry[] = [...card]
  const groupedCard = new Map<string, DebitEntry[]>()
  const groupedAccount = new Map<string, DebitEntry[]>()
  const key = (e: DebitEntry) => `${e.postDate ?? e.txDate}|${e.amount}|${e.kind}`
  for (const e of card) groupedCard.set(key(e), [...(groupedCard.get(key(e)) ?? []), e])
  for (const e of account.filter((x) => x.kind === 'purchase' || x.kind === 'refund')) groupedAccount.set(key(e), [...(groupedAccount.get(key(e)) ?? []), e])
  let ambiguous = 0
  const mergedAccount = new Set<DebitEntry>()
  for (const [k, cs] of groupedCard) {
    const as = groupedAccount.get(k) ?? []
    if (cs.length !== 1 || as.length !== 1) { if (cs.length && as.length) ambiguous++; continue }
    cs[0].evidence = 'both'
    cs[0].merchant ||= as[0].merchant
    cs[0].raw += `\n${as[0].raw}`
    mergedAccount.add(as[0])
  }
  entries.push(...account.filter((e) => !mergedAccount.has(e)))

  const spent = card.filter((e) => e.amount > 0).reduce((sum, e) => sum + e.amount, 0)
  const refunded = card.filter((e) => e.amount < 0).reduce((sum, e) => sum + e.amount, 0)
  const cardTotalsMatch = declaredPurchases === null || declaredRefunds === null ? null
    : spent === declaredPurchases && refunded === declaredRefunds
  const warnings: string[] = []
  if (!periodStart || !periodEnd) warnings.push('找不到完整對帳單期間')
  if (cardTotalsMatch === false) warnings.push('金融卡明細加總與帳單合計不同')
  if (cardTotalsMatch === null) warnings.push('缺少金融卡消費或退款合計，請人工確認明細')
  if (unreadLines.length) warnings.push(`有 ${unreadLines.length} 行明細無法辨識`)
  if (ambiguous) warnings.push(`有 ${ambiguous} 組重複金額，兩區明細需人工確認是否相同`)
  return { periodStart, periodEnd, cardLast4, entries, pendingCount, cardTotalsMatch, unreadLines, warnings }
}
