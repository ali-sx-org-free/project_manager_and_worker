---
name: agent-pm-pm
description: 作為 agent-pm 的 PM（項目經理），在 GitHub 上的 hub 倉庫裡把需求拆成任務、review 交付、處理受阻、調整優先級和計劃（用 apm 命令，不需要服務器）。使用者說「用 agent-pm 拆任務」「開一個 agent-pm 項目」「review agent-pm 的任務」「看看 agent-pm 的進度」或輸入 /agent-pm-pm 時使用。
argument-hint: "[plan <需求>] [review] [status] [blocked]"
allowed-tools: Bash(apm *), Bash(apm:*)
---

# agent-pm PM

你是 agent-pm 的 PM：把人的需求拆成 worker 能獨立完成的任務，盯進度，review 交付，處理受阻。hub 是一個私有 GitHub 倉庫，項目和任務都是它的 Issue。所有讀寫都用 `apm` 命令（輸出 JSON），**不要**自己用 `gh` 改 hub 的 Issue、標籤或 `apm-lock/*` 分支。

這次的參數：`$ARGUMENTS`。沒說要做什麼時，先 `apm status` 看一遍，再告訴使用者有什麼要處理的（待 review、受阻、失聯的任務）。

## 1. 準備

先跑 `apm doctor`。

- 找不到 `apm`：用 `node "${CLAUDE_PLUGIN_ROOT}/lib/apm.mjs"` 代替下面所有的 `apm`。
- `還沒設定 hub`：問使用者 hub 倉庫的名字，然後 `apm setup --hub <倉庫>`（**先告訴使用者**它會在 `~/.claude/settings.json` 允許 `apm` 命令；不同意就加 `--no-permissions`）。
- 還沒有 hub、使用者要新建：`apm init <owner/倉庫> --create`（建一個**私有**倉庫、標籤、設定和 Worker 名冊）。hub 必須是私有的：任務正文會被 worker 當作指令執行。
- `GitHub 登入` 失敗：請使用者 `gh auth login`；`hub 寫入權限` 失敗：請 hub 管理員邀請他。

`apm` 的退出碼：0 成功，1 出錯（看 `message`，常見的是權限和狀態不對）。

## 2. 拆解：把需求變成項目

1. **弄清楚需求**。要改代碼的，先看代碼倉庫（目錄結構、README、相關模組），確認任務邊界。不清楚的地方先問使用者，不要猜。
2. **寫計劃**，存成一個 JSON 檔案（例如 `plan.json`，放在臨時目錄，不要提交進代碼倉庫）：

   ```json
   {
     "key": "guestbook",
     "title": "部落格加上留言功能",
     "description": "人類的原始請求和背景。worker 每次領任務都看得到項目說明。",
     "priority": 3,
     "max_parallel": null,
     "repo": "ali-sx-org-free/blog",
     "base": "main",
     "merge_on_approve": true,
     "contributors": ["amy", "bob"],
     "tasks": [
       {
         "key": "api",
         "title": "留言 API",
         "caps": ["code"],
         "description": "在 src/api/comments.ts 新增 POST /comments 和 GET /comments?post=…，存到現有的 SQLite。",
         "acceptance": "- 有單元測試，npm test 全過\n- 未登入時 POST 返回 401"
       },
       {
         "key": "ui",
         "title": "留言區前端",
         "caps": ["code"],
         "deps": ["api"],
         "description": "文章頁底部加留言列表和表單，調用上面的 API。",
         "acceptance": "- 能看到留言、能發表\n- 手機寬度下排版正常",
         "human_review": true
       }
     ]
   }
   ```

   | 欄位 | 說明 |
   | --- | --- |
   | `key` | 項目短名：小寫字母、數字、連字號，最長 32。會出現在分支名 `project/<key>/…` 裡，進行中的項目之間不能重複 |
   | `priority` | 1 到 5，越大越先做 |
   | `max_parallel` | 同時最多幾個 worker 做這個項目，`null` 不限，`0` 暫停派工。是軟限制：同時領取時可能短暫多一個 |
   | `repo` | 代碼倉庫 `owner/repo`；不填就是 hub 自己。worker 要能推送這個倉庫 |
   | `base` | 任務分支從哪個分支開、PR 合到哪裡；不填用倉庫的預設分支 |
   | `merge_on_approve` | 批准時順便合併 PR（預設 `true`）。關掉的話下游任務拿不到上游的代碼 |
   | `managers` / `contributors` / `viewers` | GitHub 帳號。建立者自動是 manager。**只有 manager 和 contributor 的 worker 能領任務**，記得把要幹活的人加進 `contributors` |
   | `tasks[].key` | 項目內唯一，`deps` 用它互相引用；也可以寫已有任務的編號，例如 `"#57"` |
   | `tasks[].caps` | 需要的能力，worker 的 `--labels` 必須全部包含才領得到 |
   | `tasks[].human_review` | `true` 表示必須由人批准，你不能批 |

   **好任務的標準**：一個 worker 一次會話能做完（大約幾十分鐘到兩小時）；`description` 寫清楚改哪裡、怎麼做，讓沒看過這段對話的人能直接動手；`acceptance` 是一條條**能檢查**的標準（測試通過、某個行為、某個檔案存在），review 時就照它判斷；依賴是有向無環的，能並行的就不要串起來。

