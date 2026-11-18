import type { NotificationCapture } from './notificationFile'
import type { LineChatMessage, LineChatReadResult } from './lineChatFile'

export const LINE_CHAT_BASELINE_SETTING = 'lineChatBaseline'

/** The hash identifies one exported message without retaining its original text. */
export interface LineChatBaseline { id: string; at: string; exportFingerprint?: string }

export function validLineChatBaseline(value: unknown): LineChatBaseline | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && /^line-chat:[a-f0-9]{64}:[1-9]\d*$/.test(row.id)
    && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))
    && (row.exportFingerprint === undefined || (typeof row.exportFingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.exportFingerprint)))
    ? { id: row.id, at: row.at, ...(row.exportFingerprint ? { exportFingerprint: row.exportFingerprint as string } : {}) } : null
}

export function marker(message: LineChatMessage, exportFingerprint?: string): LineChatBaseline {
  return { id: message.id, at: message.at, ...(exportFingerprint ? { exportFingerprint } : {}) }
}

export type LineChatInspection =
  | { kind: 'first'; last: LineChatBaseline; skippedPayments: number }
  | { kind: 'ready'; last: LineChatBaseline; baselineIndex: number; captures: NotificationCapture[]; ambiguousIds: string[]; ambiguousSourceIds: Record<string, string>; expired: number }
  | { kind: 'out_of_order'; last: LineChatBaseline }

export function inspectLineChat(read: LineChatReadResult, baseline: LineChatBaseline | null, known: ReadonlySet<string> = new Set()): LineChatInspection | null {
  const messages = read.messages
  if (!messages.length) return null
  const last = marker(messages[messages.length - 1], read.exportFingerprint ?? undefined)
  if (!baseline) return { kind: 'first', last, skippedPayments: messages.filter((m) => m.paymentCandidate).length }
  const baselineIndex = messages.findIndex((m) => m.id === baseline.id)
  if (last.at < baseline.at) return { kind: 'out_of_order', last }
  // LINE may export only its currently available chat history. A fragment can be used
  // without the previous marker, while messages older than that marker stay untouched.
  const afterIndices = messages.flatMap((message, index) => baselineIndex >= 0
    ? index > baselineIndex || (baselineIndex === 0 && index === 0 && messages.length === 1
      && message.paymentCandidate && baseline.exportFingerprint !== read.exportFingerprint) ? [index] : []
    : message.at >= baseline.at ? [index] : [])
  const captureById = new Map(read.captures.map((capture) => [capture.captureId, capture]))
  const captures: NotificationCapture[] = []
  const ambiguousIds: string[] = []
  const ambiguousSourceIds: Record<string, string> = {}
  for (const index of afterIndices) {
    const message = messages[index]
    const capture = message.inWindow ? captureById.get(message.id) : undefined
    if (!capture) continue
    // A clipped export can renumber identical messages. Show a possible duplicate
    // under a file-scoped ID rather than silently treating it as the old message.
    const uncertain = (baselineIndex === 0 && index === 0)
      || (baselineIndex < 0 && messages.length === 1 && known.has(message.id) && baseline.exportFingerprint !== read.exportFingerprint)
    if (uncertain) {
      const id = `line-chat:${read.exportFingerprint}:${index + 1}`
      if (!known.has(id)) {
        captures.push({ ...capture, captureId: id })
        ambiguousIds.push(id)
        ambiguousSourceIds[id] = message.id
      }
    } else if (!known.has(message.id)) captures.push(capture)
  }
  return {
    kind: 'ready', last, baselineIndex, captures, ambiguousIds, ambiguousSourceIds,
    expired: afterIndices.filter((index) => index !== baselineIndex && messages[index].paymentCandidate && messages[index].expired && !known.has(messages[index].id)).length,
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
export function nextLineChatBaseline(messages: readonly LineChatMessage[], baseline: LineChatBaseline, baselineIndex: number, deferredIds: ReadonlySet<string>, exportFingerprint?: string, ambiguousSourceIds: Readonly<Record<string, string>> = {}): LineChatBaseline {
  const sourceDeferred = new Set([...deferredIds].map((id) => ambiguousSourceIds[id] ?? id))
  const firstDeferred = messages.findIndex((m, i) => i > baselineIndex && sourceDeferred.has(m.id))
  const target = messages[firstDeferred >= 0 ? firstDeferred - 1 : messages.length - 1]
  return target && target.at > baseline.at ? marker(target, exportFingerprint) : baseline
}
