/*
 * Text helpers shared by the notification parser, statement parser and reconciliation.
 * Pure functions; no UI, no database.
 */

/** Full-width ASCII (Ｎ，１２３) → half-width; ideographic space → space. */
export function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ')
}

/**
 * Parse an NTD amount written as "NT$1,234", "新臺幣 1,234 元", "TWD1234", "1,234.00".
 * Returns an integer (rounded) or null. Decimals other than .00 are rounded to the nearest dollar.
 */
export function parseAmount(s: string): number | null {
  const t = toHalfWidth(s).replace(/\s/g, '')
  const m = t.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0].replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round(n)
}

/** Currency markers we treat as NTD. */
export const NTD_RE = /(NT\$|NTD|TWD|新[臺台]幣|台幣|臺幣)/i

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

/**
 * Find dates in text. Supports 2026/10/05, 2026-10-05, 2026.10.05, ROC years 115/10/05,
 * "2026年10月5日", and month/day only ("10/05", needs `yearHint`).
 * Returns local "YYYY-MM-DD" strings in the order found.
 */
export function findDates(text: string, yearHint?: number): string[] {
  const s = toHalfWidth(text)
  const out: { at: number; v: string }[] = []
  const taken: [number, number][] = []
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && b > x)
  const push = (at: number, len: number, v: string | null) => {
    if (v && free(at, at + len)) {
      out.push({ at, v })
      taken.push([at, at + len])
    }
  }
  for (const m of s.matchAll(/(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    let y = Number(m[1])
    if (y < 1000) y += 1911
    push(m.index!, m[0].length, validYmd(y, Number(m[2]), Number(m[3])))
  }
  for (const m of s.matchAll(/(?<!\d)(\d{4}|\d{3})[/.-](\d{1,2})[/.-](\d{1,2})(?!\d)/g)) {
    let y = Number(m[1])
    if (m[1].length === 3) y += 1911 // ROC year (民國)
    push(m.index!, m[0].length, validYmd(y, Number(m[2]), Number(m[3])))
  }
  if (yearHint) {
    for (const m of s.matchAll(/(?<![\d/.-])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) {
      push(m.index!, m[0].length, validYmd(yearHint, Number(m[1]), Number(m[2])))
    }
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.v)
}

/** "14:05" / "14:05:33" / "下午2:05" → [h, m] */
export function findTime(text: string): [number, number] | null {
  const s = toHalfWidth(text)
  const m = s.match(/(上午|下午|AM|PM)?\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i)
  if (!m) return null
  let h = Number(m[2])
  const mi = Number(m[3])
  const ap = (m[1] ?? m[4] ?? '').toUpperCase()
  if ((ap === '下午' || ap === 'PM') && h < 12) h += 12
  if ((ap === '上午' || ap === 'AM') && h === 12) h = 0
  if (h > 23 || mi > 59) return null
  return [h, mi]
}

/** Last four card digits: "末四碼1234", "卡號末4碼 1234", "****1234", "尾號1234". */
export function findLast4(text: string): string | null {
  const s = toHalfWidth(text)
  const m =
    s.match(/(?:末\s*[四4]\s*碼|尾\s*[數号號]|卡\s*號\s*末\s*[四4]\s*碼)\s*[:：]?\s*(\d{4})/) ??
    s.match(/[*xX•●]{2,}[\s-]*(\d{4})(?!\d)/)
  return m ? m[1] : null
}

/* ---------------- merchant names ---------------- */

/** Known spellings of the same merchant, normalised to one key. */
const ALIASES: [RegExp, string][] = [
  [/統一超商|7-?11|7-?eleven|seveneleven|小七/i, '7eleven'],
  [/全家|familymart|family\s*mart/i, '全家'],
  [/萊爾富|hilife|hi-life/i, '萊爾富'],
  [/uber\s*\*?\s*eats/i, 'ubereats'],
  [/foodpanda|富胖達/i, 'foodpanda'],
  [/台灣中油|台灣中油公司|中油|cpc\b/i, '中油'],
  [/全聯/i, '全聯'],
  [/家樂福|carrefour/i, '家樂福'],
  [/蝦皮|shopee/i, '蝦皮'],
  [/netflix/i, 'netflix'],
  [/spotify/i, 'spotify'],
  [/apple\.com|itunes|app\s*store/i, 'apple'],
  [/星巴克|starbucks/i, '星巴克'],
  [/路易莎|louisa/i, '路易莎'],
  [/麥當勞|mcdonald/i, '麥當勞'],
]

const NOISE = /(股份有限公司|有限公司|股份公司|公司|門市|分公司|分店|營業所|加盟店|直營店|\bco\.?\b|\bltd\.?\b|\binc\.?\b|\btaipei\b|\btaiwan\b|\btw\b)/gi

/** A comparable key: alias, lower case, no spaces/punctuation/branch numbers. */
export function normalizeMerchant(name: string): string {
  const s = toHalfWidth(name).trim()
  for (const [re, key] of ALIASES) if (re.test(s)) return key
  return s
    .toLowerCase()
    .replace(NOISE, '')
    .replace(/[\s*#\-_.,:;'"()（）[\]【】/\\|]+/g, '')
    .replace(/\d{3,}$/g, '') // trailing store codes
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  if (s.length < 2) {
    if (s) out.add(s)
    return out
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

/** 0..1 similarity between two merchant names (Dice coefficient on bigrams, after normalising). */
export function merchantSimilarity(a: string, b: string): number {
  const x = normalizeMerchant(a)
  const y = normalizeMerchant(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return 0.9
  const A = bigrams(x)
  const B = bigrams(y)
  let common = 0
  for (const g of A) if (B.has(g)) common++
  return (2 * common) / (A.size + B.size)
}

export const SIMILAR_MERCHANT = 0.5

/** Whole days between two "YYYY-MM-DD" dates (b − a). */
export function dayDiff(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number)
  const [y2, m2, d2] = b.split('-').map(Number)
  return Math.round((new Date(y2, m2 - 1, d2).getTime() - new Date(y1, m1 - 1, d1).getTime()) / 864e5)
}
