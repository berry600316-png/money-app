import { db, type MoneyDB } from '../db/db'
import { MoneyError } from '../db/repo'

export const RECON_REASONS_KEY = 'reconReasons'
export const LAST_RECON_REASON_KEY = 'lastReconReasonId'
export interface ReconReason { id: string; label: string }

export function readReconReasons(value: unknown): ReconReason[] {
  if (!Array.isArray(value)) return []
  return value.filter((r): r is ReconReason => r && typeof r.id === 'string' && typeof r.label === 'string'
    && !!r.id && !!r.label.trim()).map((r) => ({ id: r.id, label: r.label }))
}

const list = async (d: MoneyDB) => readReconReasons((await d.settings.get(RECON_REASONS_KEY))?.value)
const save = (items: ReconReason[], d: MoneyDB) => d.settings.put({ key: RECON_REASONS_KEY, value: items })
const clean = (label: string) => {
  const value = label.trim()
  if (!value || value.length > 80) throw new MoneyError('原因請輸入 1～80 個字')
  return value
}
const assertUnique = (items: ReconReason[], label: string, exceptId?: string) => {
  if (items.some((r) => r.id !== exceptId && r.label === label)) throw new MoneyError('這個原因已存在')
}

export async function addReconReason(label: string, d: MoneyDB = db): Promise<ReconReason> {
  return d.transaction('rw', d.settings, async () => {
    const items = await list(d)
    const name = clean(label)
    assertUnique(items, name)
    const added = { id: crypto.randomUUID(), label: name }
    await save([...items, added], d)
    return added
  })
}

export async function renameReconReason(id: string, label: string, d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.settings, async () => {
    const items = await list(d)
    if (!items.some((r) => r.id === id)) throw new MoneyError('找不到這個原因')
    const name = clean(label)
    assertUnique(items, name, id)
    await save(items.map((r) => r.id === id ? { ...r, label: name } : r), d)
  })
}

export async function deleteReconReason(id: string, d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.settings, async () => {
    const items = await list(d)
    await save(items.filter((r) => r.id !== id), d)
    if ((await d.settings.get(LAST_RECON_REASON_KEY))?.value === id) await d.settings.delete(LAST_RECON_REASON_KEY)
  })
}

export async function orderReconReasons(ids: string[], d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.settings, async () => {
    const items = await list(d)
    if (ids.length !== items.length || new Set(ids).size !== ids.length || ids.some((id) => !items.some((r) => r.id === id)))
      throw new MoneyError('原因清單已變更，請重新排序')
    const byId = new Map(items.map((r) => [r.id, r]))
    await save(ids.map((id) => byId.get(id)!), d)
  })
}

export async function rememberReconReason(id: string, d: MoneyDB = db): Promise<void> {
  await d.transaction('rw', d.settings, async () => {
    if (!(await list(d)).some((r) => r.id === id)) throw new MoneyError('請選擇有效的確認原因')
    await d.settings.put({ key: LAST_RECON_REASON_KEY, value: id })
  })
}
