/*
 * D-100: when did the purchase happen, and how sure are we?
 *   - date and time written in the message → exact;
 *   - only a date written → the notification's arrival time if it is that day ('notification'),
 *     else that date at 12:00 ('date');
 *   - only a time written → that time on the day the notification arrived (exact);
 *   - nothing written → the notification's arrival time ('notification'); with no arrival time,
 *     only the capture's DATE is used, at 12:00 ('date'). The capture time is never the purchase time.
 */
import type { TimeSource } from '../db/types'
import { fromYmd, localIso, toYmd } from '../lib/dates'
import type { NotificationCapture } from './notificationFile'
import { findDates, findTime } from './text'

export interface PurchaseTime {
  occurredAt: string | null
  timeSource?: TimeSource
}

const DATE_RE = /\d{2,4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}\/\d{1,2}|\d{2,4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*月\s*\d{1,2}\s*日/g
const pad = (n: number) => String(n).padStart(2, '0')

/** `text`: the message (generic rules) or the adapter's "date time" groups joined by a space. */
export function purchaseTime(text: string, c: Pick<NotificationCapture, 'notificationTime' | 'capturedAt'>): PurchaseTime {
  const arrived = c.notificationTime ? new Date(c.notificationTime) : null
  const captured = c.capturedAt ? new Date(c.capturedAt) : null
  const ref = arrived ?? captured ?? new Date()
  let ymd = findDates(text, ref.getFullYear())[0] ?? null
  // "12/31" read on 1 January belongs to last year.
  if (ymd && fromYmd(ymd).getTime() - ref.getTime() > 2 * 864e5) ymd = `${Number(ymd.slice(0, 4)) - 1}${ymd.slice(4)}`
  const hm = findTime(text.replace(DATE_RE, ' '))
  const hhmm = hm ? `${pad(hm[0])}:${pad(hm[1])}` : null

  if (ymd && hhmm) return { occurredAt: localIso(ymd, hhmm) }
  if (ymd) {
    if (arrived && toYmd(arrived) === ymd) return { occurredAt: arrived.toISOString(), timeSource: 'notification' }
    return { occurredAt: localIso(ymd, '12:00'), timeSource: 'date' }
  }
  if (hhmm) {
    const base = arrived ?? captured
    return base ? { occurredAt: localIso(toYmd(base), hhmm) } : { occurredAt: null }
  }
  if (arrived) return { occurredAt: arrived.toISOString(), timeSource: 'notification' }
  if (captured) return { occurredAt: localIso(toYmd(captured), '12:00'), timeSource: 'date' }
  return { occurredAt: null }
}
