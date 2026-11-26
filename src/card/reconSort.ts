import type { Item } from './reconcile'
import { txDate } from './reconcileCommon'

const dateOf = (item: Item) => 'entry' in item ? item.entry.txDate || item.entry.postDate || '' : txDate(item.tx)
const merchantOf = (item: Item) => 'entry' in item ? item.entry.merchant : item.tx.merchant

/** Sort one reconciliation section without changing its membership or the input order. */
export function sortReconItems(items: readonly Item[]): Item[] {
  return [...items].sort((a, b) => {
    const aDate = dateOf(a)
    const bDate = dateOf(b)
    if (!aDate) return bDate ? 1 : merchantOf(a).localeCompare(merchantOf(b), 'zh-TW')
    if (!bDate) return -1
    return aDate.localeCompare(bDate) || merchantOf(a).localeCompare(merchantOf(b), 'zh-TW')
  })
}
