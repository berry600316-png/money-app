import { useLiveQuery } from 'dexie-react-hooks'
import { shouldRemindBackup } from '../backup/store'
import { db } from '../db/db'
import { Icon } from '../ui/Icon'
import { useToast } from '../ui/Toast'

/** D-102: one quiet line on the home screen when the last backup is over 30 days old. */
export function BackupBanner({ onBackup }: { onBackup: () => void }) {
  const toast = useToast()
  const state = useLiveQuery(async () => {
    const get = async (k: string) => ((await db.settings.get(k))?.value as string | undefined) ?? null
    const [lastBackupAt, installedAt, dismissedAt] = await Promise.all([get('lastBackupAt'), get('installedAt'), get('backupReminderDismissedAt')])
    const show = shouldRemindBackup({ now: new Date(), lastBackupAt, installedAt, dismissedAt })
    return { show, lastBackupAt }
  }, [])

  if (!state?.show) return null
  const last = state.lastBackupAt ? new Date(state.lastBackupAt) : null

  return (
    <div className="banner" role="status">
      <Icon name="clock" />
      <span>
        已經超過 30 天沒有備份
        <small>{last ? `上次備份：${last.getMonth() + 1} 月 ${last.getDate()} 日` : '還沒有備份過'}</small>
      </span>
      <button type="button" className="banner-act" onClick={onBackup}>
        立即備份
      </button>
      <button
        type="button"
        className="banner-later"
        onClick={() => {
          db.settings
            .put({ key: 'backupReminderDismissedAt', value: new Date().toISOString() })
            .then(() => toast('7 天後再提醒'), () => toast('無法延後提醒，請再試一次', { kind: 'error' }))
        }}
      >
        稍後提醒
      </button>
    </div>
  )
}
