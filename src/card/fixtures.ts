/*
 * SIMULATED test data for the credit card module. These texts are written by us to resemble
 * Taiwanese card notifications and statements; they are NOT real Richart Life notifications or
 * real 台新 statements, and passing tests on them does not prove real-world parsing works.
 */
import type { NotificationCapture } from './notificationFile'

export function capture(partial: Partial<NotificationCapture> & { body: string }): NotificationCapture {
  return {
    schemaVersion: 1,
    captureId: partial.captureId ?? 'cap-' + Math.random().toString(36).slice(2),
    derivedId: false,
    sourceApp: 'Richart Life',
    sourceType: 'notification',
    title: '刷卡通知',
    subtitle: null,
    notificationTime: new Date(2026, 9, 11, 14, 6).toISOString(),
    capturedAt: new Date(2026, 9, 11, 14, 6).toISOString(),
    fileName: 'test.json',
    ...partial,
  }
}

export const SIM_NOTIFICATIONS = {
  convenience: '您的台新卡末四碼1234於10/11 14:05在全家便利商店消費新臺幣85元',
  clothing: '台新信用卡 ****5678 於 2026/10/11 12:30 消費 NT$1,280，商店：UNIQLO 台北站前店',
  refund: '您的台新卡退款 NT$320 已入帳',
  payment: '您本期信用卡帳款已繳款成功 NT$12,345，感謝您',
  foreign: '您的台新卡於 AMAZON MKTPLACE 消費 USD 12.99',
  otp: '您的驗證碼為 123456，請勿告知他人',
  promo: '登錄活動享 NT$100 回饋，快來參加',
  noAmount: '您有一筆新的信用卡交易，請開啟 App 查看',
}

/** A made-up generic statement layout (NOT 台新's real format). */
export const SIM_STATEMENT_LINES = [
  '台新銀行 信用卡電子帳單',
  '卡號 ****-****-****-1234',
  '帳單結帳日 2026/10/15    繳款截止日 2026/11/02',
  '帳單週期 2026/09/16 ~ 2026/10/15',
  '本期應繳總額 14,725    最低應繳 1,000',
  '本期新增款項 2,725',
  '消費日  入帳日  交易說明  金額',
  '09/18  09/20  全家便利商店台北店  85',
  '09/20  09/22  UBER *EATS  320',
  '10/01  10/03  NETFLIX.COM  390',
  '10/05  10/07  台灣中油 加油站  1,015',
  '10/08  10/10  UNIQLO 站前店  1,280',
  '10/09  10/09  退貨 UNIQLO  -365',
  '09/25  09/25  感謝您繳款  -12,000',
  '第 1 頁 / 共 1 頁',
]
