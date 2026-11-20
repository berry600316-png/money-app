import type { Transaction } from '../db/types'
import { merchantSimilarity } from './text'

export const LINE_CHAT_MERCHANT_ALIASES_SETTING = 'lineChatMerchantAliases'

export interface LineChatMerchantAlias {
  original: string
  preferred: string
  categoryId: string
  updatedAt: string
}

const key = (name: string) => name.trim().toLocaleLowerCase()

/** Only the chosen accounting time changes; the raw LINE message identity stays intact. */
export function roundLineChatMinute(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime()) || date.getMinutes() % 2 === 0) return iso
  date.setMinutes(date.getMinutes() + 1, 0, 0)
  return date.toISOString()
}

export function readLineChatMerchantAliases(value: unknown): LineChatMerchantAlias[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is LineChatMerchantAlias =>
    !!row && typeof row === 'object'
    && typeof row.original === 'string' && !!row.original.trim() && row.original.length <= 40
    && typeof row.preferred === 'string' && !!row.preferred.trim() && row.preferred.length <= 40
    && typeof row.categoryId === 'string' && !!row.categoryId
    && typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt)),
  )
}

/** Exact original name first; similar originals use the latest explicit correction. */
export function findLineChatMerchantAlias(original: string, aliases: readonly LineChatMerchantAlias[]): LineChatMerchantAlias | null {
  const name = key(original)
  if (!name) return null
  const latest = [...aliases].reverse().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return latest.find((row) => key(row.original) === name)
    ?? latest.find((row) => key(row.original) !== key(row.preferred) && merchantSimilarity(row.original, original) >= 0.8)
    ?? null
}

export function saveLineChatMerchantAlias(
  aliases: readonly LineChatMerchantAlias[],
  original: string,
  preferred: string,
  categoryId: string,
  updatedAt: string,
): LineChatMerchantAlias[] {
  const remaining = aliases.filter((row) => key(row.original) !== key(original))
  if (!original.trim() || !preferred.trim()) return remaining
  return [...remaining, { original: original.trim(), preferred: preferred.trim(), categoryId, updatedAt }]
}

/** Build a transient index once per preview; it is never saved separately from transactions. */
export function lineChatMerchantIndex(transactions: readonly Transaction[]): { merchant: string; categoryId: string }[] {
  const seen = new Set<string>()
  return [...transactions]
    .filter((tx) => tx.type === 'expense' && !!tx.merchant)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.updatedAt.localeCompare(a.updatedAt))
    .flatMap((tx) => {
      const name = key(tx.merchant)
      if (seen.has(name)) return []
      seen.add(name)
      return [{ merchant: tx.merchant, categoryId: tx.categoryId }]
    })
}

export function lineChatMerchantSuggestions(query: string, index: readonly { merchant: string; categoryId: string }[], limit = 5): { merchant: string; categoryId: string }[] {
  const q = key(query)
  if (!q) return []
  return index.filter((item) => key(item.merchant).includes(q) && key(item.merchant) !== q).slice(0, limit)
}

export function lineChatMerchantCategory(name: string, index: readonly { merchant: string; categoryId: string }[]): string | null {
  return index.find((item) => key(item.merchant) === key(name))?.categoryId ?? null
}
