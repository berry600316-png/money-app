import type { PaymentMethod, StatementEntry, Transaction } from '../db/types'
import { addMonthKey } from '../lib/months'
import { fmt } from '../lib/money'
import { dayDiff, merchantSimilarity } from './text'
import { txDate } from './reconcileCommon'
import { candidateForEntry, entryDate } from './reconCandidates'

interface SearchOptions {
  entry: StatementEntry
  query: string
  adjacentMonths: boolean
  paymentMethods: readonly PaymentMethod[]
  excludedIds?: ReadonlySet<string>
}

/** Manual search is broader than automatic matching; every record in the chosen months remains reachable. */
export function searchReconTransactions(transactions: readonly Transaction[], options: SearchOptions): Transaction[] {
  const { entry, adjacentMonths } = options
  const date = entryDate(entry)
  if (!date) return []
  const month = date.slice(0, 7)
  const months = new Set(adjacentMonths
    ? [addMonthKey(month, -1), month, addMonthKey(month, 1)]
    : [month])
  const methods = new Map(options.paymentMethods.map((method) => [method.id, method]))
  const terms = options.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return transactions.filter((tx) => {
    if (options.excludedIds?.has(tx.id)) return false
    const booked = txDate(tx)
    if (!months.has(booked.slice(0, 7))) return false
    if (!candidateForEntry(entry, tx, (id) => methods.get(id))) return false
    const searchable = `${tx.merchant} ${tx.amount} ${fmt(tx.amount)} ${booked} ${booked.replaceAll('-', '/')} ${Number(booked.slice(5, 7))}/${Number(booked.slice(8, 10))}`.toLocaleLowerCase()
    return terms.every((term) => searchable.includes(term))
  }).sort((a, b) =>
    Math.abs(a.amount - Math.abs(entry.amount)) - Math.abs(b.amount - Math.abs(entry.amount))
    || Math.abs(dayDiff(date, txDate(a))) - Math.abs(dayDiff(date, txDate(b)))
    || merchantSimilarity(b.merchant, entry.merchant) - merchantSimilarity(a.merchant, entry.merchant))
}
