import { describe, expect, it } from 'vitest'
import type { PlanRow } from './importPlan'
import { acceptDuplicate, completeUnparsed, lineReviewIssue, lineReviewSection, restoreLineRow, skipLineRow, type LineReviewRow } from './lineChatReview'

const row = (changes: Partial<PlanRow> = {}): LineReviewRow => ({
  status: 'new', include: true, permanentSkip: false, duplicate: false,
  source: { cardId: 'card' }, amount: 120, merchant: '商店', occurredAt: new Date(2026, 10, 13, 12).toISOString(),
  ...changes,
} as LineReviewRow)

describe('LINE chat review sections', () => {
  it('keeps suspected duplicates in problems until an explicit decision', () => {
    const suspected = row({ status: 'suspect', duplicate: true, include: false })
    expect(lineReviewIssue(suspected)).toBe('duplicate')
    expect(lineReviewSection(suspected)).toBe('problem')
    const accepted = acceptDuplicate(suspected)
    expect(lineReviewSection(accepted)).toBe('selected')
    const skipped = skipLineRow(suspected)
    expect(lineReviewSection(skipped)).toBe('skipped')
    expect(lineReviewSection(restoreLineRow(skipped))).toBe('problem')
  })

  it('requires a source and moves an ordinary unchecked row to permanent skip', () => {
    const noSource = row({ status: 'suspect', source: null, include: false })
    expect(lineReviewIssue(noSource)).toBe('source')
    expect(lineReviewSection(noSource)).toBe('problem')
    expect(lineReviewSection({ ...noSource, source: { cardId: 'card' }, include: true })).toBe('selected')
    const skipped = skipLineRow(row())
    expect(lineReviewSection(skipped)).toBe('skipped')
    expect(lineReviewSection(restoreLineRow(skipped))).toBe('selected')
  })

  it('requires manual completion of an unparsed payment but does not recheck duplicates', () => {
    const unparsed = row({ status: 'unparsed', include: false, source: null })
    expect(lineReviewIssue(unparsed)).toBe('unparsed')
    const completed = completeUnparsed({ ...unparsed, source: { cardId: 'card' } })
    expect(completed).toMatchObject({ status: 'new', include: true, channel: 'LINE Pay', channelKey: 'linepay' })
    expect(lineReviewSection(completed)).toBe('selected')
    expect(lineReviewSection(skipLineRow(unparsed))).toBe('skipped')
    expect(lineReviewSection(restoreLineRow(skipLineRow(unparsed)))).toBe('problem')
  })
})
