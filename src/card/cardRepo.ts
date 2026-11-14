/*
 * All writes of the credit card module (spec §10): one place, each in a single IndexedDB transaction.
 */
import { db, type MoneyDB } from '../db/db'
import { MoneyError, validateFundingState } from '../db/repo'
import type { CardStatement, PaymentMethod, Reconciliation, StatementEntry, Transaction } from '../db/types'
import { chargedTo, isAsset, isCard } from '../lib/accounts'
import { fromYmd, occurredAtFor, toYmd } from '../lib/dates'
import { isValidAmount } from '../lib/money'
import type { PlanRow } from './importPlan'
import {
  keywordKey,
  NOTICE_KEYWORD_MAX,
  NOTICE_KEYWORDS_MAX,
  NOTICE_NAME_MAX,
  NOTICE_TYPES_MAX,
  NOTICE_TYPES_SETTING,
  normKeyword,
  readNoticeTypes,
  targetProblem,
  type NoticeType,
} from './noticeTypes'
import type { DraftEntry } from './statementParser'
import { debitCandidate, debitRelevant } from './debitReconcile'
import { reconcile } from './reconcile'
import { txDate } from './reconcileCommon'

export const NOTIFICATION_SOURCE = 'notification'
export const STATEMENT_SOURCE = 'statement'
/** D-84: { sourceApp: cardId }, the card chosen last time for notifications of that app without card digits. */
export const DEFAULT_CARDS_SETTING = 'notificationDefaultCards'

/** A deleted LINE-imported expense is eligible again; permanent skips remain hidden. */
export async function knownLineChatCaptures(d: MoneyDB = db): Promise<Map<string, string | undefined>> {
  const known = new Map<string, string | undefined>()
  const notices = (await d.importedNotifications.toArray()).filter((n) => n.sourceType === 'line_chat')
  const transactionIds = [...new Set(notices.filter((n) => n.status === 'imported' && n.transactionId).map((n) => n.transactionId!))]
  const existing = new Set((await d.transactions.bulkGet(transactionIds)).filter((tx) => tx !== undefined).map((tx) => tx.id))
  for (const n of notices) {
    if (n.status === 'imported' && n.transactionId && !existing.has(n.transactionId)) continue
    known.set(n.captureId, n.fingerprint)
  }
  return known
}

export async function getDefaultCards(d: MoneyDB = db): Promise<Record<string, string>> {
  return stringMap(d, DEFAULT_CARDS_SETTING)
}

/** D-135: { 'linepay': paymentMethodId }, the payment method each kind of notice was recorded to. */
export const NOTICE_METHODS_SETTING = 'noticeMethods'

export async function getNoticeMethods(d: MoneyDB = db): Promise<Record<string, string>> {
  return stringMap(d, NOTICE_METHODS_SETTING)
}

