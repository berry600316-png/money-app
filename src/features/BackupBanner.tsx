import { useLiveQuery } from 'dexie-react-hooks'
import { addedSince, shouldRemindBackup } from '../backup/store'
import { db } from '../db/db'
import { daysBetween } from '../lib/dates'
import { Icon } from '../ui/Icon'
import { useToast } from '../ui/Toast'

/** D-41: one dismissible line on the home screen when a backup is overdue. */
export function BackupBanner({ onBackup }: { onBackup: () => void }) {
  const toast = useToast()
  const state = useLiveQuery(async () => {
    const get = async (k: string) => ((await db.settings.get(k))?.value as string | undefined) ?? null
    const [lastBackupAt, installedAt, dismissedAt] = await Promise.all([get('lastBackupAt'), get('installedAt'), get('backupReminderDismissedAt')])
    const added = await addedSince(lastBackupAt ?? installedAt)
    const show = shouldRemindBackup({ now: new Date(), lastBackupAt, installedAt, dismissedAt, addedSince: added })
    return { show, lastBackupAt }
  }, [])

  if (!state?.show) return null
  const text = state.lastBackupAt ? `已經 ${daysBetween(state.lastBackupAt)} 天沒有備份` : '還沒有備份過'

  return (
    <div className="banner" role="status">
      <Icon name="clock" />
      <span>{text}</span>
      <button type="button" className="banner-act" onClick={onBackup}>
        備份
      </button>
      <button
        type="button"
        aria-label="先不要提醒"
        onClick={() => {
          db.settings
            .put({ key: 'backupReminderDismissedAt', value: new Date().toISOString() })
            .then(() => toast('7 天後再提醒'), () => toast('無法關閉提醒，請再試一次', { kind: 'error' }))
        }}
      >
        <Icon name="x" />
      </button>
    </div>
  )
}