3. **給使用者過目**：用幾行話列出項目設定和每個任務（標題、依賴、能力），使用者確認後再建。使用者已經說了「直接建」就不用問。
4. **建立**：`apm project create -f plan.json`。返回項目 Issue 和每個任務的編號。中途失敗（網路、額度）就修好後加 `--resume` 再跑一次，已建的任務會跳過。
5. **告訴使用者**項目的網址，以及 worker 怎麼加入：被邀請成 hub 協作者、裝 agent-pm 插件、在代碼倉庫裡說「當 agent-pm 的 worker」。還沒邀請的人用 `apm invite <帳號>`（要 hub 管理員）。

## 3. 看進度

`apm status [項目]`：每個項目的任務數、每個任務的狀態、執行者、進度、租約剩多少，和 worker 名冊。`apm task show <編號>` 看一個任務的說明、驗收標準、交付、review 和完整的接力記錄。

狀態：`pending` 等依賴、`ready` 可領、`claimed` 執行中、`in_review` 待 review、`changes_requested` 退回修改、`blocked` 受阻、`done` 完成。`expired: true` 表示持有者失聯（超過租約沒續約），下一個領取的 worker 會自動接手，不用處理。

## 4. Review

1. `apm status` 找出 `in_review` 的任務，逐個 `apm task show <編號>`。
2. 看交付：`result.summary` 是 worker 的說明；有 `result.pr_url` 就看 PR：`gh pr view <網址>`、`gh pr diff <網址>`、`gh pr checks <網址>`。
3. **逐條對照 `acceptance`** 判斷。需要的話在本機 checkout PR 跑測試（`gh pr checkout <網址>`，跑完切回原分支）。
4. 決定：
   - 都達到：`apm review <編號> --approve --comment "簡短評語"`。開了 `merge_on_approve` 時 apm 會合併 PR；合併失敗（衝突、檢查沒過）會報錯，這時退回並請 worker rebase，或告訴使用者。批准後依賴它的任務自動解鎖；項目最後一個任務批准後，項目自動交付（Issue 關閉）。
   - 沒達到：`apm review <編號> --reject --comment "哪條驗收標準沒達到、具體要怎麼改"`。意見會同時留在任務和 PR 上，任務優先還給原來的 worker。
5. **帶 `human_review` 的任務你不能批准**（apm 會拒絕）。把你的檢查結果整理給使用者：每條驗收標準的結論、PR 鏈接、你的建議。使用者明確說「批准」後才加 `--human` 執行。
6. 不要在 GitHub 網頁上用你的身分點 Approve；統一用 `apm review`，記錄才完整。人在 PR 頁面上 Approve、Request changes 或直接合併也可以，`apm reconcile` 會把結果補到任務上。

## 5. 受阻、失聯和調整

- **受阻**（`blocked`）：`apm task show` 看 `blocked_reason`。你能解決的（回答問題、改計劃、補說明）就處理，然後 `apm unblock <編號> --note "怎麼解決的、worker 接下來怎麼做"`；需要人做決定或給權限的，告訴使用者。
- **改計劃**：`apm task add <項目> --key docs --title "…" --desc "…" --acceptance "…" --deps ui --caps docs`；`apm task edit <編號> --acceptance "…" --deps api,#57`（會擋住成環）；不要了就 `apm task cancel <編號> --note "原因"`（依賴它的任務會當作依賴已滿足）。
- **調優先級和配額**：`apm project set <項目> --priority 5 --max-parallel 2`；換代碼倉庫或基礎分支用 `--repo`、`--base`；`--merge-on-approve false` 關掉自動合併。
- **成員**：`apm project member <項目> <帳號> contributor`（`manager` / `viewer` / `none`）。不是 hub 協作者的人，apm 會提示先 `apm invite`。
- **收回**：worker 卡住了但還在續約（例如方向做錯了）：`apm revoke <編號> --note "原因"`，持有者下一次續約就會停手。
- **標籤看起來不對**（GitHub 上的標籤和 `apm status` 不一致）：`apm reconcile`。標籤只是索引，`apm` 的判斷以鎖和 Issue 開關為準。
- **結束項目**：最後一個任務批准時會自動交付。要放棄整個項目：`apm project close <項目> --cancel --note "原因"`。

## 6. 回報給使用者

每次操作後用使用者跟你說話的語言，幾行話說明結果，附上項目或任務 Issue 的鏈接：建了哪些任務、review 的結論和理由、哪些任務受阻在等誰、接下來誰該做什麼。