async function stringMap(d: MoneyDB, key: string): Promise<Record<string, string>> {
  const v = (await d.settings.get(key))?.value
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

/** D-136: the user's payment notice types. */
export async function getNoticeTypes(d: MoneyDB = db): Promise<NoticeType[]> {
  return readNoticeTypes((await d.settings.get(NOTICE_TYPES_SETTING))?.value)
}

export type NoticeTypeInput = Omit<NoticeType, 'id'> & { id?: string }

/**
 * D-136: add or change a notice type. A name (≤ 12), 1–5 keywords (≤ 10 each, none blank or repeated),
 * keywords no other type has (Q120 A: they are what tells the types apart), at most 10 types, and a
 * 行動支付 with one of its cards that can be used now (Q119 A, Q126 A).
 */
export async function saveNoticeType(input: NoticeTypeInput, d: MoneyDB = db): Promise<NoticeType> {
  const name = input.name.trim()
  if (!name) throw new MoneyError('請輸入名稱')
  if (name.length > NOTICE_NAME_MAX) throw new MoneyError(`名稱最多 ${NOTICE_NAME_MAX} 個字`)
  const keywords = input.keywords.map((k) => k.trim())
  if (!keywords.length) throw new MoneyError('至少要有一個關鍵字')
  if (keywords.length > NOTICE_KEYWORDS_MAX) throw new MoneyError(`關鍵字最多 ${NOTICE_KEYWORDS_MAX} 個`)
  if (keywords.some((k) => !k)) throw new MoneyError('關鍵字不能空白')
  const long = keywords.find((k) => k.length > NOTICE_KEYWORD_MAX)
  if (long) throw new MoneyError(`關鍵字最多 ${NOTICE_KEYWORD_MAX} 個字（「${long}」太長）`)
  const twice = keywords.find((k, i) => keywords.findIndex((x) => normKeyword(x) === normKeyword(k)) !== i)
  if (twice) throw new MoneyError(`關鍵字「${twice}」重複了`)
  return d.transaction('rw', d.settings, d.paymentMethods, async () => {
    const all = await getNoticeTypes(d)
    const others = all.filter((t) => t.id !== input.id)
    if (input.id && others.length === all.length) throw new MoneyError('這個通知類型已經不存在')
    if (!input.id && all.length >= NOTICE_TYPES_MAX) throw new MoneyError(`通知類型最多 ${NOTICE_TYPES_MAX} 個`)
    const same = others.find((t) => keywordKey(t.keywords) === keywordKey(keywords))
    if (same) throw new MoneyError(`「${same.name}」已經用了一樣的關鍵字，請換一組`)
    const problem = targetProblem(input, await d.paymentMethods.toArray())
    if (problem) throw new MoneyError(`請重新選擇記到哪張卡（${problem}）`)
    const saved: NoticeType = { id: input.id ?? newId(), name, keywords, paymentMethodId: input.paymentMethodId, cardId: input.cardId }
    const next = input.id ? all.map((t) => (t.id === input.id ? saved : t)) : [...all, saved]
    await d.settings.put({ key: NOTICE_TYPES_SETTING, value: next })
    return saved
  })
}

export async function deleteNoticeType(id: string, d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.settings, async () => {
    const all = await getNoticeTypes(d)
    await d.settings.put({ key: NOTICE_TYPES_SETTING, value: all.filter((t) => t.id !== id) })
  })
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toYmd(fromYmd(s)) === s

/* ---------------- notification import (Phase 1) ---------------- */

export interface ImportSummary {
  imported: number
  duplicates: number
  skipped: number
  failed: number
  batchId: string
}

/**
 * Write the user's choices in one transaction: included rows become expense transactions,
 * every capture (except ones already known) is remembered so it is never imported twice (D-83).
 * D-130: a 行動支付 row is filed under that payment method (created if the user has none yet) with the
 * source the user saw: the card charged (預扣) or the account debited (直接扣).
 * D-131: only notices that became a record keep their text; the rest keep a fingerprint.
 */
export async function commitNotificationImport(
  rows: readonly PlanRow[],
  /** rememberCards: the card the user picked per source app, remembered for next time. */
  opts: { files: number; rememberCards?: Readonly<Record<string, string>> },
  d: MoneyDB = db,
  now = new Date(),
): Promise<ImportSummary> {
  const stamp = now.toISOString()
  const batchId = newId()
  return d.transaction('rw', [d.transactions, d.importedNotifications, d.importBatches, d.categories, d.paymentMethods, d.settings], async () => {
    const known = new Map((await d.importedNotifications.toArray()).map((n) => [n.captureId, n]))
    const summary: ImportSummary = { imported: 0, duplicates: 0, skipped: 0, failed: 0, batchId }
    const seenInBatch = new Set<string>()
    /** The 行動支付 method per channel name, found or created once per import. */
    const channelIds = new Map<string, string>()
    /** D-135: kind of notice → payment method, saved with the import. */
    const linked: Record<string, string> = {}
    const channelMethodId = async (label: string, preferred: string | null): Promise<string> => {
      if (preferred && (await d.paymentMethods.get(preferred))) return preferred
      const hit = channelIds.get(label)
      if (hit) return hit
      const all = await d.paymentMethods.toArray()
      const same = all.filter((p) => (p.type === 'mobile' || p.type === 'other') && p.name.trim().toLowerCase() === label.toLowerCase())
      let id = (same.find((p) => p.isActive) ?? same[0])?.id
      if (!id) {
        const pm: PaymentMethod = { id: newId(), name: label, type: 'mobile', isActive: true, sortOrder: all.reduce((m, p) => Math.max(m, p.sortOrder), -1) + 1 }
        await d.paymentMethods.add(pm)
        id = pm.id
      }
      channelIds.set(label, id)
      return id
    }
    for (const row of rows) {
      const c = row.capture
      const prior = known.get(c.captureId)
      if (prior?.sourceType === 'line_chat' && prior.status === 'imported' && prior.transactionId && !(await d.transactions.get(prior.transactionId))) {
        await d.importedNotifications.delete(prior.id)
        known.delete(c.captureId)
      }
      if (known.has(c.captureId) || seenInBatch.has(c.captureId)) {
        summary.duplicates++
        continue
      }
      seenInBatch.add(c.captureId)
      let transactionId: string | null = null
      let status: 'imported' | 'skipped' | 'not_spending' | 'unparsed' | 'duplicate' =
        row.status === 'not_spending' ? 'not_spending' : row.status === 'unparsed' ? 'unparsed' : 'skipped'
      if ((row.status === 'new' || row.status === 'suspect') && row.include) {
        if (!isValidAmount(row.amount)) throw new MoneyError(`「${row.merchant || '未辨識商店'}」的金額不正確`)
        let paymentMethodId: string
        let link: Pick<Transaction, 'cardId' | 'sourceAccountId'> = {}
        if (row.channel) {
          // D-130: the source the user saw: a card (預扣) or an account (直接扣), never both, never none.
          const src = row.source
          const target = src?.cardId ? await d.paymentMethods.get(src.cardId) : src?.sourceAccountId ? await d.paymentMethods.get(src.sourceAccountId) : undefined
          // D-132: the card used: credit (預扣) or debit (taken from its bank at once).
          if (src?.cardId && (isCard(target) || target?.type === 'debit_card')) link = { cardId: src.cardId }
          else if (src?.sourceAccountId && isAsset(target)) link = { sourceAccountId: src.sourceAccountId }
          else throw new MoneyError(`請選擇「${row.merchant || '這筆消費'}」的付款來源`)
          paymentMethodId = await channelMethodId(row.channel, row.paymentMethodId)
          // D-135: remember it by id, so the next notice of this kind finds it even after a rename (not when a
          // notice type recorded it under another 行動支付).
          if (row.channelKey && row.paymentMethodId === row.channelMethodId) linked[row.channelKey] = paymentMethodId
        } else {
          if (!row.paymentMethodId || !(await d.paymentMethods.get(row.paymentMethodId))) throw new MoneyError('請選擇這些刷卡紀錄的信用卡')
          paymentMethodId = row.paymentMethodId
        }
        const cat = await d.categories.get(row.categoryId)
        if (!cat || cat.type !== 'expense') throw new MoneyError('分類不正確，請重新選擇')
        const tx: Transaction = {
          id: newId(),
          type: 'expense',
          amount: row.amount,
          merchant: row.merchant.trim().slice(0, 40),
          categoryId: row.categoryId,
          paymentMethodId,
          ...link,
          occurredAt: Date.parse(row.occurredAt) > now.getTime() ? stamp : row.occurredAt,
          note: '',
          source: NOTIFICATION_SOURCE,
          externalId: c.captureId,
          createdAt: stamp,
          updatedAt: stamp,
          ...(row.timeSource ? { timeSource: row.timeSource } : {}),
        }
        await d.transactions.add(tx)
        transactionId = tx.id
        status = 'imported'
        summary.imported++
      } else if (row.status === 'duplicate') {
        status = 'duplicate'
        summary.duplicates++
      } else if (row.status === 'unparsed') {
        summary.failed++
      } else if ((row.status === 'new' || row.status === 'suspect') && c.sourceType === 'line_chat' && row.permanentSkip) {
        status = 'skipped'
        summary.skipped++
      } else if (row.status === 'new' || row.status === 'suspect') {
        // Ordinary unticked rows remain eligible on the next import.
        summary.skipped++
        continue
      } else {
        summary.skipped++
      }
      // D-131: the text of a notice that did not become a record (a chat, an offer…) is not kept.
      const keepText = status === 'imported' && c.sourceType !== 'line_chat'
      await d.importedNotifications.add({
        id: newId(),
        captureId: c.captureId,
        sourceApp: c.sourceApp,
        sourceType: c.sourceType,
        title: keepText ? c.title : null,
        subtitle: keepText ? c.subtitle : null,
        body: keepText ? c.body : null,
        fingerprint: c.fingerprint,
        ...(keepText && row.channel ? { sourceConfirmed: true } : {}),
        notificationTime: c.notificationTime,
        capturedAt: c.capturedAt,
        status,
        parsed: status === 'imported' ? { amount: row.amount, merchant: row.merchant, occurredAt: row.occurredAt, cardLast4: row.cardLast4 } : null,
        transactionId,
        batchId,
        importedAt: stamp,
      })
    }
    await d.importBatches.add({ id: batchId, kind: 'notifications', createdAt: stamp, files: opts.files, imported: summary.imported, duplicates: summary.duplicates, skipped: summary.skipped, failed: summary.failed })
    if (Object.keys(linked).length) {
      await d.settings.put({ key: NOTICE_METHODS_SETTING, value: { ...(await getNoticeMethods(d)), ...linked } })
    }
    if (opts.rememberCards && Object.keys(opts.rememberCards).length) {
      await d.settings.put({ key: DEFAULT_CARDS_SETTING, value: { ...(await getDefaultCards(d)), ...opts.rememberCards } })
    }
    await validateFundingState(d)
    return summary
  })
}

/* ---------------- statements (Phase 2) ---------------- */

export interface StatementInput {
  paymentMethodId: string
  statementType?: 'credit_card' | 'debit_card'
  cardLast4?: string | null
  accountId?: string
  pendingCount?: number
  bank: string
  statementMonth: string
  periodStart: string | null
  periodEnd: string | null
  dueDate: string | null
  fileHash: string
  fileName: string
  adapter: string
  confirmed: boolean
  entries: DraftEntry[]
}

/** Existing statement for the same card and month, if any (D-88). */
export async function findSameStatement(paymentMethodId: string, month: string, d: MoneyDB = db): Promise<CardStatement | undefined> {
  return (await d.cardStatements.where('statementMonth').equals(month).toArray()).find((s) => s.paymentMethodId === paymentMethodId)
}

export async function saveStatement(input: StatementInput, opts: { replaceId?: string } = {}, d: MoneyDB = db, now = new Date()): Promise<CardStatement> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.statementMonth)) throw new MoneyError('請選擇帳單月份')
  for (const v of [input.periodStart, input.periodEnd, input.dueDate]) if (v !== null && !isYmd(v)) throw new MoneyError('日期不正確')
  if (input.periodStart && input.periodEnd && input.periodStart > input.periodEnd) throw new MoneyError('帳單週期的開始日不能晚於結束日')
  if (!input.entries.length) throw new MoneyError('沒有任何帳單明細')
  input.entries.forEach((e, i) => {
    if (e.txDate !== null && !isYmd(e.txDate)) throw new MoneyError(`第 ${i + 1} 筆明細的消費日不正確`)
    if (e.postDate !== null && !isYmd(e.postDate)) throw new MoneyError(`第 ${i + 1} 筆明細的入帳日不正確`)
    if (!e.txDate && !e.postDate) throw new MoneyError(`第 ${i + 1} 筆明細缺少日期`)
    if (!Number.isSafeInteger(e.amount) || e.amount === 0 || Math.abs(e.amount) > 99_999_999) throw new MoneyError(`第 ${i + 1} 筆明細的金額不正確`)
  })
  const stamp = now.toISOString()
  return d.transaction('rw', [d.cardStatements, d.statementEntries, d.reconciliations, d.importBatches, d.paymentMethods], async () => {
    const pm = await d.paymentMethods.get(input.paymentMethodId)
    const statementType = input.statementType ?? 'credit_card'
    if (!pm || pm.type !== statementType) throw new MoneyError(statementType === 'debit_card' ? '請選擇金融卡' : '請選擇信用卡')
    if (input.cardLast4 && pm.cardLast4 && input.cardLast4 !== pm.cardLast4) throw new MoneyError('帳單卡號末四碼與所選卡片不符')
    if (statementType === 'debit_card') {
      const account = input.accountId ? await d.paymentMethods.get(input.accountId) : null
      if (!account || account.type !== 'bank') throw new MoneyError('請選擇銀行帳戶')
      if (pm.payFromId && pm.payFromId !== account.id) throw new MoneyError('這張金融卡與所選銀行帳戶不符')
    }
    const existingFile = await d.cardStatements.where('fileHash').equals(input.fileHash).first()
    if (existingFile && existingFile.id !== opts.replaceId) throw new MoneyError('這份帳單已經匯入過')
    if (opts.replaceId) await removeStatement(opts.replaceId, d)
    else if (await findSameStatement(input.paymentMethodId, input.statementMonth, d)) throw new MoneyError('這張卡這個月份已經有帳單')
    const batchId = newId()
    const st: CardStatement = {
      id: newId(),
      paymentMethodId: input.paymentMethodId,
      statementType,
      ...(statementType === 'debit_card' ? { accountId: input.accountId, pendingCount: input.pendingCount ?? 0 } : {}),
      bank: input.bank.trim().slice(0, 20),
      statementMonth: input.statementMonth,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      dueDate: input.dueDate,
      fileHash: input.fileHash,
      fileName: input.fileName.slice(0, 120),
      parseStatus: input.confirmed ? 'confirmed' : 'needs_review',
      adapter: input.adapter,
      batchId,
      createdAt: stamp,
      updatedAt: stamp,
    }
    await d.cardStatements.add(st)
    await d.statementEntries.bulkAdd(
      input.entries.map((e, i): StatementEntry => ({
        id: newId(),
        statementId: st.id,
        txDate: e.txDate,
        postDate: e.postDate,
        merchant: e.merchant.trim().slice(0, 60) || '（未辨識）',
        amount: e.amount,
        currency: e.currency || 'TWD',
        foreign: e.foreign,
        reference: e.reference,
        kind: e.kind,
        ...(e.evidence ? { evidence: e.evidence } : {}),
        raw: e.raw.slice(0, 300),
        order: i,
      })),
    )
    await d.importBatches.add({ id: batchId, kind: 'statement', createdAt: stamp, files: 1, imported: input.entries.length, duplicates: 0, skipped: 0, failed: 0 })
    return st
  })
}

