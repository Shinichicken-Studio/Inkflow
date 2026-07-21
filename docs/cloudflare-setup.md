# InkFlow 統計後台：Cloudflare 設定教學

從零到「後台看得到數字」，照著做大約 20 分鐘。全部免費，不需要信用卡。

> 指令都在 **PowerShell** 執行。注意 PowerShell 5.1 沒有 `&&`，所以每行指令要分開執行、
> 不要把兩行接在一起。所有指令都在 `E:\program\Inkflow\worker` 這個資料夾裡跑。

---

## 這套東西長什麼樣

```
玩家的瀏覽器                      Cloudflare（免費）              你
index.html ──送匿名事件──▶  Worker  ──寫入──▶  D1 資料庫  ──▶  後台網頁
（analytics.js）              inkflow-analytics                 /admin?token=…
```

- **Worker**＝一支跑在 Cloudflare 上的小程式，負責收資料和產生後台頁面。
- **D1**＝Cloudflare 附的 SQLite 資料庫，資料存這裡。
- 你不需要租主機、不需要管伺服器。

---

## 步驟 0：準備

1. 到 <https://dash.cloudflare.com/sign-up> 註冊一個免費帳號（信箱＋密碼，要收信認證）。
2. 註冊完先不用做任何設定，回到這裡繼續。
3. 確認電腦有 Node.js：PowerShell 執行 `node --version`，有印出版本號就行
   （你的機器已確認是 v24.18.0）。

---

## 步驟 1：安裝 wrangler 並登入

`wrangler` 是 Cloudflare 的命令列工具。官方建議裝在專案裡、不要裝全域。

```powershell
cd E:\program\Inkflow\worker
npm install -D wrangler@latest
```

> 我已經先幫你跑過這一步，`worker\node_modules` 存在就代表裝好了，可以直接跳到登入。

登入（會自動開瀏覽器，按「Allow」授權）：

```powershell
npx wrangler login
```

終端機出現 `Successfully logged in.` 就成功了。如果瀏覽器沒自動開，把終端機印出的那串
網址自己複製到瀏覽器貼上即可。

---

## 步驟 2：建立資料庫

```powershell
npx wrangler d1 create inkflow-analytics
```

它會印出一段設定，長得像這樣：

```
[[d1_databases]]
binding = "DB"
database_name = "inkflow-analytics"
database_id = "8f4c1e2a-xxxx-xxxx-xxxx-9b7d6e5f4a3b"
```

**把那串 `database_id` 複製起來**，打開 [worker/wrangler.toml](../worker/wrangler.toml)，
把 `貼上你的-database-id` 換成它。

> 有些版本的 wrangler 會問你「要不要自動寫進設定檔？」，選 **Yes** 的話它會自己填好，
> 你只要打開檔案確認 `database_id` 不再是預設文字就好。

---

## 步驟 3：建立資料表

```powershell
npx wrangler d1 execute inkflow-analytics --remote --file=./schema.sql
```

**`--remote` 一定要加**——不加的話 SQL 只會跑在你電腦上的本機模擬資料庫，
線上是空的，之後就會出現「明明部署了卻查不到資料」的鬼打牆。

成功會看到類似 `Executed 5 commands` 的訊息。

---

## 步驟 4：設定後台密碼

後台網址是公開的，靠一組密碼保護。自己想一組長一點的（建議 20 字以上、英數混合）：

```powershell
npx wrangler secret put ADMIN_TOKEN
```

它會要你輸入，貼上你想好的密碼後按 Enter。**這組密碼請自己存好**（密碼管理器或記事本），
它不會寫進任何檔案，之後看後台要用。

> 為什麼不寫在 wrangler.toml？因為那個檔會進 git、會被推上 GitHub，等於密碼公開。

---

## 步驟 5：部署

```powershell
npx wrangler deploy
```

成功會印出你的網址，長得像：

```
https://inkflow-analytics.你的帳號名.workers.dev
```

**把這個網址記下來**，下一步要用。

---

## 步驟 6：把網址填回遊戲

打開 [analytics.js](../analytics.js)，找到最上面這一行：

```js
var ENDPOINT = "";
```

改成你的網址，**後面要加 `/e`**：

```js
var ENDPOINT = "https://inkflow-analytics.你的帳號名.workers.dev/e";
```

⚠️ 沒有 `/e` 的話事件會送到後台頁面而不是收集端點，資料不會進資料庫。

> 這行留空就是「完全關閉統計」。想暫時停掉統計，把它改回 `""` 重新推上去即可。

---

## 步驟 7：開啟 GitHub Pages

1. 瀏覽器打開 <https://github.com/Shinichicken-Studio/Inkflow/settings/pages>
2. **Source** 選 `Deploy from a branch`
3. **Branch** 選 `main`、資料夾選 `/ (root)`，按 **Save**
4. 等 1–2 分鐘，頁面上方會出現你的網址：
   `https://shinichicken-studio.github.io/Inkflow/`

然後把改好的檔案推上去：

```powershell
cd E:\program\Inkflow
git add analytics.js index.html worker docs
git commit -m "feat: 加入匿名遊玩統計"
git push
```

---

## 步驟 8：驗證真的通了

1. 用**手機或無痕視窗**打開 `https://shinichicken-studio.github.io/Inkflow/`
2. 按「開始遊戲」，隨便玩個一兩分鐘，玩到贏或輸都可以
3. **關掉分頁**（很重要——停留時間是在離開時送出的）
4. 打開後台：

```
https://inkflow-analytics.你的帳號名.workers.dev/admin?token=你的ADMIN_TOKEN
```

看到「造訪人次 1」就成功了。

