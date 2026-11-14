/** Read a LINE 錢包 chat export without persisting the file or its messages. */
import { isValidHm, localIso, toYmd } from '../lib/dates'
import type { NotificationCapture } from './notificationFile'

export const MAX_LINE_CHAT_BYTES = 12_000_000

export interface LineChatReadResult {
  captures: NotificationCapture[]
  coverage: { first: string; last: string } | null
  ignored: number
  errors: string[]
}

const dateHeader = /^(\d{4})\/(\d{1,2})\/(\d{1,2})（[^）]*）$/
const messageHeader = /^(\d{1,2}:\d{2})\t([^\t]+)\t(.*)$/
const paymentLead = /^LINE\s*Pay\s*(?:付款|お支払い|消費|交易|扣款)[\s\S]{0,80}NT\$/i
const explicitTime = /(?:交易|消費|付款)(?:日期|時間)\s*[:：]\s*(?:(\d{4})[/.年-](\d{1,2})[/.月-](\d{1,2})日?\s*)?(\d{1,2}:\d{2})/

export function hasLineChatTransactionTime(body: string): boolean {
  const match = explicitTime.exec(body)
  return !!match && isValidHm(match[4]!.padStart(5, '0')) && (!match[1] || !!validDate(Number(match[1]), Number(match[2]), Number(match[3])))
}

function validDate(year: number, month: number, day: number): string | null {
  const d = new Date(year, month - 1, day)
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? toYmd(d) : null
}

function messageBody(lines: string[]): string {
  const raw = lines.join('\n').trim()
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw
}

function transactionTime(body: string, day: string, messageIso: string, now: Date): string {
  const match = explicitTime.exec(body)
  if (!match || !isValidHm(match[4]!.padStart(5, '0'))) return messageIso
  const statedDay = match[1]
    ? validDate(Number(match[1]), Number(match[2]), Number(match[3]))
    : day
  if (!statedDay) return messageIso
  const iso = localIso(statedDay, match[4]!.padStart(5, '0'))
  return Date.parse(iso) <= now.getTime() ? iso : messageIso
}

async function identity(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('')
}

/** Only the supplied LINE 錢包 export shape is supported in this first version. */
export async function readLineChatText(text: string, fileName: string, now = new Date()): Promise<LineChatReadResult> {
  const empty = (): LineChatReadResult => ({ captures: [], coverage: null, ignored: 0, errors: [] })
  const result = empty()
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (!/^\[LINE\] 與LINE錢包的聊天記錄\s*$/.test(lines[0]?.trim() ?? '')) {
    result.errors.push('這不是支援的 LINE 錢包對話匯出檔')
    return result
  }

  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 120)
  const cutoffDay = toYmd(cutoff)
  const seen = new Map<string, number>()
  let day: string | null = null
  let first: string | null = null
  let last: string | null = null
  let pending: { day: string; time: string; sender: string; lines: string[] } | null = null

  const flush = async () => {
    if (!pending) return
    const msg = pending
    pending = null
    first = first === null || msg.day < first ? msg.day : first
    last = last === null || msg.day > last ? msg.day : last
    if (msg.day < cutoffDay || msg.day > toYmd(now)) return
    const body = messageBody(msg.lines)
    if (msg.sender !== 'LINE錢包' || !paymentLead.test(body)) {
      result.ignored++
      return
    }
    const messageIso = localIso(msg.day, msg.time.padStart(5, '0'))
    if (Date.parse(messageIso) > now.getTime()) return
    const hash = await identity([messageIso, msg.sender, body].join('\u0001'))
    const occurrence = (seen.get(hash) ?? 0) + 1
    seen.set(hash, occurrence)
    const notificationTime = transactionTime(body, msg.day, messageIso, now)
    result.captures.push({
      schemaVersion: 1,
      captureId: `line-chat:${hash}:${occurrence}`,
      derivedId: true,
      sourceApp: 'LINE',
      sourceType: 'line_chat',
      title: 'LINE錢包',
      subtitle: null,
      body,
      notificationTime,
      capturedAt: null,
      fingerprint: hash,
      fileName,
    })
  }

  for (const line of lines) {
    const date = dateHeader.exec(line.trim())
    if (date) {
      await flush()
      day = validDate(Number(date[1]), Number(date[2]), Number(date[3]))
      continue
    }
    const message = messageHeader.exec(line)
    if (message && day && isValidHm(message[1]!.padStart(5, '0'))) {
      await flush()
      pending = { day, time: message[1]!, sender: message[2]!.trim(), lines: [message[3]!] }
    } else if (pending) pending.lines.push(line)
  }
  await flush()
  result.coverage = first && last ? { first, last } : null
  if (!result.coverage) result.errors.push('檔案裡找不到 LINE 對話訊息')
  return result
}

export async function readLineChatFile(file: Pick<File, 'name' | 'size' | 'text'>, now = new Date()): Promise<LineChatReadResult> {
  if (!file.name.toLowerCase().endsWith('.txt')) return { captures: [], coverage: null, ignored: 0, errors: ['請選擇 LINE 匯出的 .txt 檔'] }
  if (file.size > MAX_LINE_CHAT_BYTES) return { captures: [], coverage: null, ignored: 0, errors: ['對話檔超過 12 MB，請分段匯出'] }
  try {
    return await readLineChatText(await file.text(), file.name, now)
  } catch {
    return { captures: [], coverage: null, ignored: 0, errors: ['無法讀取這份 LINE 對話檔'] }
  }
}