async function removeStatement(id: string, d: MoneyDB) {
  await d.statementEntries.where('statementId').equals(id).delete()
  await d.reconciliations.where('statementId').equals(id).delete()
  await d.cardStatements.delete(id)
}

export async function deleteStatement(id: string, d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', [d.cardStatements, d.statementEntries, d.reconciliations], () => removeStatement(id, d))
}

/** Edit cycle / due date, or confirm the parse after checking it against the PDF (D-87). */
export async function updateStatement(
  id: string,
  patch: Partial<Pick<CardStatement, 'periodStart' | 'periodEnd' | 'dueDate' | 'parseStatus'>>,
  d: MoneyDB = db,
): Promise<void> {
  for (const k of ['periodStart', 'periodEnd', 'dueDate'] as const) if (patch[k] !== undefined && patch[k] !== null && !isYmd(patch[k])) throw new MoneyError('日期不正確')
  await d.transaction('rw', d.cardStatements, async () => {
    const st = await d.cardStatements.get(id)
    if (!st) throw new MoneyError('找不到這份帳單')
    const next = { ...st, ...patch, updatedAt: new Date().toISOString() }
    if (next.periodStart && next.periodEnd && next.periodStart > next.periodEnd) throw new MoneyError('帳單週期的開始日不能晚於結束日')
    await d.cardStatements.put(next)
  })
}