**看不到數字的話**，開著遊戲頁面按 F12 → Network 分頁，找有沒有一個送往
`/e` 的請求、狀態是不是 `204`。紅色的話點開看錯誤訊息，對照下面的疑難排解。

---

## 日常使用

| 想做什麼 | 怎麼做 |
|---|---|
| 看數據 | 開 `https://…workers.dev/admin?token=你的密碼`（存成書籤） |
| 看即時錯誤 | `npx wrangler tail`（在 worker 資料夾執行，會即時印出線上請求） |
| 改後端邏輯 | 改 `worker/src/worker.js` → `npx wrangler deploy` |
| 改資料表 | 改 `schema.sql` → 用 `d1 execute --remote` 跑 ALTER TABLE |
| 直接查資料 | `npx wrangler d1 execute inkflow-analytics --remote --command="SELECT * FROM events ORDER BY id DESC LIMIT 20"` |
| 清掉測試資料 | `npx wrangler d1 execute inkflow-analytics --remote --command="DELETE FROM events"` |

後台頁面右上可切換期間（今天／7 天／14 天／30 天／90 天）。

---

## 後台各欄位怎麼讀

- **造訪人次**：載入頁面的次數（同一人今天來兩次算兩次）。
- **真的開始玩**：按下「開始遊戲」離開封面的人次。
- **封面轉換率**：上面兩者相除。**這個數字偏低就代表封面留不住人**（或載入太慢）。
- **平均停留**：只算「分頁在前景」的時間。切到別的分頁、鎖螢幕都不計入，
  所以這個數字比一般分析工具保守，但它才是真的在玩的時間。
- **棄坑時已走幾步**：玩家中途換關、重試或關掉分頁時已經走了幾步。
  某個難度大量集中在某個步數，代表那裡有設計問題。
- **裝置**：以觸控能力判斷手機／桌機，不儲存 User-Agent 字串。

---

## 費用與額度

Cloudflare 免費方案（官方公告數字，2026-07 查證）：

- Workers：每日 **10 萬次請求**
- D1：每日 **500 萬列讀取**、**10 萬列寫入**；單一資料庫 **500MB**、帳號總計 5GB

一個玩十分鐘的玩家大約產生 30 筆事件。**保守估計每天 1,000～3,000 場遊戲以內都在免費額度內**
（保守是因為資料庫索引維護也會計入寫入量，實際消耗會比事件數多一些——這是我的估算，不是官方數字）。

超過了怎麼辦：打開 [analytics.js](../analytics.js) 把 `FLUSH_INTERVAL_MS` 從 `30000`
改成 `60000`（心跳從 30 秒變 60 秒），事件量直接減半，停留時間的精度從 30 秒變 60 秒。

---

## 隱私與上架

這套設計刻意不收集個資，之後上架 App Store／Google Play 時可以誠實宣告「不收集個人資料」：

- ❌ 不存 IP、不存 User-Agent、沒有帳號、沒有第三方追蹤 SDK
- ✅ 只有一組隨機產生的匿名 id（存在玩家自己的裝置，用來分辨回訪）
- ✅ 尊重瀏覽器的 Do Not Track 設定（開啟時自動停用）
- ✅ 玩家可自行退出：主控台執行 `InkflowAnalytics.optOut()`
  （上架前建議在設定選單加一個開關接這個函式）

因為沒有 cookie、也不做跨站追蹤，目前不需要同意橫幅。**但這不是法律意見**——
真的要上架前，隱私政策內容建議找懂當地法規的人確認。

---

## 改動後怎麼驗證（不用部署到線上）

`worker/` 附了兩支測試，全部在本機跑，不會碰到線上資料：

```powershell
# 第一個終端機：啟動本機模擬的 Worker + D1
cd E:\program\Inkflow\worker
npx wrangler dev

# 第二個終端機：跑測試
cd E:\program\Inkflow\worker
npm test
```

- `test-worker.mjs`（22 項）：收事件、擋畸形輸入、token 權限、統計數字算得對不對。
- `test-analytics.mjs`（29 項）：用假的瀏覽器載入真正的 `analytics.js`，
  驗證停用條件、匿名 id、停留時間累加與睡眠夾住、離開頁面補記棄坑，
  最後真的把事件送進本機 Worker 走一次完整流程。

本機測試用的密碼放在 `worker/.dev.vars`（已在 .gitignore，不會進 git）。

遊戲本身的測試不受影響，照舊：`node test.js` 與 `index.html#autotest`。

---

## 疑難排解

**`npx wrangler login` 卡住不動**
→ 終端機裡有一串 `https://dash.cloudflare.com/oauth2/auth?...`，自己複製貼到瀏覽器。

**部署時說 `database_id` 無效**
→ `wrangler.toml` 裡還是預設文字，回步驟 2 貼上真的 id。

**後台顯示「token 不正確」**
→ 密碼打錯，或當初 `secret put` 時多貼了一個換行。重跑一次步驟 4 覆蓋掉即可。

**後台顯示「伺服器尚未設定 ADMIN_TOKEN」**
→ 步驟 4 沒做，或做完後沒有重新 `npx wrangler deploy`。

**遊戲頁面 F12 看不到任何送往 `/e` 的請求**
→ 三種可能：(1) `analytics.js` 的 `ENDPOINT` 還是空的；(2) 你是用 `file://` 直接開檔
（本機開檔一律停用統計，這是刻意的）；(3) 網址後面帶了 `#autotest` 之類的測試掛鉤。

**有請求但狀態是 500**
→ 執行 `npx wrangler tail` 再玩一次，即時錯誤會印出來。最常見是步驟 3 忘了加 `--remote`，
資料表根本沒建。

**數字對不上／想從頭來過**
→ `npx wrangler d1 execute inkflow-analytics --remote --command="DELETE FROM events"` 清空重來。
