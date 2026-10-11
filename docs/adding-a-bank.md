# 新增一家銀行的解析格式（D-97）

Money 對每家銀行各有一個專用的解析格式（adapter），由**真實樣本**寫成，不靠猜。
沒有格式的銀行仍可使用，但通知全部列在「需要你確認」（金額、商店是推測的，預設不匯入），
帳單會標示「還沒建立這家銀行的帳單格式，以下是通用讀法，請逐筆核對」。

目前已建立的格式：**無**（尚未取得任何真實樣本）。

## 一、樣本怎麼給、放哪裡

真實通知與帳單含有個人消費紀錄，**絕對不能提交到 git**（repo 可能公開在 GitHub）。

- 放在專案根目錄的 `samples-private/<銀行>/`，例如 `samples-private/taishin/`。這個資料夾已被 `.gitignore` 排除。
- 提交前用 `git status` 確認沒有任何 `samples-private` 底下的檔案出現。
- 給樣本前請遮掉：完整卡號（末四碼可以留）、姓名、地址、帳號。商店與金額可以保留，用來對照解析結果。

### 通知：每家銀行盡量各給一則

1. 一般消費（台幣）
2. 附帶回饋或優惠說明的消費（如果銀行會這樣寫）
3. 退款或取消
4. 國外消費
5. 分期
6. 該 App 會發的其他通知（繳款、驗證碼、行銷），各一則

最方便的給法：直接把捷徑存下的 JSON 檔放進 `samples-private/<銀行>/notifications/`。

### 帳單：每家銀行一份 PDF

放進 `samples-private/<銀行>/statements/`。有密碼也沒關係（只在本機開啟）。若不方便給整份，至少給：
帳單上方的基本資料區、明細表的表頭、跨頁的那幾行、最後的合計區（遮蔽個資後的文字即可）。

## 二、寫法（給開發者）

### 通知格式

在 `src/card/notificationAdapters.ts` 的 `NOTIFICATION_ADAPTERS` 加一個物件：

- `id`：例如 `taishin-richart-v1`（銀行改版時另加 `-v2`，舊的保留）。
- `bank`：例如 `台新`。通知沒有卡號末四碼時，若你只有一張這家銀行的卡，就自動對到那張卡。
- `sourceApps`：捷徑寫入的 `sourceApp`，例如 `/^Richart Life$/`。
- `templates`：每種寫法一個，`pattern` 用 `^…$` 錨定整段文字（已轉半形；全形逗號、冒號會變成 `,`、`:`），
  用具名群組取欄位：`amount`（消費必填）、`merchant`、`last4`、`date`、`time`。非消費的寫法用 `kind: 'not_spending'` 加 `reason`。
  整段文字是「標題、副標題、內文」以換行相接；對不上時會再拿「只有內文」比對一次（適合標題會變動的 App）。

範例見 `src/card/fixtures.ts` 的 `SIM_NOTIFICATION_ADAPTER`（模擬寫法，只給測試用，沒有註冊進 App）。

符合任一 template 的通知會直接列為「新的刷卡紀錄」；同一個 App 但寫法對不上任何 template 的，退回通用推測並標示
「寫法和已建立的格式不同（可能是銀行改版）」，請使用者確認。

### 帳單格式

在 `src/card/statementAdapters.ts` 的 `STATEMENT_ADAPTERS` 加一個物件：

- `id`：例如 `taishin-v1`，會存在帳單紀錄上。
- `bank`：例如 `台新`。

- `detect(lines)`：用這家銀行帳單**版面上固定的多個字樣**判斷（例如表頭欄位名稱），不要只看銀行名稱。
- `parse(lines)`：照真實帳單的欄位位置讀出基本資料與逐筆明細，回傳 `ParsedStatement`（型別在 `src/card/statementParser.ts`）。
  明細加總與「本期新增款項」的比對、讀不懂的行放進 `unreadLines`，這些原則和通用讀法相同。

### 測試

- 以真實樣本為底，改寫成**結構完全相同、但商店與金額換成假資料**的測試文字，寫進 `src/card/card.test.ts`。
  真實原文只留在 `samples-private/`。
- 每個 template 至少一個測試；再加上「同一個 App 的陌生寫法會退回需要確認」的測試。
- 跑 `npx tsc -b`、`npx vitest run`、`npm run build`。