/* ---------------- reconciliation decisions (Phase 3) ---------------- */

const snapshotOf = (t: Transaction) => ({ type: t.type, amount: t.amount, date: txDate(t), paymentMethodId: chargedTo(t),
  sourceAccountId: t.sourceAccountId, cardId: t.cardId, toAccountId: t.toAccountId })

async function assertFree(entryId: string, txId: string, d: MoneyDB, ignoreReconId?: string) {
  const onEntry = (await d.reconciliations.where('entryId').equals(entryId).toArray()).filter((r) => r.status === 'matched' && r.id !== ignoreReconId)
  if (onEntry.length) throw new MoneyError('這筆帳單明細已經有配對')
  const onTx = (await d.reconciliations.where('transactionId').equals(txId).toArray()).filter((r) => r.status === 'matched' && r.entryId && r.id !== ignoreReconId)
  if (onTx.length) throw new MoneyError('這筆記帳已經和其他帳單明細配對')
}

async function pair(statementId: string, entryId: string, tx: Transaction, method: Reconciliation['method'], note: string, d: MoneyDB, now: Date) {
  // A pair replaces any "deferred / explained" note on either side.
  for (const r of await d.reconciliations.where('transactionId').equals(tx.id).toArray()) if (r.status !== 'matched') await d.reconciliations.delete(r.id)
  for (const r of await d.reconciliations.where('entryId').equals(entryId).toArray()) if (r.status !== 'matched') await d.reconciliations.delete(r.id)
  await d.reconciliations.add({ id: newId(), statementId, entryId, transactionId: tx.id, status: 'matched', method, snapshot: snapshotOf(tx), note, createdAt: now.toISOString() })
}

