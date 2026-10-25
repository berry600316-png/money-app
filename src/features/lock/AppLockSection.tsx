/*
 * D-146: 設定 › 隱私 › App 鎖. Turning it on: the App PIN (twice), then Face ID (may be skipped or added later).
 * Turning it off, changing the PIN or setting Face ID again: verify first (Face ID, the App PIN as last resort).
 */
import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import {
  APP_LOCK_KEY,
  passkeyAvailable,
  passkeyUnusable,
  readLockConfig,
  registerPasskey,
  saveLockConfig,
  type AppLockConfig,
} from '../../lib/appLock'
import { Icon } from '../../ui/Icon'
import { useToast } from '../../ui/Toast'
import { LockPanel, PinPad, Screen } from './LockScreen'

type Flow =
  | { step: 'verify'; next: 'off' | 'pin' | 'face' }
  | { step: 'pin1'; enabling: boolean; error?: string }
  | { step: 'pin2'; enabling: boolean; first: string }
  | { step: 'face'; enabling: boolean; error?: string }

/** The "add Face ID" step, in the lock screen's look. */
function FaceStep({ enabling, error, onAdd, onSkip }: { enabling: boolean; error?: string; onAdd: () => Promise<void>; onSkip: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Screen label="加入 Face ID" onEsc={onSkip}>
      {!enabling && (
        <button type="button" className="lk-cancel" onClick={onSkip}>
          取消
        </button>
      )}
      <div className="lk-top">
        <h2 className="lk-name">加入 Face ID</h2>
        <p className="lk-msg">
          之後打開 App 用 Face ID 就能進去；
          <br />
          Face ID 不成功時，可以輸入 iPhone 密碼。
        </p>
        {error && <p className="lk-err">{error}</p>}
      </div>
      <div className="lk-act">
        <button
          type="button"
          className="lk-btn"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void onAdd().finally(() => setBusy(false))
          }}
        >
          <Icon name="faceId" />
          {error ? '再試一次' : '加入 Face ID'}
        </button>
        {enabling && (
          <button type="button" className="lk-link" onClick={onSkip}>
            先不要，只用 App 密碼
          </button>
        )}
      </div>
    </Screen>
  )
}

export function AppLockSection() {
  const toast = useToast()
  const raw = useLiveQuery(async () => (await db.settings.get(APP_LOCK_KEY))?.value ?? null, [])
  const cfg: AppLockConfig | null | undefined = raw === undefined ? undefined : readLockConfig(raw)
  const [flow, setFlow] = useState<Flow | null>(null)
  const close = () => setFlow(null)
  const canFace = passkeyAvailable()

  const afterVerify = async (next: 'off' | 'pin' | 'face') => {
    if (next === 'off') {
      await saveLockConfig(null)
      close()
      toast('已關閉 App 鎖')
    } else if (next === 'pin') setFlow({ step: 'pin1', enabling: false })
    else setFlow({ step: 'face', enabling: false })
  }

  const addFace = async (enabling: boolean) => {
    const cur = readLockConfig((await db.settings.get(APP_LOCK_KEY))?.value)
    if (!cur) return close()
    try {
      const id = await registerPasskey()
      await saveLockConfig({ ...cur, credentialId: id })
      close()
      toast(enabling ? '已開啟 App 鎖' : '已設定 Face ID')
    } catch (err) {
      const msg = passkeyUnusable(err) ? '這支 iPhone 現在無法加入 Face ID，之後可以在設定再試。' : '沒有完成，可以再試一次。'
      setFlow({ step: 'face', enabling, error: msg })
    }
  }

  if (cfg === undefined) return null
  const pinTitle = (enabling: boolean) => (enabling ? '設定 App 密碼' : '輸入新的 App 密碼')

  return (
    <div className="set-sec">
      <h2>隱私</h2>
      <div className="set-card">
        <div className="srow">
          <span className="s-main">
            App 鎖
            <small className="s-sub">{cfg ? '離開超過 1 分鐘回來也要解鎖' : '打開 App 時要先驗證才看得到資料'}</small>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="App 鎖"
              checked={!!cfg}
              onChange={() => setFlow(cfg ? { step: 'verify', next: 'off' } : { step: 'pin1', enabling: true })}
            />
            <span />
          </label>
        </div>
        {cfg && (
          <>
            <button
              type="button"
              className="srow"
              disabled={!canFace}
              onClick={() => setFlow(cfg.credentialId ? { step: 'verify', next: 'face' } : { step: 'face', enabling: false })}
            >
              <span className="s-main">
                Face ID
                {!cfg.credentialId && <small className="s-sub lock-warn">{canFace ? '尚未啟用，目前只用 App 密碼' : '這個裝置無法使用'}</small>}
              </span>
              <span className="s-val">{cfg.credentialId ? '已啟用' : canFace ? '加入' : ''}</span>
              {canFace && <Icon name="chev" className="chev" />}
            </button>
            <button type="button" className="srow" onClick={() => setFlow({ step: 'verify', next: 'pin' })}>
              <span className="s-main">更改 App 密碼</span>
              <Icon name="chev" className="chev" />
            </button>
          </>
        )}
      </div>
      <p className="set-foot">
        {cfg
          ? '關掉 App 鎖、更改密碼、重新設定 Face ID 前，都要先驗證一次。App 鎖只擋畫面，資料本身沒有加密，也不會放進備份檔。'
          : '開啟後，打開 App 先用 Face ID（不成功時可輸入 iPhone 密碼）解鎖；App 密碼只在 Face ID 不能用時才用。'}
      </p>

      {flow?.step === 'verify' && cfg && <LockPanel mode="verify" cfg={cfg} onUnlocked={() => void afterVerify(flow.next)} onCancel={close} />}
      {flow?.step === 'pin1' && (
        <Screen className="lock-pin" label="設定 App 密碼" onEsc={close}>
          <PinPad
            key="pin1"
            title={pinTitle(flow.enabling)}
            sub={
              <>
                Face ID 不能用時才會用到。
                <br />
                請輸入 6 位數字，下一步會再輸入一次。
              </>
            }
            error={flow.error}
            onSubmit={(pin) => {
              setFlow({ step: 'pin2', enabling: flow.enabling, first: pin })
              return true
            }}
            onCancel={close}
          />
        </Screen>
      )}
      {flow?.step === 'pin2' && (
        <Screen className="lock-pin" label="設定 App 密碼" onEsc={close}>
          <PinPad
            key="pin2"
            title="再輸入一次"
            onSubmit={async (pin) => {
              if (pin !== flow.first) {
                setFlow({ step: 'pin1', enabling: flow.enabling, error: '兩次輸入不同，請重新設定' })
                return true
              }
              if (flow.enabling) {
                await saveLockConfig({ pin, credentialId: null })
                if (canFace) setFlow({ step: 'face', enabling: true })
                else {
                  close()
                  toast('已開啟 App 鎖')
                }
              } else {
                const cur = readLockConfig((await db.settings.get(APP_LOCK_KEY))?.value)
                await saveLockConfig({ pin, credentialId: cur?.credentialId ?? null })
                close()
                toast('已更改 App 密碼')
              }
              return true
            }}
            onCancel={close}
          />
        </Screen>
      )}
      {flow?.step === 'face' && (
        <FaceStep
          enabling={flow.enabling}
          error={flow.error}
          onAdd={() => addFace(flow.enabling)}
          onSkip={() => {
            close()
            if (flow.enabling) toast('已開啟 App 鎖')
          }}
        />
      )}
    </div>
  )
}
