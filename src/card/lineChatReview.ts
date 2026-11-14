import type { PlanRow } from './importPlan'
import { LINE_PAY_ADAPTER } from './notificationAdapters'

/** Review decisions exist only in the LINE chat preview until the user saves. */
export type LineReviewRow = PlanRow & { duplicateReviewed?: boolean }
export type LineReviewIssue = 'unparsed' | 'duplicate' | 'source' | null
export type LineReviewSection = 'problem' | 'selected' | 'skipped'

export function lineReviewIssue(row: LineReviewRow): LineReviewIssue {
  if (row.permanentSkip) return null
  if (row.status === 'unparsed') return 'unparsed'
  if (row.duplicate && !row.duplicateReviewed) return 'duplicate'
  if (!row.source) return 'source'
  return null
}

export function lineReviewSection(row: LineReviewRow): LineReviewSection {
  if (row.permanentSkip) return 'skipped'
  if (lineReviewIssue(row)) return 'problem'
  return row.include ? 'selected' : 'skipped'
}

export function acceptDuplicate(row: LineReviewRow): LineReviewRow {
  return { ...row, duplicateReviewed: true, include: true }
}

export function skipLineRow(row: LineReviewRow): LineReviewRow {
  return { ...row, include: false, permanentSkip: true }
}

export function restoreLineRow(row: LineReviewRow): LineReviewRow {
  return {
    ...row,
    permanentSkip: false,
    include: row.status !== 'unparsed' && (!row.duplicate || !!row.duplicateReviewed),
  }
}

/** A user-completed payment is trusted as entered and is not checked again for duplicates. */
export function completeUnparsed(row: LineReviewRow): LineReviewRow {
  return {
    ...row,
    status: 'new',
    reason: '',
    include: true,
    needsSource: false,
    channel: LINE_PAY_ADAPTER.channel!.label,
    channelKey: LINE_PAY_ADAPTER.channel!.key,
  }
}
