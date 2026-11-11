import { BottomSheet } from '../ui/BottomSheet'
import { Overlay } from '../ui/overlay'

// Keep this copy about what people can do. Update it together with the app version before each release.
const release = {
  version: '1.9.0',
  previousVersion: '1.8.7',
  changes: [
    {
      title: '金融卡與帳戶也能對帳',
      detail: '匯入台新簽帳金融卡帳單，確認明細後，就能逐筆核對消費與帳戶金流。對上的記帳會顯示勾選，沒對上的也可以自行確認或補記。',
    },
    {
      title: '常去的商家，自動帶入付款方式',
      detail: '記支出時輸入商家，會參考上次在相同或相似商家使用的付款方式，連同卡片或扣款帳戶一起帶入；儲存前仍可自行改選。',
    },
    {
      title: '餐飲現金支出，時間更好記',
      detail: '選餐飲並用現金付款時，會依記帳當下的時間，預設最接近的早上 8 點、中午 12 點或晚上 6 點；你可以隨時調整。',
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
