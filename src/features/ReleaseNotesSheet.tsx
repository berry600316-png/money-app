import { BottomSheet } from '../ui/BottomSheet'
import { Overlay } from '../ui/overlay'

// Keep this copy about what people can do. Update it together with the app version before each release.
const release = {
  version: '1.9.6',
  previousVersion: '1.9.5',
  changes: [
    {
      title: 'LINE 對話匯入可讀取新增片段',
      detail: '從同一個入口選擇 LINE 錢包聊天文字檔，完整對話或只有新訊息的檔案都能匯入。程式會自動找出尚未處理的付款，之前記好的帳不會更動。',
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
