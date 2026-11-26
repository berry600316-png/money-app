import { BottomSheet } from '../ui/BottomSheet'
import { Overlay } from '../ui/overlay'

// Keep this copy about what people can do. Update it together with the app version before each release.
const release = {
  version: '1.9.11',
  previousVersion: '1.9.10',
  changes: [
    {
      title: '跨月帳單可接續核對',
      detail: '記帳尚未出現在本期帳單時，可選「等待下期帳單」。下期匯入後，符合條件的交易會自動對上；仍找不到的再請你處理。',
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