/** Save engine-found pairs. Pairs that became unavailable meanwhile are skipped, never forced. */
export async function saveAutoPairs(statementId: string, pairs: readonly { entryId: string; transactionId: string }[], d: MoneyDB = db, now = new Date()): Promise<number> {
  if (!pairs.length) return 0
  return d.transaction('rw', [d.reconciliations, d.transactions, d.statementEntries, d.cardStatements], async () => {
    const st = await d.cardStatements.get(statementId)
    if (!st || st.parseStatus !== 'confirmed') return 0
    // The view may have computed candidates before a record was edited. Recheck every rule atomically.
    const fresh = reconcile({ statement: st, entries: await d.statementEntries.where('statementId').equals(statementId).toArray(),
      transactions: await d.transactions.toArray(), recons: await d.reconciliations.toArray() })
    const allowed = new Set(fresh.autoPairs.map((p) => `${p.entryId}\u0000${p.transactionId}`))
    let saved = 0
    for (const p of pairs) {
      if (!allowed.has(`${p.entryId}\u0000${p.transactionId}`)) continue
      const tx = await d.transactions.get(p.transactionId)
      const entry = await d.statementEntries.get(p.entryId)
      if (!tx || !entry || entry.statementId !== statementId) continue
      try {
        await assertFree(p.entryId, p.transactionId, d)
      } catch {
        continue
      }
      await pair(statementId, p.entryId, tx, 'auto', '', d, now)
      saved++
    }
    return saved
  })
}

