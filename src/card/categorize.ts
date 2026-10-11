/* Automatic category for imported or back-filled purchases (D-85). No AI; history first, then keywords. */
import type { Category } from '../db/types'
import { merchantSimilarity } from './text'

/** Built-in hints; only used when the user has no history for a similar merchant. */
const KEYWORDS: [RegExp, string][] = [
  [/全家|7-?11|統一超商|萊爾富|OK超商|ok mart|uber\s*\*?\s*eats|foodpanda|麥當勞|肯德基|摩斯|星巴克|路易莎|咖啡|cafe|coffee|餐|食|飯|麵|鍋|早午餐|便當|飲料|茶/i, 'food'],
  [/中油|台塑石油|加油|捷運|高鐵|台鐵|客運|悠遊卡|一卡通|uber(?!\s*\*?\s*eats)|計程車|停車|etc|irent|gogoro/i, 'transport'],
  [/全聯|家樂福|好市多|costco|屈臣氏|康是美|寶雅|大潤發|愛買|日用/i, 'daily'],
  [/蝦皮|shopee|momo|pchome|博客來|uniqlo|zara|h&m|ikea|誠品|百貨|amazon|淘寶/i, 'shopping'],
  [/netflix|spotify|disney|youtube|kkbox|威秀|影城|steam|playstation|nintendo|apple\.com/i, 'fun'],
  [/台電|台灣電力|自來水|瓦斯|中華電信|台灣大哥大|遠傳|亞太|房租|管理費/i, 'home'],
  [/診所|醫院|藥局|牙醫|眼科|健保/i, 'medical'],
]

export interface MerchantHistory {
  merchant: string
  categoryId: string
}

export function suggestCategory(merchant: string, history: readonly MerchantHistory[], categories: readonly Category[]): string {
  const usable = (id: string) => categories.some((c) => c.id === id && c.type === 'expense' && c.isActive)
  if (merchant) {
    // Most recent similar merchant the user already categorised.
    for (const h of history) {
      if (h.merchant && usable(h.categoryId) && merchantSimilarity(h.merchant, merchant) >= 0.8) return h.categoryId
    }
    for (const [re, id] of KEYWORDS) if (re.test(merchant) && usable(id)) return id
  }
  if (usable('other')) return 'other'
  return categories.find((c) => c.type === 'expense' && c.isActive)?.id ?? 'other'
}
