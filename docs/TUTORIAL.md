# Agent PM 原型：驗收與操作教程

這份教程分四條路線，由淺入深。每一步都寫了「你做什麼」和「應該看到什麼」，看到了就算這一項通過。

| 路線 | 需要什麼 | 時間 | 驗收什麼 |
| --- | --- | --- | --- |
| A. 只用瀏覽器 | 打開預覽鏈接 | 5 分鐘 | 3D 視窗、三種異常劇情、批准/退回、回放、列表 |
| B. 本機跑起來 | Node 20 以上 | 10 分鐘 | 協調服務、SQLite、自動測試 |
| C. 自己當 PM | 路線 B 的環境 | 15 分鐘 | 你親手建項目、開 worker、review、拔線、受阻、能力標籤 |
| D. 接真實 agent | Claude Code | 15 分鐘 | agent 通過 MCP 拆解、領取、交付 |

最後有一張[驗收清單](#驗收清單)，可以邊做邊打勾。

先認識畫面：

![3D 總覽](screenshots/01-overview.png)

- 每個項目是一塊檯面（泳道），任務按依賴從左到右排開。
- 節點顏色：灰 等待依賴、藍 可領取、黃 執行中、紫 待 review、橙 退回修改、紅 受阻、綠 已完成。左下角有圖例和各狀態的數量。
- 小機器人是 worker，名字後面是它所在的電腦。後上方的金色晶體是 PM。
- 左上「動態」是最新事件，右上切換 3D / 列表，頂部一排是項目切換。

---

## 路線 A：只用瀏覽器

打開線上預覽「Agent PM 視窗」。右上角顯示「瀏覽器內模擬」，表示協調邏輯和模擬的 agent 都在你的瀏覽器裡跑，不需要安裝任何東西。
重新整理頁面會從頭開始。右上角的「速度 ×1」可以點成 ×2、×4。

### A1. 看懂正常流程（前 20 秒）

| 你做什麼 | 應該看到什麼 |
| --- | --- |
| 打開頁面，什麼都不點 | 兩塊檯面：前面是「官網會員系統上線」（10 個任務），後面是「本週日常雜事」（6 個任務）。沒有依賴的節點是藍色，其餘是灰色 |
| 等幾秒 | 機器人飛到藍色節點上繞圈，節點變黃。這是 worker 領取了任務 |
| 再等幾秒 | 節點變紫，PM 向它照一道紫色光束。這是 worker 提交了交付，PM 在 review |
| 繼續看 | 節點變綠，一顆光點沿連線流向下游，下游節點由灰變藍。這是 review 通過後解鎖了下游 |

注意「頭像生成模型微調」只有「小家 · 家用電腦」會去領，因為它需要 `gpu` 標籤，只有家用電腦有。

### A2. 三種異常劇情

第一輪的劇情是固定的，下面的時間是速度 ×1 時的大約值。錯過了就重新整理，或者用 A5 的回放。

| 大約時間 | 劇情 | 應該看到什麼 |
| --- | --- | --- |
| 25 秒 | **受阻** | 「頭像生成模型微調」變成紅色並閃爍，動態裡出現「小家 回報…受阻：…」。約 8 秒後 PM 解除阻塞，節點回到藍色，再被領取 |
| 38 秒 | **review 退回** | 「登入頁設計稿」由紫變橙，動態裡出現「PM 退回…：手機尺寸的間距不對…」。稍後同事A 重新領取它 |
| 40 到 46 秒 | **電腦斷線** | 同事A 領了「第三方登入（OAuth）」後停止心跳。約 6 秒後動態出現「租約超時（同事A 失聯），回到任務池」，同事A 的機器人變暗落回前排，節點變回藍色，隨即被另一個 worker 接手。再過幾秒同事A「重新上線」 |

大約 90 秒時兩個項目都完成，檯面邊框變成金色、標題下顯示「PM 已交付」。再過約 10 秒自動開始第 2 輪，之後的異常是隨機的。

### A3. 點節點看詳情

點任何一個節點，右邊打開側欄：

![側欄](screenshots/02-review-panel.png)

應該看到：狀態、描述、驗收標準、需要的能力、依賴（可以點過去）、執行者、領取次數、交付內容和 PR 鏈接、review 記錄，以及最下面「這個任務的經過」。
點一個執行中（黃色）的節點，還會看到「租約剩 N 秒」：數字往下掉，每次心跳後又跳回 6，正常情況下在 4 到 6 之間來回。

點空白處或右上角的 × 關閉側欄。

### A4. 自己批准和退回

模擬的 PM 會在 2.5 到 4.5 秒內自動 review，所以要手快，或者先把速度留在 ×1。

1. 等某個節點變紫，立刻點它。
2. 側欄下方出現輸入框和「批准」「退回」兩個按鈕。
3. 在輸入框寫一句意見，點「退回」。

應該看到：節點變橙；側欄的「Review 記錄」多了一條「退回 你」和你寫的意見；動態裡出現「你 退回…」；幾秒後原來的 worker 重新領取，領取次數加 1。

如果按鈕已經消失，說明模擬的 PM 搶先處理了，換下一個紫色節點再試。想完全由自己掌控 review，請走路線 C。

同樣地，節點紅色（受阻）時點開，側欄有「解除阻塞，放回任務池」按鈕。

### A5. 回放

拖動右下角的「回放」滑桿往左。

應該看到：整個場景回到那個時間點的狀態，滑桿旁顯示時間和「第 N/M 個事件」，動態面板也只顯示到那一刻。回放期間側欄不顯示操作按鈕。
點「回到實時」或把滑桿拖到最右恢復。

### A6. 切換項目和列表

| 你做什麼 | 應該看到什麼 |
| --- | --- |
| 點頂部的「官網會員系統上線」 | 鏡頭飛近這個項目，另一個項目變暗，worker 和 PM 跟著移到這塊檯面旁 |
| 點「全部」 | 回到總覽 |
| 拖拽、滾輪 | 旋轉和縮放 |
| 點右上角「列表」 | 每個項目一張表：任務、狀態、能力標籤、執行者、依賴、領取次數、交付。上面可按狀態篩選，下面是每個 worker 的卡片（標籤、在線狀態、正在做什麼）。點任一行同樣打開側欄 |

---

## 路線 B：本機跑起來

### B1. 安裝和啟動

需要 Node 20 以上（`node -v` 檢查）。解壓 `agent-pm-prototype.zip` 後：

```bash
cd agent-pm
npm install
npm run demo
```

應該看到終端輸出：

```
server| [server] 協調服務  http://localhost:4000
server| [server] MCP       http://localhost:4000/mcp
server| [server] 資料庫 .../data/demo.db，租約 6000ms
sim   | [sim] 已連上 http://localhost:4000，租約 6000ms，速度 x1
server| [event] task_claimed      同事B 領取「需求梳理與 API 設計」
```

（事件的具體內容和順序可能略有不同。）

打開 <http://localhost:4000>，右上角顯示綠點「實時連線」。畫面和劇情與路線 A 相同，區別是現在有一個真實的協調服務和 SQLite 資料庫，
模擬器是另一個進程，通過 REST 接口扮演 worker 和 PM。路線 A 的每一項在這裡都可以再做一遍。

`Ctrl+C` 停止。每次 `npm run demo` 都會清空示範資料庫 `data/demo.db` 重新開始。

4000 端口被佔用時換一個：`PORT=4100 npm run demo`（PowerShell：`$env:PORT="4100"; npm run demo`）。

### B2. 驗證事件是實時推送的

服務跑著的時候，另開一個終端：

```bash
curl http://localhost:4000/api/state
curl "http://localhost:4000/api/events?since=0"
```

應該看到：第一條返回所有項目、任務、worker 的 JSON；第二條返回事件日誌，每條帶 `type`、`message` 和變更後的任務快照。網頁就是靠同一批事件（經 WebSocket）更新的。

### B3. 跑自動測試

先 `Ctrl+C` 停掉示範（不停也可以，測試用自己的臨時端口和記憶體資料庫）：

```bash
npm test
```

應該看到兩組結果，`# pass 8` 和 `# pass 3`，`# fail 0`。它們覆蓋：

| 測試 | 驗證的設計點 |
| --- | --- |
| 拆解：無依賴的任務立即 ready | DAG 拆解 |
| 拆解：拒絕有環或依賴不存在的圖 | 必須是有向無環圖 |
| 領取：同一個任務只會被一個 worker 領到 | 原子領取 |
| 領取：能力標籤不符就領不到 | 能力標籤 |
| 完整流程：交付 → review 通過 → 解鎖下游 → 項目交付 | 主流程 |
| review 退回：優先還給原來的人，意見保留 | 退回重做 |
| 租約：心跳續約；超時後回到任務池，worker 標記離線 | 租約和心跳 |
| 受阻：report_blocked → blocked → unblock → ready | 受阻處理 |
| REST：20 個 worker 同時搶 5 個任務，每個任務只被領一次 | 併發下的原子領取（真實 SQLite） |
| REST：錯誤會帶上 code | 接口錯誤處理 |
| MCP + WebSocket：PM 拆解、worker 領取交付、PM review，事件實時推送 | 用官方 MCP 客戶端走完整流程 |

---

## 路線 C：自己當 PM

這條路線不啟動模擬器，由你親手扮演人類和 PM，用 runner 的 dry-run 模式扮演 worker（它會假裝幹 6 秒活然後交付，不需要真的 agent）。
需要開三個終端，都在 `agent-pm` 目錄下。

下面的命令是 macOS / Linux 寫法。Windows PowerShell 請把 `A=1 B=2 命令` 改成 `$env:A="1"; $env:B="2"; 命令`，把 `curl` 改成 `curl.exe`。

### C1. 啟動空的協調服務（終端 1）

```bash
npm run demo -- --no-sim
```

打開 <http://localhost:4000>。應該看到：「實時連線」，場景裡只有網格，沒有任何項目。

### C2. 建立一個項目（終端 2）

工程裡準備了一個三步的例子 `docs/examples/project.json`：留言 API → 留言區前端 → 發布公告，前兩個要 `code` 標籤，最後一個要 `docs` 標籤。

```bash
curl -X POST http://localhost:4000/api/projects \
  -H "content-type: application/json" \
  -d @docs/examples/project.json
```

應該看到：網頁上立刻出現一塊檯面和三個節點，「留言 API」是藍色（可領取），另外兩個是灰色（等待依賴）。動態裡出現「PM 建立項目…拆解為 3 個任務」。

想驗證「必須無環」，可以把檔案裡 `api` 任務加上 `"deps": ["notice"]` 再提交，會收到 `任務依賴存在環，必須是有向無環圖`。

### C3. 開一個 worker（終端 3）

```bash
WORKER_ID=my-pc WORKER_NAME=我的電腦 WORKER_MACHINE=筆電 WORKER_LABELS=code \
  npm run runner -- --dry-run
```

應該看到：

- 終端：`[runner my-pc] 領取「留言 API」（第 1 次）`，約 6 秒後 `agent 正常退出，已代為提交`。
- 網頁：出現機器人「我的電腦 · 筆電」，飛到「留言 API」上繞圈，節點變黃；約 6 秒後節點變紫，PM 照下光束，機器人回到前排待命。

現在沒有模擬的 PM，任務會一直停在紫色等你。

### C4. 退回，再批准（網頁）

1. 點紫色的「留言 API」，在輸入框寫「缺少測試」，點「退回」。
   應該看到：節點變橙。5 秒內 runner 重新領取（終端顯示「第 2 次」），節點變黃，再變紫。側欄的 Review 記錄裡有你的退回意見。
2. 再點它，這次點「批准」。
   應該看到：節點變綠，光點流向「留言區前端」，它由灰變藍，隨即被 runner 領取變黃。

### C5. 拔線：驗證租約回收

趁「留言區前端」還是黃色（執行中），在終端 3 按 `Ctrl+C` 殺掉 runner。

應該看到：節點先保持黃色（服務還不知道 worker 沒了）。約 6 秒後動態出現「租約超時（我的電腦 失聯），回到任務池」，節點變回藍色，機器人變暗。
點開節點可以看到「上一位：我的電腦」和領取次數 1。

### C6. 受阻：驗證 blocked

在終端 3 啟動一個「一執行就失敗」的 worker（把 agent 命令換成 `false`，這次不加 `--dry-run`）：

```bash
WORKER_ID=my-pc WORKER_NAME=我的電腦 WORKER_MACHINE=筆電 WORKER_LABELS=code \
  AGENT_CMD=false npm run runner -- --once
```

應該看到：

- 終端：`領取「留言區前端」（第 2 次）`，然後 `agent 異常退出（code 1），已回報 blocked`，runner 退出。
- 網頁：節點變紅並閃爍。點開，側欄顯示「受阻原因：agent 異常退出…」和「解除阻塞，放回任務池」按鈕。

點「解除阻塞」。應該看到節點回到藍色。

（Windows 上沒有 `false` 命令，會顯示「無法啟動 agent」，效果一樣是受阻。）

### C7. 能力標籤和項目交付

1. 重新啟動 C3 的 dry-run worker。它領取「留言區前端」，6 秒後提交。你在網頁上批准。
2. 「發布公告」變藍，但這個 worker **一直不會去領**。因為它需要 `docs` 標籤，而這個 worker 只有 `code`。這就是能力標籤的作用。
3. 開第四個終端，啟動一個有 `docs` 標籤的 worker：

   ```bash
   WORKER_ID=writer WORKER_NAME=文案 WORKER_MACHINE=同事的電腦 WORKER_LABELS=docs \
     npm run runner -- --dry-run
   ```

   應該看到：第二個機器人出現並領取「發布公告」。
4. 提交後你批准。

應該看到：三個節點全綠，檯面邊框變成金色，標題下顯示「PM 已交付」，動態裡出現「PM 交付項目…」。

到這裡，主流程（拆解 → 領取 → 交付 → review → 交付項目）和三種異常你都親手驗證過了。

---

## 路線 D：接真實 agent（MCP）

協調服務把所有操作暴露成 MCP 工具，支持 MCP 的 agent 配置一個地址就能用。這裡以 Claude Code 為例。

說明：MCP 工具我用官方 MCP 客戶端（自動測試）和 curl 驗證過，但沒有用真實的 Claude Code 會話完整走過這條路線，所以這一節請當作操作指引，遇到出入告訴我。

### D1. 用較長的租約啟動

示範的租約只有 6 秒，真實 agent 來不及幹活。先停掉其他服務，然後：

```bash
LEASE_MS=600000 npm run demo -- --no-sim      # 租約 10 分鐘
```

### D2. 不用 agent，先用 curl 確認 MCP 通了

```bash
curl -X POST http://localhost:4000/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

應該看到：返回 11 個工具的定義，包括 `claim_task`、`heartbeat`、`submit_result`、`review_task`、`create_project`。

### D3. 把 MCP 加到 Claude Code

```bash
claude mcp add --transport http agent-pm http://localhost:4000/mcp
claude mcp list        # 應該列出 agent-pm
```

協調服務在別的機器上時，把 `localhost` 換成它的地址。設置了 `PM_TOKEN` 的話再加 `--header "Authorization: Bearer <token>"`。

### D4. 讓 agent 當 PM

在 Claude Code 裡說：

> 你是項目管理員。用 agent-pm 的 create_project，把「給部落格加上留言功能」拆成 3 到 5 個有依賴關係的任務，每個任務寫清驗收標準，需要寫代碼的任務標籤用 code，寫文檔的用 docs。

應該看到：agent 調用 `create_project`（第一次會問你是否允許），網頁上出現新的檯面和節點。

之後有任務進入待 review 時，可以說：

> 用 agent-pm 的 list_tasks 找出 in_review 的任務，用 get_task 看交付內容，對照驗收標準逐個 review_task，不合格的寫明原因退回。

### D5. 讓 agent 當 Worker

另開一個 Claude Code 會話，說：

> 你是 Worker。用 agent-pm 註冊成 worker_id 為 cc-1、標籤 code 的 worker，然後 claim_task 領一個任務，按任務描述和驗收標準完成它，完成後 submit_result 說明你做了什麼。做不下去就 report_blocked。

應該看到：網頁上出現機器人 cc-1 飛到節點上，節點變黃；agent 完成後節點變紫，等你或 PM agent review。

### D6. 讓 runner 常駐，自動啟動 agent

這是設想中每台電腦上的日常形態：runner 常駐，有任務就啟動本地 agent。

```bash
WORK_DIR=~/code/my-blog \
WORKER_ID=home-pc WORKER_NAME=小家 WORKER_MACHINE=家用電腦 WORKER_LABELS=code \
  npm run runner
```

- `WORK_DIR` 是 agent 幹活的目錄，通常是那台電腦上的代碼倉庫。
- 預設用 `claude -p "<任務提示詞>"` 啟動 agent，可以用 `AGENT_CMD` 換成別的命令。
- runner 負責領取和心跳。agent 正常退出時如果沒有自己調用 `submit_result`，runner 會把它的輸出尾部當作交付說明提交；異常退出則回報受阻；租約丟失會終止 agent。

---

## 驗收清單

| # | 驗收項 | 對應你的方案 | 怎麼驗 | 通過標準 |
| --- | --- | --- | --- | --- |
| 1 | 請求被拆成有依賴的任務圖 | PM 分解需求 | C2 | 提交後出現節點和連線；有環的圖被拒絕 |
| 2 | Worker 領取任務 | Worker 領取需求 | A1 / C3 | 藍色節點被機器人領取後變黃 |
| 3 | 同一任務不會被兩個 worker 領到 | 多 agent 協同 | B3 | 「20 個 worker 搶 5 個任務」測試通過 |
| 4 | 只有具備能力的電腦能領 | 分散在不同電腦 | A1 / C7 | `gpu` 任務只有家用電腦領；`docs` 任務 `code` worker 不領 |
| 5 | Worker 交付，帶 PR 鏈接 | Worker 完成交付 | A3 | 側欄「交付」有說明和 PR 鏈接 |
| 6 | PM review 通過後解鎖下游 | PM review 改動 | A1 / C4 | 節點變綠，光點流向下游，下游變藍 |
| 7 | PM review 退回後重做 | PM review 改動 | A2 / A4 / C4 | 節點變橙，原 worker 帶著意見重新領取，領取次數加 1 |
| 8 | 人可以在網頁上批准、退回 | 人類介入 | A4 / C4 | 點按鈕後狀態立刻改變，記錄裡署名「你」 |
| 9 | 電腦斷線後任務自動回收 | 分散在不同電腦 | A2 / C5 | 約一個租約時長後節點回到藍色，worker 顯示離線 |
| 10 | 任務受阻可以上報和解除 | 異常處理 | A2 / C6 | 節點紅色閃爍並顯示原因；解除後回到藍色 |
| 11 | 全部完成後項目交付 | PM 交付 | A2 / C7 | 檯面邊框變金色，顯示「PM 已交付」 |
| 12 | 進度實時可見，可回放 | 可視化 | A5 / A6 | 不重新整理頁面就更新；滑桿能回到任一時刻 |
| 13 | Agent 可經 MCP 操作 | 多 agent 接入 | B3 / D2 | MCP 測試通過；curl 能列出 11 個工具 |
| 14 | 真實 agent 走完整流程 | 多 agent 接入 | D4 到 D6 | 這一項我沒有驗證過，需要你實測 |

---

## 常見問題

**網頁右上角顯示「瀏覽器內模擬」而不是「實時連線」？**
網頁連不上協調服務時會自動退回瀏覽器內模擬。確認服務在跑，並且打開的是服務輸出的那個地址。

**`npm install` 在編譯 better-sqlite3 時失敗？**
它在常見系統上有預編譯包。失敗通常是 Node 版本太新或太舊，換成 Node 20 或 22 的 LTS 版本再試。

**runner 顯示「出錯，稍後重試」？**
多半是連不上協調服務。檢查 `PM_URL`（預設 `http://localhost:4000`）。

**場景裡的字太小？**
點頂部某個項目把鏡頭拉近，或者用滾輪放大。任務多的時候用右上角的「列表」更好找。

**想清空重來？**
`npm run demo` 每次啟動都會清空示範資料庫。正式模式（`npm run server`）的資料在 `data/pm.db`，刪掉這個檔案即可。
