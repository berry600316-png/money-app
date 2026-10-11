/*
 * One adapter per bank app (D-97). An adapter is built from REAL notification samples: each template is
 * the exact wording of one kind of message, with named groups for the fields. Only a notification that
 * matches a template is trusted (imported by default); anything else falls back to the generic rules in
 * ./notificationParser.ts, whose result always needs the user's confirmation.
 *
 * No real sample has been provided yet, so the registry is empty. To add a bank, see docs/adding-a-bank.md.
 */
import type { NotificationCapture } from './notificationFile'
import { findDates, findTime, parseAmount, toHalfWidth } from './text'

export interface NotificationTemplate {
  /** What this wording means. */
  kind: 'spend' | 'not_spending'
  /**
   * The whole message (title, subtitle and body joined by newlines, half-width, trimmed), anchored with ^…$.
   * Named groups: `amount` (required for spend), `merchant`, `last4`, `date` ("10/11", "2026/10/11"), `time` ("14:05").
   * Also tried against the body alone, for apps whose title changes.
   */
  pattern: RegExp
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
}

/** Registered adapters. Empty until real samples arrive. */
export const NOTIFICATION_ADAPTERS: NotificationAdapter[] = []

export type TemplateMatch =
  | { kind: 'spend'; amount: number; merchant: string; last4: string | null; occurredAt: string | null }
  | { kind: 'not_spending'; reason: string }

export function adapterFor(c: NotificationCapture, adapters: readonly NotificationAdapter[]): NotificationAdapter | null {
  return adapters.find((a) => a.sourceApps.test(c.sourceApp)) ?? null
}

/** Purchase time from the template's date/time groups; the year comes from the notification time. */
function timeFrom(date: string | undefined, time: string | undefined, ref: string | null): string | null {
  const refDate = ref ? new Date(ref) : null
  if (!date) {
    if (!time || !refDate) return ref
    const hm = findTime(time)
    if (!hm) return ref
    return new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), hm[0], hm[1]).toISOString()
  }
  const [ymd] = findDates(date, (refDate ?? new Date()).getFullYear())
  if (!ymd) return ref
  const [y, m, d] = ymd.split('-').map(Number)
  const hm = time ? findTime(time) : null
  let dt = new Date(y, m - 1, d, hm?.[0] ?? 12, hm?.[1] ?? 0)
  // "12/31" read on 1 January belongs to last year.
  if (refDate && dt.getTime() - refDate.getTime() > 2 * 864e5) dt = new Date(y - 1, m - 1, d, hm?.[0] ?? 12, hm?.[1] ?? 0)
  return dt.toISOString()
}

/** The first template that matches the whole message, or null (an unknown wording: never guessed here). */
export function matchTemplate(c: NotificationCapture, adapter: NotificationAdapter): TemplateMatch | null {
  const norm = (s: string) => toHalfWidth(s).replace(/\r\n?/g, '\n').trim()
  const whole = norm([c.title, c.subtitle, c.body].filter(Boolean).join('\n'))
  const body = norm(c.body ?? '')
  for (const t of adapter.templates) {
    const m = whole.match(t.pattern) ?? (body ? body.match(t.pattern) : null)
    if (!m) continue
    if (t.kind === 'not_spending') return { kind: 'not_spending', reason: t.reason ?? '非消費通知' }
    const g = m.groups ?? {}
    const amount = g.amount ? parseAmount(g.amount) : null
    if (amount === null || amount <= 0) continue
    return {
      kind: 'spend',
      amount,
      merchant: (g.merchant ?? '').trim().slice(0, 40),
      last4: g.last4 && /^\d{4}$/.test(g.last4) ? g.last4 : null,
      occurredAt: timeFrom(g.date, g.time, c.notificationTime ?? c.capturedAt),
    }
  }
  return null
}
