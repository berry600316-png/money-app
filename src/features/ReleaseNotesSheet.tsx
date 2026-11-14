import { BottomSheet } from '../ui/BottomSheet'
import { Overlay } from '../ui/overlay'

// Keep this copy about what people can do. Update it together with the app version before each release.
const release = {
  version: '1.9.3',
  previousVersion: '1.9.2',
  changes: [
    {
      title: '從 LINE 對話找回付款紀錄',
      detail: '匯入 LINE 錢包的聊天文字檔，就能按月份檢查最近 120 天的 LINE Pay 付款。下次重新匯出整段對話，也只會提出還沒處理的付款。',
    },
    {
      title: '匯入前可以逐筆確認',
      detail: '可修改商家、金額、時間和付款來源；可能重複的紀錄會先提醒你。原本使用捷徑匯入通知的方式仍可使用。',
    },
  ],
} as const

export function ReleaseNotesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const current = release.version === __APP_VERSION__
  return (
    <Overlay>
      <BottomSheet
        open={open}
        onClose={onClose}
        labelledBy="release-notes-title"
        className="release-notes-sheet"
        head={
          <div className="sheet-bar">
            <span />
            <h2 id="release-notes-title">這次更新了什麼</h2>
            <button type="button" className="txt-btn strong" onClick={onClose}>完成</button>
          </div>
        }
      >
        <div className="release-notes-body">
          <p className="release-notes-version">Cai Jie {__APP_VERSION__}</p>
          {current ? (
            <>
              <p className="release-notes-compare">相較於 {release.previousVersion}</p>
              <ul className="release-notes-list">
                {release.changes.map((change) => (
                  <li key={change.title}>
                    <h3>{change.title}</h3>
                    <p>{change.detail}</p>
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="release-notes-compare">這個版本的更新內容尚未整理。</p>}
        </div>
      </BottomSheet>
    </Overlay>
  )
}
