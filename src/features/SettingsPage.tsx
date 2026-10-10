import { useTxCount } from '../db/hooks'
import { usePwaState } from '../pwa/pwa'
import { Icon } from '../ui/Icon'
import { useRefData } from '../ui/refData'

export function SettingsPage({
  open,
  covered,
  onBack,
  onCategories,
  onPayments,
}: {
  open: boolean
  covered: boolean
  onBack: () => void
  onCategories: () => void
  onPayments: () => void
}) {
  const pwa = usePwaState()
  const ref = useRefData()
  const count = useTxCount()
  const activeCats = ref.categories.filter((c) => c.isActive).length
  const activePays = ref.payments.filter((p) => p.isActive).length

  const persisted =
    pwa.persisted === true ? { text: '已啟用', warn: false } : pwa.persisted === false ? { text: '未啟用', warn: true } : { text: '無法確認', warn: true }
  const offline = !pwa.supported ? { text: '未啟用', warn: true } : pwa.offlineReady ? { text: '已就緒', warn: false } : { text: '準備中', warn: true }

  return (
    <section className={'page' + (open ? ' open' : '') + (covered ? ' covered' : '')} aria-label="設定" aria-hidden={!open} inert={!open || covered}>
      <div className="page-head">
        <button type="button" className="back" onClick={onBack}>
          <Icon name="left" />
          首頁
        </button>
        <h1>設定</h1>
        <span />
      </div>

      <div className="set-sec">
        <h2>資料保存</h2>
        <div className="set-card">
          <div className="srow">
            <span className="s-main">儲存位置</span>
            <span className="s-val">只在這支 iPhone</span>
          </div>
          <div className="srow">
            <span className="s-main">持久保存</span>
            <span className="s-val">
              <i className={persisted.warn ? 'warn' : ''} />
              {persisted.text}
            </span>
          </div>
          <div className="srow">
            <span className="s-main">離線使用</span>
            <span className="s-val">
              <i className={offline.warn ? 'warn' : ''} />
              {offline.text}
            </span>
          </div>
        </div>
        <p className="set-foot">
          資料不會上傳到任何地方。iOS 在清除網站資料時仍可能刪除它們，請定期匯出備份。
          {!pwa.supported && ' 離線功能只在正式網址（HTTPS）啟用。'}
          {pwa.supported && !pwa.offlineReady && ' 第一次開啟需要網路完成離線準備，完成前請先不要關閉網路。'}
          {pwa.persisted === false && ' 從主畫面開啟並記下幾筆後，iOS 通常會改為允許持久保存。'}
        </p>
      </div>

      <div className="set-sec">
        <h2>
          備份與匯出<span className="tag">下一階段</span>
        </h2>
        <div className="set-card">
          <button type="button" className="srow off" disabled>
            <span className="s-main">
              匯出完整備份<span className="s-sub">JSON 檔，可用來還原</span>
            </span>
          </button>
          <button type="button" className="srow off" disabled>
            <span className="s-main">
              從備份還原<span className="s-sub">會取代目前的資料</span>
            </span>
          </button>
          <button type="button" className="srow off" disabled>
            <span className="s-main">
              匯出交易 CSV<span className="s-sub">可用 Numbers 或 Excel 開啟</span>
            </span>
          </button>
        </div>
      </div>

      <div className="set-sec">
        <h2>分類與付款方式</h2>
        <div className="set-card">
          <button type="button" className="srow" onClick={onCategories}>
            <span className="s-main">分類</span>
            <span className="s-val">{activeCats} 個使用中</span>
            <Icon name="chev" className="chev" />
          </button>
          <button type="button" className="srow" onClick={onPayments}>
            <span className="s-main">付款方式</span>
            <span className="s-val">{activePays} 個使用中</span>
            <Icon name="chev" className="chev" />
          </button>
        </div>
      </div>

      <p className="colophon">
        Money {__APP_VERSION__}
        <br />
        {count !== undefined && `共 ${count.toLocaleString('en-US')} 筆紀錄`}
      </p>
    </section>
  )
}
