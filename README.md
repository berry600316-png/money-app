# Money

個人使用的 iPhone 記帳 App。以 PWA 形式從 Safari 加入主畫面，所有記帳資料只存在 iPhone 本機（IndexedDB），沒有任何後端或雲端服務。

- 產品與架構規格：第 0 章（P0）
- 已定案的產品決策：[`docs/decisions.md`](docs/decisions.md)

## 技術

React · TypeScript · Vite · vite-plugin-pwa（Service Worker）· Dexie.js（IndexedDB）· GitHub Pages

## 在 Windows 上開發

需要 Node.js 20 以上與 Git，不需要 Mac、Xcode 或任何伺服器。

```bash
npm install
npm run dev        # 本機開發，http://localhost:5173
npm test           # 單元測試
npm run build      # 產出 dist/（部署用）
npm run preview    # 在本機預覽正式版，http://localhost:4173/money-app/
```

想在 iPhone 上看畫面：`npm run dev -- --host`，iPhone 與電腦連同一個 Wi-Fi，用 Safari 開終端機顯示的區網網址。
注意：區網網址不是 HTTPS，Service Worker 與離線功能不會啟用，離線行為要在 GitHub Pages 上驗證。

## 分支

| 分支 | 用途 |
|---|---|
| `main` | 正式版。push 到 main 會自動部署到 GitHub Pages |
| `branch` | 開發。確認可以上線後才 merge 回 main |

## 部署到 GitHub Pages

1. 在 GitHub 建立公開 repo `money-app`（免費帳號只有公開 repo 能用 Pages；repo 只有程式碼，沒有任何記帳資料）。
2. repo 的 Settings → Pages → Source 選 **GitHub Actions**。
3. push 到 `main`，`.github/workflows/deploy.yml` 會自動建置並發布到 `https://berry600316-png.github.io/money-app/`。

## 在 iPhone 安裝

1. 用 Safari 開啟 `https://berry600316-png.github.io/money-app/`。
2. 點分享 → 加入主畫面，保持「打開為網頁 App」開啟。
3. 從主畫面的 Money 圖示開啟一次，等設定頁顯示「離線使用：已就緒」，之後沒有網路也能使用。

資料只在這支 iPhone。iOS 仍可能在清除網站資料時刪除它，請定期在設定頁匯出備份。

部署後的實機驗收項目：[`docs/iphone-acceptance.md`](docs/iphone-acceptance.md)。
