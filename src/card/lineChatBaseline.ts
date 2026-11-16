import type { NotificationCapture } from './notificationFile'
import type { LineChatMessage, LineChatReadResult } from './lineChatFile'

export const LINE_CHAT_BASELINE_SETTING = 'lineChatBaseline'

/** The hash identifies one exported message without retaining its original text. */
export interface LineChatBaseline { id: string; at: string }

export function validLineChatBaseline(value: unknown): LineChatBaseline | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && /^line-chat:[a-f0-9]{64}:[1-9]\d*$/.test(row.id)
    && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))
    ? { id: row.id, at: row.at } : null
}

export function marker(message: LineChatMessage): LineChatBaseline {
  return { id: message.id, at: message.at }
}

export type LineChatInspection =
  | { kind: 'first'; last: LineChatBaseline; skippedPayments: number }
  | { kind: 'ready'; last: LineChatBaseline; baselineIndex: number; captures: NotificationCapture[]; expired: number }
  | { kind: 'missing'; last: LineChatBaseline }
  | { kind: 'same_time'; last: LineChatBaseline }
  | { kind: 'out_of_order'; last: LineChatBaseline }

export function inspectLineChat(read: LineChatReadResult, baseline: LineChatBaseline | null, known: ReadonlySet<string> = new Set()): LineChatInspection | null {
  const messages = read.messages
  if (!messages.length) return null
  const last = marker(messages[messages.length - 1])
  if (!baseline) return { kind: 'first', last, skippedPayments: messages.filter((m) => m.paymentCandidate).length }
  const baselineIndex = messages.findIndex((m) => m.id === baseline.id)
  if (baselineIndex < 0) return { kind: 'missing', last }
  if (last.id !== baseline.id && last.at === baseline.at) return { kind: 'same_time', last }
  if (last.at < baseline.at) return { kind: 'out_of_order', last }
  const after = messages.slice(baselineIndex + 1)
  const newIds = new Set(after.filter((m) => m.inWindow).map((m) => m.id))
  return {
    kind: 'ready', last, baselineIndex,
    captures: read.captures.filter((c) => newIds.has(c.captureId)),
    expired: after.filter((m) => m.paymentCandidate && m.expired && !known.has(m.id)).length,
  }
}

/** Reset never moves backwards; a missing old marker needs a strictly later time. */
export function canResetLineChatBaseline(messages: readonly LineChatMessage[], old: LineChatBaseline | null): boolean {
  if (!messages.length) return false
  if (!old) return true
  const last = messages[messages.length - 1]
  const oldIndex = messages.findIndex((m) => m.id === old.id)
  return oldIndex >= 0 ? messages.length - 1 > oldIndex && last.at > old.at : last.at > old.at
}

/** Deferred issues keep the cursor before the earliest unresolved message. */
export function nextLineChatBaseline(messages: readonly LineChatMessage[], baselineIndex: number, deferredIds: ReadonlySet<string>): LineChatBaseline {
  const firstDeferred = messages.findIndex((m, i) => i > baselineIndex && deferredIds.has(m.id))
  const target = messages[firstDeferred >= 0 ? firstDeferred - 1 : messages.length - 1]
  return target.at > messages[baselineIndex].at ? marker(target) : marker(messages[baselineIndex])
}
