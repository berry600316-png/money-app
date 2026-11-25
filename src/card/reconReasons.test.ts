import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { MoneyDB } from '../db/db'
import { addReconReason, deleteReconReason, LAST_RECON_REASON_KEY, orderReconReasons, readReconReasons,
  RECON_REASONS_KEY, rememberReconReason, renameReconReason } from './reconReasons'

const d = new MoneyDB('recon-reasons-test')
afterEach(async () => { await d.delete() })

it('starts empty, keeps names unique, and preserves order and previous use', async () => {
  await d.open()
  expect(readReconReasons((await d.settings.get(RECON_REASONS_KEY))?.value)).toEqual([])
  const first = await addReconReason('提款後付現', d)
  const second = await addReconReason('不需另記', d)
  await expect(addReconReason(' 提款後付現 ', d)).rejects.toThrow('已存在')
  await rememberReconReason(first.id, d)
  await orderReconReasons([second.id, first.id], d)
  await renameReconReason(first.id, '現金支付', d)
  expect(readReconReasons((await d.settings.get(RECON_REASONS_KEY))?.value)).toEqual([second, { ...first, label: '現金支付' }])
  expect((await d.settings.get(LAST_RECON_REASON_KEY))?.value).toBe(first.id)
  await deleteReconReason(first.id, d)
  expect(await d.settings.get(LAST_RECON_REASON_KEY)).toBeUndefined()
  expect(readReconReasons((await d.settings.get(RECON_REASONS_KEY))?.value)).toEqual([second])
})
