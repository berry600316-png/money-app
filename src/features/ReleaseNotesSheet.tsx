import { BottomSheet } from '../ui/BottomSheet'
import { Overlay } from '../ui/overlay'

// Keep this copy about what people can do. Update it together with the app version before each release.
const release = {
  version: '1.9.4',
  previousVersion: '1.9.3',
  changes: [
    {
      title: 'LINE 對話匯入改用基準點',
      detail: '第一次上傳可設定起點，舊訊息不會再次加入記帳。之後重新匯出整段對話時，只檢查起點之後的新付款；需要時也能手動重設起點。',
    },
    {
      title: '對帳以你的記帳為主',
      detail: '帳單逐筆分成需要處理、已對上與不需記帳。頁面分別顯示記帳和帳單的核對進度，方便找到漏記或尚未對上的項目。',
    },
    {
      title: '帳單明細可逐筆修正',
      detail: '匯入後若發現帳單項目的名稱、金額或日期有誤，可直接修正並重新核對；原本的記帳不會被自動更改。',
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
