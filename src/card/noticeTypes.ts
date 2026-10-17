/*
 * D-136: payment notice types. The user names a kind of notice by its keywords (all of them must be in
 * the notice) and says where it is recorded: a 行動支付 and one of the cards it holds ("LINE Pay · 台新
 * 金融卡"). Pure functions only; the writes are in cardRepo.
 */
import type { PaymentMethod } from '../db/types'
import { isCard } from '../lib/accounts'
import type { NotificationCapture } from './notificationFile'
import type { PaySource } from './importPlan'
import { toHalfWidth } from './text'

export interface NoticeType {
  id: string
  name: string
  /** All must appear in the notice (title and text). Their set is what tells the type apart (Q120 A). */
  keywords: string[]
  /** The 行動支付 / 其他 the purchase is recorded under (Q119 A, Q126 A). */
  paymentMethodId: string
  /** The card it holds that paid (credit: 預扣, debit: from its bank). */
  cardId: string
}

/** Stored in settings, so it goes with a full backup. */
export const NOTICE_TYPES_SETTING = 'noticeTypes'
export const NOTICE_TYPES_MAX = 10
export const NOTICE_KEYWORDS_MAX = 5
export const NOTICE_KEYWORD_MAX = 10
export const NOTICE_NAME_MAX = 12

/** Full and half width, upper and lower case are the same (Q113 A). */
export const normKeyword = (s: string) => toHalfWidth(s).trim().toLowerCase()

/** The identity of a type: its keywords, in any order, compared as above. */
export const keywordKey = (keywords: readonly string[]) => [...new Set(keywords.map(normKeyword))].sort().join('\n')

const isStr = (v: unknown): v is string => typeof v === 'string'

/**
 * The stored list, read leniently (a setting or a backup file may be damaged): entries without the right
 * shape are dropped, keywords are trimmed and limited, a type whose keywords repeat an earlier one is
 * dropped, at most NOTICE_TYPES_MAX. A target that no longer exists is kept (Q127 A: shown as unusable).
 */
export function readNoticeTypes(v: unknown): NoticeType[] {
  if (!Array.isArray(v)) return []
  const out: NoticeType[] = []
  const seen = new Set<string>()
  for (const t of v) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    if (!isStr(o.id) || !o.id || !isStr(o.name) || !isStr(o.paymentMethodId) || !isStr(o.cardId) || !Array.isArray(o.keywords)) continue
    const name = o.name.trim().slice(0, NOTICE_NAME_MAX)
    const keywords: string[] = []
    for (const k of o.keywords) {
      if (!isStr(k)) continue
      const w = k.trim()
      if (w && w.length <= NOTICE_KEYWORD_MAX && !keywords.some((x) => normKeyword(x) === normKeyword(w))) keywords.push(w)
    }
    const key = keywordKey(keywords)
    if (!name || !keywords.length || keywords.length > NOTICE_KEYWORDS_MAX || seen.has(key) || out.some((x) => x.id === o.id)) continue
    seen.add(key)
    out.push({ id: o.id, name, keywords, paymentMethodId: o.paymentMethodId, cardId: o.cardId })
    if (out.length === NOTICE_TYPES_MAX) break
  }
  return out
}

/** Why a type cannot be used now ('' = it can): its 行動支付 or card was disabled, deleted or unbound (Q127 A). */
export function targetProblem(t: Pick<NoticeType, 'paymentMethodId' | 'cardId'>, methods: readonly PaymentMethod[]): string {
  const wallet = methods.find((p) => p.id === t.paymentMethodId)
  const card = methods.find((p) => p.id === t.cardId)
  if (!wallet) return '記到的支付方式已刪除'
  if (wallet.type !== 'mobile' && wallet.type !== 'other') return `「${wallet.name}」不是行動支付`
  if (!wallet.isActive) return `「${wallet.name}」已刪除`
  if (!card || !(isCard(card) || card.type === 'debit_card')) return '記到的卡已刪除'
  if (!card.isActive) return `「${card.name}」已刪除`
  if (!(wallet.cards ?? []).includes(card.id)) return `「${card.name}」已不在「${wallet.name}」底下`
  return ''
}

export interface NoticeRoute {
  /** Where it is recorded; null = the user picks (needs confirming). */
  source: PaySource | null
  /** The 行動支付 of the chosen type; null = the one of that kind of notice (LINE Pay). */
  paymentMethodId: string | null
  /** The names of the types that chose it, shown next to the card. */
  typeNames: string[]
  /** Why nothing was chosen ('' when it was). */
  note: string
}

/**
 * D-136: which type a notice is. A type matches when all its keywords are in the whole notice (title and
 * text, Q113 A). Of the types that match, one whose keywords include another's wins (Q120 A: "LINE Pay ＋
 * 全聯" over "LINE Pay"); the rest, if they record to different places, leave it to the user, as does no
 * match at all (Q121) and a type whose card can no longer be used (Q127 A).
 */
export function routeNotice(
  c: Pick<NotificationCapture, 'title' | 'subtitle' | 'body'>,
  types: readonly NoticeType[],
  methods: readonly PaymentMethod[],
): NoticeRoute {
  const text = normKeyword([c.title, c.subtitle, c.body].filter(Boolean).join('\n'))
  const sets = new Map(types.map((t) => [t.id, new Set(t.keywords.map(normKeyword))]))
  const matched = types.filter((t) => [...sets.get(t.id)!].every((k) => text.includes(k)))
  if (!matched.length) return { source: null, paymentMethodId: null, typeNames: [], note: '沒有符合的通知類型，請選這筆用哪張卡' }
  const covers = (a: NoticeType, b: NoticeType) => {
    const sa = sets.get(a.id)!
    const sb = sets.get(b.id)!
    return sa.size > sb.size && [...sb].every((k) => sa.has(k))
  }
  const top = matched.filter((t) => !matched.some((o) => covers(o, t)))
  const places = [...new Set(top.map((t) => `${t.paymentMethodId}\n${t.cardId}`))]
  const names = top.map((t) => t.name)
  if (places.length > 1) {
    const kinds = top.length === 2 ? '兩種' : `${top.length} 種`
    return { source: null, paymentMethodId: null, typeNames: names, note: `同時符合「${names.join('」「')}」${kinds}通知，請選這筆用哪張卡` }
  }
  const t = top[0]
  const problem = targetProblem(t, methods)
  if (problem) return { source: null, paymentMethodId: null, typeNames: names, note: `符合「${t.name}」，但${problem}，請選這筆用哪張卡` }
  return { source: { cardId: t.cardId }, paymentMethodId: t.paymentMethodId, typeNames: names, note: '' }
}
