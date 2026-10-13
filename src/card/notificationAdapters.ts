/*
 * One adapter per bank app (D-97). An adapter is built from REAL notification samples: each template is
 * the exact wording of one kind of message, with named groups for the fields. Only a notification that
 * matches a template is trusted (imported by default); anything else falls back to the generic rules in
 * ./notificationParser.ts, whose result always needs the user's confirmation.
 *
 * D-128: the first adapter is LINE Pay (LINE 錢包), from the user's notification of 2026-10-12. To add a
 * bank or app, see docs/adding-a-bank.md.
 */
import type { NotificationCapture } from './notificationFile'
import { purchaseTime } from './purchaseTime'
import { parseAmount, toHalfWidth } from './text'
import type { PaymentMethod, TimeSource } from '../db/types'

export interface NotificationTemplate {
  /** What this wording means. */
  kind: 'spend' | 'not_spending'
  /**
   * The whole message (title, subtitle and body joined by newlines, half-width, trimmed), anchored with ^…$.
   * Named groups: `amount` (required for spend), `merchant`, `last4`, `date` ("10/11", "2026/10/11"), `time` ("14:05").
   * Also tried against the body alone, for apps whose title changes.
   */
  pattern: RegExp
  /**
   * When set, the notification title must match it and `pattern` is tried against the body only. Used when
   * the title is what proves the sender: a LINE chat can contain any text, but only LINE 錢包 sends it
   * with that title.
   */
  title?: RegExp
  /** Shown for not_spending ("退款通知"). */
  reason?: string
}

export interface NotificationAdapter {
  /** Stored with the import, e.g. "richart-v1". */
  id: string
  /** Issuing bank, used to pick the card when the message has no last four digits ("台新"). */
  bank: string
  /** The app names the shortcut writes into `sourceApp`. */
  sourceApps: RegExp
  templates: NotificationTemplate[]
  /**
   * D-130: the purchase was paid through a 行動支付 rather than a known card. The record is filed under the
   * user's payment method of this name, and the money's source (a card or an account) is its binding,
   * shown to the user before import and changeable per row.
   */
  channel?: { key: string; label: string; name: RegExp }
}

/**
 * D-128: LINE Pay payment notices, as sent by the LINE app under the title 「LINE錢包」 (user's sample of
 * 2026-10-12; the exact characters still need a real shortcut capture, so the pattern accepts both the
 * screenshot and the JSON the user typed: spaces optional, full / half-width colons, line breaks).
 *
 *   LINE Pay 付款 NT$ 661 付款完成。 商店名稱: 統康生活超市中和圓： 回饋: 中信LINE Pay卡… (promotion text)
 *
 * Only this sentence is trusted. The amount is the one in 「付款 NT$… 付款完成」, never a figure from the
 * promotion after 「回饋:」; a second payment sentence anywhere makes the whole message unmatched. The shop
 * name stops at the next colon or line; a name broken over two lines is not guessed, and a name with
 * 取消 / 退款 / 失敗… in it (「好鄰居超市 此筆交易已取消」) makes the message unmatched rather than a purchase.
 */
export const LINE_PAY_ADAPTER: NotificationAdapter = {
  id: 'linepay-v1',
  bank: '',
  sourceApps: /^LINE(?:\s*錢包)?$/i,
  // `key` links this kind of notice to the user's payment method once found (D-135), whatever it is renamed to.
  channel: { key: 'linepay', label: 'LINE Pay', name: /^LINE\s*Pay$/i },
  templates: [
    {
      kind: 'spend',
      title: /^LINE\s*錢包$/i,
      pattern:
        /^LINE\s*Pay\s*付款\s*NT\$\s*(?<amount>\d{1,3}(?:,\d{3})+|\d+)\s*付款完成\s*[。.]?\s*商店名稱\s*:\s*(?<merchant>(?:(?!NT\$|取消|退款|退貨|退刷|失敗|未成功|不成功|撤銷)[^:\n])+?)\s*(?::\s*)?(?:回饋\s*:(?![\s\S]*付款\s*NT\$)[\s\S]*)?$/,
    },
  ],
}

/** Registered adapters (D-97, D-128). */
export const NOTIFICATION_ADAPTERS: NotificationAdapter[] = [LINE_PAY_ADAPTER]

/**
 * D-135: data from before the link existed. A kind of notice not linked yet is linked to the 行動支付 /
 * 其他 named like it ("LINE Pay") when there is exactly one, so renaming it later keeps it. Returns only
 * the links to add.
 */
export function linksByName(
  methods: readonly Pick<PaymentMethod, 'id' | 'name' | 'type'>[],
  current: Readonly<Record<string, string>>,
  adapters: readonly NotificationAdapter[] = NOTIFICATION_ADAPTERS,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of adapters) {
    const ch = a.channel
    if (!ch || current[ch.key] || out[ch.key]) continue
    const named = methods.filter((p) => (p.type === 'mobile' || p.type === 'other') && ch.name.test(p.name.trim()))
    if (named.length === 1) out[ch.key] = named[0].id
  }
  return out
}

export type TemplateMatch =
  | { kind: 'spend'; amount: number; merchant: string; last4: string | null; occurredAt: string | null; timeSource?: TimeSource }
  | { kind: 'not_spending'; reason: string }

export function adapterFor(c: NotificationCapture, adapters: readonly NotificationAdapter[]): NotificationAdapter | null {
  return adapters.find((a) => a.sourceApps.test(c.sourceApp)) ?? null
}

/** The first template that matches the whole message, or null (an unknown wording: never guessed here). */
export function matchTemplate(c: NotificationCapture, adapter: NotificationAdapter): TemplateMatch | null {
  // Line breaks and the ends first, then half-width: toHalfWidth keeps every position, so a field found in
  // the half-width text can be cut from the original (a shop keeps its own 「（）」 and full-width marks).
  const raw = (s: string) => s.replace(/\r\n?/g, '\n').trim()
  const rawWhole = raw([c.title, c.subtitle, c.body].filter(Boolean).join('\n'))
  const rawBody = raw(c.body ?? '')
  const whole = toHalfWidth(rawWhole)
  const body = toHalfWidth(rawBody)
  for (const t of adapter.templates) {
    if (t.title && !t.title.test(toHalfWidth(raw(c.title ?? '')))) continue
    const re = new RegExp(t.pattern.source, t.pattern.flags.includes('d') ? t.pattern.flags : t.pattern.flags + 'd')
    let m: RegExpExecArray | null = null
    let source = ''
    if (!t.title) {
      m = re.exec(whole)
      source = rawWhole
    }
    if (!m && body) {
      m = re.exec(body)
      source = rawBody
    }
    if (!m) continue
    if (t.kind === 'not_spending') return { kind: 'not_spending', reason: t.reason ?? '非消費通知' }
    const g = m.groups ?? {}
    const amount = g.amount ? parseAmount(g.amount) : null
    if (amount === null || amount <= 0) continue
    return {
      kind: 'spend',
      amount,
      merchant: (m.indices?.groups?.merchant ? source.slice(...m.indices.groups.merchant) : (g.merchant ?? '')).trim().replace(/[\s。.,、;，；]+$/, '').slice(0, 40),
      last4: g.last4 && /^\d{4}$/.test(g.last4) ? g.last4 : null,
      ...purchaseTime(`${g.date ?? ''} ${g.time ?? ''}`, c),
    }
  }
  return null
}
