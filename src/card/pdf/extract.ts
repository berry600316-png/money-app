/*
 * Statement parsing, layer 1 (D-86, D-87): PDF bytes → text lines, entirely on the device.
 * Knows nothing about banks. Loaded lazily so PDF.js only downloads its ~1.6 MB when used,
 * and is precached for offline use.
 */
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export class PdfPasswordError extends Error {
  constructor(public readonly wrong: boolean) {
    super(wrong ? '密碼不正確' : '這份 PDF 需要密碼')
  }
}

export class PdfReadError extends Error {}

export interface PdfText {
  pages: number
  lines: string[]
  /** Text items found; 0 means a scanned image PDF (not supported, D-86). */
  items: number
}

interface Item {
  str: string
  x: number
  y: number
  w: number
  h: number
}

/** Group positioned text into visual lines; wide gaps become double spaces so columns stay apart. */
function toLines(items: Item[]): string[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: Item[][] = []
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y - it.y) <= Math.max(2, Math.min(r[0].h, it.h) * 0.5))
    if (row) row.push(it)
    else rows.push([it])
  }
  return rows
    .map((r) => r.sort((a, b) => a.x - b.x))
    .map((r) => {
      let line = ''
      let end = -Infinity
      for (const it of r) {
        const gap = it.x - end
        const charW = it.str.length ? it.w / it.str.length : 4
        if (line) line += gap > charW * 1.5 ? '  ' : gap > charW * 0.25 ? ' ' : ''
        line += it.str
        end = it.x + it.w
      }
      return line.trim()
    })
    .filter(Boolean)
}

/**
 * Read all text. The password is used for this call only and never stored (spec §6.2).
 * Throws PdfPasswordError (need / wrong) or PdfReadError.
 */
export async function extractPdfText(data: ArrayBuffer, password?: string): Promise<PdfText> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    password,
    cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
    cMapPacked: true,
    disableFontFace: true,
  })
  let doc: pdfjs.PDFDocumentProxy
  try {
    doc = await task.promise
  } catch (e) {
    const err = e as { name?: string; code?: number }
    if (err?.name === 'PasswordException') throw new PdfPasswordError(err.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD)
    throw new PdfReadError('無法開啟這份 PDF，檔案可能已損毀')
  }
  try {
    const lines: string[] = []
    let count = 0
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      const items: Item[] = []
      for (const raw of content.items) {
        if (!('str' in raw) || !raw.str.trim()) continue
        items.push({ str: raw.str, x: raw.transform[4], y: raw.transform[5], w: raw.width, h: raw.height || Math.abs(raw.transform[3]) || 10 })
      }
      count += items.length
      lines.push(...toLines(items))
      page.cleanup()
    }
    return { pages: doc.numPages, lines, items: count }
  } finally {
    void doc.destroy()
  }
}

/** SHA-256 of the file, used to refuse importing the same statement twice (D-88). */
export async function sha256(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
