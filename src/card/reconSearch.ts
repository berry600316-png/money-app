import type { StatementEntry, Transaction } from '../db/types'
import { addMonthKey } from '../lib/months'
import { fmt } from '../lib/money'
import { dayDiff, merchantSimilarity } from './text'
import { txDate } from './reconcileCommon'

interface SearchOptions {
  statementMonth: string
  entry: StatementEntry
  query: string
  adjacentMonths: boolean
}

/** Manual search is broader than automatic matching; every record in the chosen months remains reachable. */
export function searchReconTransactions(transactions: readonly Transaction[], options: SearchOptions): Transaction[] {
  const { statementMonth, entry, adjacentMonths } = options
  const months = new Set(adjacentMonths
    ? [addMonthKey(statementMonth, -1), statementMonth, addMonthKey(statementMonth, 1)]
    : [statementMonth])
  const terms = options.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const entryDate = entry.txDate ?? entry.postDate ?? `${statementMonth}-01`
  return transactions.filter((tx) => {
    const date = txDate(tx)
    if (!months.has(date.slice(0, 7))) return false
    const searchable = `${tx.merchant} ${tx.amount} ${fmt(tx.amount)} ${date} ${date.replaceAll('-', '/')} ${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`.toLocaleLowerCase()
    return terms.every((term) => searchable.includes(term))
  }).sort((a, b) =>
    Math.abs(a.amount - Math.abs(entry.amount)) - Math.abs(b.amount - Math.abs(entry.amount))
    || Math.abs(dayDiff(entryDate, txDate(a))) - Math.abs(dayDiff(entryDate, txDate(b)))
    || merchantSimilarity(b.merchant, entry.merchant) - merchantSimilarity(a.merchant, entry.merchant))
}