/** Load the chosen records. Strict validation remains for workflows that change the book record. */
async function loadPair(statementId: string, entryId: string, transactionId: string, d: MoneyDB, strict = true) {
  const [tx, entry, st] = await Promise.all([d.transactions.get(transactionId), d.statementEntries.get(entryId), d.cardStatements.get(statementId)])
  if (!tx || !entry || !st || entry.statementId !== statementId) throw new MoneyError('找不到這筆資料')
  if (strict && st.statementType === 'debit_card') {
    if (!debitCandidate(entry, tx, st.paymentMethodId, st.accountId ?? '')) throw new MoneyError('這筆記帳的類型或帳戶與銀行明細不符')
  } else if (strict) {
    if (tx.type !== 'expense') throw new MoneyError('只能和支出配對')
    if (chargedTo(tx) !== st.paymentMethodId) throw new MoneyError('這筆記帳不是用這張卡，請先修改記帳的付款方式')
  }
  return { tx, entry, st }
}

/** Describe differences only in the explicit reconciliation evidence view. */
async function manualPairEvidence(entry: StatementEntry, tx: Transaction, st: CardStatement, d: MoneyDB): Promise<string> {
  const differences: string[] = []
  if (Math.abs(entry.amount) !== tx.amount) differences.push(`金額不同（帳單 ${Math.abs(entry.amount)}，記帳 ${tx.amount}）`)
  const expectedType = entry.kind === 'refund' || entry.kind === 'deposit' ? 'income' : entry.kind === 'transfer_out' ? 'transfer' : 'expense'
  const typeName = { expense: '支出', income: '收入', transfer: '互轉' }
  if (tx.type !== expectedType) differences.push(`收支類型不同（帳單 ${typeName[expectedType]}，記帳 ${typeName[tx.type]}）`)
  const expectedMethod = st.statementType === 'debit_card' && entry.kind !== 'purchase' ? st.accountId ?? st.paymentMethodId : st.paymentMethodId
  const actualMethod = chargedTo(tx)
  if (actualMethod !== expectedMethod) {
    const [expected, actual] = await Promise.all([d.paymentMethods.get(expectedMethod), d.paymentMethods.get(actualMethod)])
    differences.push(`付款方式不同（帳單 ${expected?.name ?? expectedMethod}，記帳 ${actual?.name ?? actualMethod}）`)
  }
  if (st.statementType === 'debit_card' && entry.kind === 'purchase' && actualMethod === st.paymentMethodId
    && tx.sourceAccountId !== st.accountId) {
    const [expected, actual] = await Promise.all([
      st.accountId ? d.paymentMethods.get(st.accountId) : Promise.resolve(undefined),
      tx.sourceAccountId ? d.paymentMethods.get(tx.sourceAccountId) : Promise.resolve(undefined),
    ])
    differences.push(`扣款帳戶不同（帳單 ${expected?.name ?? '未指定'}，記帳 ${actual?.name ?? '未指定'}）`)
  }
  const date = entry.txDate ?? entry.postDate
  if (date && txDate(tx) !== date) differences.push(`日期不同（帳單 ${date}，記帳 ${txDate(tx)}）`)
  if (entry.merchant.trim() && tx.merchant.trim() && entry.merchant.trim() !== tx.merchant.trim())
    differences.push(`名稱不同（帳單 ${entry.merchant}，記帳 ${tx.merchant}）`)
  return differences.length ? `系統註記：${differences.join('；')}` : '帳單與記帳內容相符'
}

/** User confirms a one-to-one association without changing the original transaction. */
export async function matchManually(statementId: string, entryId: string, transactionId: string, note = '', d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', [d.reconciliations, d.transactions, d.statementEntries, d.cardStatements, d.paymentMethods], async () => {
    const { tx, entry, st } = await loadPair(statementId, entryId, transactionId, d, false)
    await assertFree(entryId, transactionId, d)
    const evidence = await manualPairEvidence(entry, tx, st, d)
    await pair(statementId, entryId, tx, 'manual', note ? `${evidence}；${note}` : evidence, d, now)
  })
}

/** A pair broke because the record was edited; the user says it is still the same purchase. One transaction. */
export async function reconfirmPair(reconId: string, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', [d.reconciliations, d.transactions, d.statementEntries, d.cardStatements, d.paymentMethods], async () => {
    const old = await d.reconciliations.get(reconId)
    if (!old || old.status !== 'matched' || !old.entryId || !old.transactionId) throw new MoneyError('找不到這筆核對紀錄')
    const { tx, entry, st } = await loadPair(old.statementId, old.entryId, old.transactionId, d, false)
    await d.reconciliations.delete(reconId)
    await assertFree(old.entryId, tx.id, d)
    await pair(old.statementId, old.entryId, tx, 'manual', `${await manualPairEvidence(entry, tx, st, d)}；記帳修改後重新確認`, d, now)
  })
}

