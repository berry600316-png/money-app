/*
 * Reading notification JSON files written by the iOS Shortcut (D-81).
 * A file holds one capture object or an array of them. Missing fields are allowed.
 */
import { findDates, findTime } from './text'

export const CAPTURE_SCHEMA_VERSION = 1

export interface NotificationCapture {
  schemaVersion: number
  captureId: string
  /** True when the file had no captureId and we derived one from the content. */
  derivedId: boolean
  sourceApp: string
  sourceType: string
  title: string | null
  subtitle: string | null
  body: string | null
  /** ISO, or null when missing / unreadable. */
  notificationTime: string | null
  capturedAt: string | null
  fileName: string
}

/** Small stable string hash (cyrb53) → 14 hex chars. Used only to derive ids for files without one. */
export function contentHash(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

/**
 * Shortcuts may write dates as ISO or as a localized string ("2026年10月11日 下午2:05").
 * Returns ISO or null.
 */
export function readTime(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s)
    return Number.isNaN(t) ? null : new Date(t).toISOString()
  }
  const [ymd] = findDates(s)
  if (!ymd) return null
  const [y, m, d] = ymd.split('-').map(Number)
  const hm = findTime(s.replace(/\d{2,4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{2,4}[/.-]\d{1,2}[/.-]\d{1,2}/, ''))
  return new Date(y, m - 1, d, hm?.[0] ?? 12, hm?.[1] ?? 0).toISOString()
}

export interface ReadResult {
  captures: NotificationCapture[]
  errors: string[]
}

export function readCaptureFile(text: string, fileName: string): ReadResult {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return { captures: [], errors: [`${fileName}：不是 JSON 檔`] }
  }
  const list = Array.isArray(raw) ? raw : [raw]
  const captures: NotificationCapture[] = []
  const errors: string[] = []
  list.forEach((o, i) => {
    const where = list.length > 1 ? `${fileName} 第 ${i + 1} 則` : fileName
    if (typeof o !== 'object' || o === null || Array.isArray(o)) {
      errors.push(`${where}：格式不正確`)
      return
    }
    const r = o as Record<string, unknown>
    const version = typeof r.schemaVersion === 'number' ? r.schemaVersion : CAPTURE_SCHEMA_VERSION
    if (version > CAPTURE_SCHEMA_VERSION) {
      errors.push(`${where}：格式版本比 App 新，請先更新 App`)
      return
    }
    const title = str(r.title)
    const subtitle = str(r.subtitle)
    const body = str(r.body)
    if (!title && !subtitle && !body) {
      errors.push(`${where}：沒有通知內容`)
      return
    }
    const sourceApp = str(r.sourceApp) ?? '未知 App'
    const notificationTime = readTime(r.notificationTime)
    const capturedAt = readTime(r.capturedAt)
    const given = str(r.captureId)
    // No id → derive one from the content, so the same notification imported twice is still caught (D-83).
    const captureId = given ?? 'h-' + contentHash([sourceApp, title, subtitle, body, notificationTime].join('\u0001'))
    captures.push({
      schemaVersion: version,
      captureId,
      derivedId: !given,
      sourceApp,
      sourceType: str(r.sourceType) ?? 'notification',
      title,
      subtitle,
      body,
      notificationTime,
      capturedAt,
      fileName,
    })
  })
  return { captures, errors }
}