/**
 * §8.3: the user chose to change the record to the statement amount. The record's date is never
 * touched (D-92); the pair is made with the new amount in the same transaction.
 */
export async function applyStatementAmount(statementId: string, entryId: string, transactionId: string, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', [d.reconciliations, d.transactions, d.statementEntries, d.cardStatements, d.paymentMethods], async () => {
    const { tx, entry } = await loadPair(statementId, entryId, transactionId, d)
    if (!isValidAmount(entry.amount)) throw new MoneyError('帳單金額不能用於記帳')
    await assertFree(entryId, transactionId, d)
    const next = { ...tx, amount: entry.amount, updatedAt: now.toISOString() }
    await d.transactions.put(next)
    await validateFundingState(d)
    await pair(statementId, entryId, next, 'manual', `金額由 ${tx.amount} 改為帳單金額`, d, now)
  })
}

/** §8.1: record a missing purchase from the statement and pair it, in one step. */
export async function recordFromEntry(statementId: string, entryId: string, categoryId: string, d: MoneyDB = db, now = new Date()): Promise<Transaction> {
  return d.transaction('rw', [d.reconciliations, d.transactions, d.statementEntries, d.cardStatements, d.categories, d.paymentMethods], async () => {
    const entry = await d.statementEntries.get(entryId)
    const st = await d.cardStatements.get(statementId)
    if (!entry || !st || entry.statementId !== statementId) throw new MoneyError('找不到這筆帳單明細')
    const debit = st.statementType === 'debit_card'
    const income = debit && (entry.kind === 'refund' || entry.kind === 'deposit')
    if (debit && entry.kind === 'withdrawal') throw new MoneyError('提款請用人工確認處理')
    if (!isValidAmount(debit ? Math.abs(entry.amount) : entry.amount)) throw new MoneyError('帳單金額不能用於記帳')
    const cat = await d.categories.get(categoryId)
    if (!cat || cat.type !== (income ? 'income' : 'expense')) throw new MoneyError(income ? '請選擇收入分類' : '請選擇支出分類')
    if (!(await d.paymentMethods.get(st.paymentMethodId))) throw new MoneyError('這張卡已不存在')
    const date = entry.txDate ?? entry.postDate!
    if (date > toYmd(now)) throw new MoneyError('帳單日期在未來，無法補記')
    const stamp = now.toISOString()
    const tx: Transaction = {
      id: newId(),
      type: income ? 'income' : 'expense',
      amount: Math.abs(entry.amount),
      merchant: entry.merchant.slice(0, 40),
      categoryId,
      paymentMethodId: debit && entry.kind !== 'purchase' ? st.accountId! : st.paymentMethodId,
      ...(debit && entry.kind === 'purchase' ? { sourceAccountId: st.accountId! } : {}),
      occurredAt: occurredAtFor(date, now),
      note: '',
      source: STATEMENT_SOURCE,
      externalId: entry.id,
      createdAt: stamp,
      updatedAt: stamp,
    }
    await d.transactions.add(tx)
    await validateFundingState(d)
    await assertFree(entryId, tx.id, d)
    await pair(statementId, entryId, tx, 'created', '由帳單補記', d, now)
    return tx
  })
}

/** A debit bank outflow or inflow that moved between the user's own accounts. */
export async function recordTransferFromEntry(statementId: string, entryId: string, otherAccountId: string, d: MoneyDB = db, now = new Date()): Promise<Transaction> {
  return d.transaction('rw', [d.reconciliations, d.transactions, d.statementEntries, d.cardStatements, d.paymentMethods], async () => {
    const [entry, st, other] = await Promise.all([d.statementEntries.get(entryId), d.cardStatements.get(statementId), d.paymentMethods.get(otherAccountId)])
    if (!entry || !st || entry.statementId !== st.id || st.statementType !== 'debit_card' || !['transfer_out', 'deposit'].includes(entry.kind) || !st.accountId) throw new MoneyError('這筆不是銀行存入或轉出')
    if (!other || !isAsset(other) || other.id === st.accountId) throw new MoneyError('請選擇另一個帳戶')
    const date = entry.txDate ?? entry.postDate!
    if (date > toYmd(now)) throw new MoneyError('帳單日期在未來，無法補記')
    const stamp = now.toISOString()
    const tx: Transaction = { id: newId(), type: 'transfer', amount: Math.abs(entry.amount), merchant: '', categoryId: '',
      paymentMethodId: entry.kind === 'deposit' ? otherAccountId : st.accountId,
      toAccountId: entry.kind === 'deposit' ? st.accountId : otherAccountId,
      occurredAt: occurredAtFor(date, now), note: entry.merchant,
      source: STATEMENT_SOURCE, externalId: entry.id, createdAt: stamp, updatedAt: stamp }
    await d.transactions.add(tx)
    await validateFundingState(d)
    await assertFree(entryId, tx.id, d)
    await pair(statementId, entryId, tx, 'created', '由銀行流水補記互轉', d, now)
    return tx
  })
}

/** §8.2: keep an unmatched record for the next statement. */
export async function deferToNext(statementId: string, transactionId: string, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', d.reconciliations, async () => {
    for (const r of await d.reconciliations.where('transactionId').equals(transactionId).toArray()) if (r.status !== 'matched') await d.reconciliations.delete(r.id)
    await d.reconciliations.add({ id: newId(), statementId, entryId: null, transactionId, status: 'deferred', method: 'manual', snapshot: null, note: '等待下期帳單', createdAt: now.toISOString() })
  })
}

/** Mark one side as explained (e.g. a fee the user does not want to record). */
export async function explain(statementId: string, side: { entryId: string } | { transactionId: string }, note: string, d: MoneyDB = db, now = new Date()): Promise<void> {
  if (!note.trim()) throw new MoneyError('請先填寫確認原因')
  await d.transaction('rw', [d.reconciliations, d.transactions, d.statementEntries, d.cardStatements], async () => {
    const statement = await d.cardStatements.get(statementId)
    if (!statement) throw new MoneyError('找不到這份帳單')
    const tx = 'transactionId' in side ? await d.transactions.get(side.transactionId) : undefined
    if ('transactionId' in side && !tx) throw new MoneyError('找不到這筆記帳')
    if (tx && statement.statementType === 'debit_card' && !debitRelevant(tx, statement.paymentMethodId, statement.accountId ?? '')) throw new MoneyError('這筆記帳不屬於所選金融卡或銀行帳戶')
    if (tx && statement.statementType === 'debit_card' && statement.periodStart && statement.periodEnd && (txDate(tx) < statement.periodStart || txDate(tx) > statement.periodEnd)) throw new MoneyError('這筆記帳不在帳單期間內')
    if ('entryId' in side && (await d.statementEntries.get(side.entryId))?.statementId !== statementId) throw new MoneyError('找不到這筆帳單明細')
    const old = 'entryId' in side
      ? await d.reconciliations.where('entryId').equals(side.entryId).toArray()
      : await d.reconciliations.where('transactionId').equals(side.transactionId).toArray()
    if (old.some((r) => r.status === 'matched')) throw new MoneyError('這筆已經配對，請先取消配對')
    await d.reconciliations.bulkDelete(old.map((r) => r.id))
    await d.reconciliations.add({
      id: newId(), statementId,
      entryId: 'entryId' in side ? side.entryId : null,
      transactionId: 'transactionId' in side ? side.transactionId : null,
      status: 'explained', method: 'manual', snapshot: tx ? snapshotOf(tx) : null,
      note: note.trim().slice(0, 80), createdAt: now.toISOString(),
    })
  })
}

/** An edited manually confirmed record needs an explicit new decision before its mark returns. */
export async function reconfirmExplanation(reconId: string, d: MoneyDB = db, now = new Date()): Promise<void> {
  await d.transaction('rw', [d.reconciliations, d.transactions, d.cardStatements], async () => {
    const decision = await d.reconciliations.get(reconId)
    if (!decision || decision.status !== 'explained' || !decision.transactionId || decision.entryId) throw new MoneyError('找不到人工確認紀錄')
    const tx = await d.transactions.get(decision.transactionId)
    if (!tx) throw new MoneyError('這筆記帳已被刪除')
    const statement = await d.cardStatements.get(decision.statementId)
    if (!statement || statement.statementType !== 'debit_card' || !debitRelevant(tx, statement.paymentMethodId, statement.accountId ?? '')) throw new MoneyError('這筆記帳已不屬於原帳單，請取消確認')
    if (statement.periodStart && statement.periodEnd && (txDate(tx) < statement.periodStart || txDate(tx) > statement.periodEnd)) throw new MoneyError('這筆記帳已不在原帳單期間，請取消確認')
    await d.reconciliations.put({ ...decision, snapshot: snapshotOf(tx), createdAt: now.toISOString() })
  })
}

/** Undo a pair or a note; the engine re-evaluates both sides next time. */
export async function removeDecision(reconId: string, d: MoneyDB = db): Promise<void> {
  await d.reconciliations.delete(reconId)
}
