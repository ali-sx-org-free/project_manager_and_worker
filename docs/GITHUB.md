# 不用服務器：用 GitHub 倉庫當中間層

PM 和 Worker 不再連自己部署的協調服務，而是都讀寫同一個**私有 GitHub 倉庫**（叫它 hub）。
項目和任務是 hub 的 Issue，接力記錄是 Issue 的留言，任務的領取鎖是 hub 裡的 `apm-lock/<編號>` 分支。
所有讀寫都由一個命令行工具 `apm` 完成；PM 和 Worker 的 Skill 只告訴 agent「什麼時候跑哪個 `apm` 命令」。

要一步步驗收，看 [ACCEPTANCE.md](ACCEPTANCE.md)。設計的來龍去脈和取捨見設計文檔。

```
           ┌──────────────── hub：私有 GitHub 倉庫 ────────────────┐
           │ Issue：項目（apm:project）→ 任務（apm:task，sub-issue）│
           │ 留言：檢查點、交接、交付、review（開頭藏一行 JSON）     │
           │ 分支：apm-lock/42 ← 任務 #42 的鎖（git 比較並交換）     │
           │ 檔案：.agent-pm/config.yml（租約時長、管理員）           │
           └───────────▲───────────────▲───────────────▲───────────┘
                       │ apm（REST + git）│               │
        PM：/agent-pm-pm      Worker：/agent-pm-worker     管理端：npm run console
        （Claude Code 插件）  （Claude Code 插件）          （本機 http://localhost:4000）
```

## 誰要做什麼

| 角色 | 一次性準備 | 平時 |
| --- | --- | --- |
| 管理員 | 建 hub：`apm init owner/倉庫 --create`；邀請成員：`apm invite <帳號>` | 看管理端；必要時收回任務、清理鎖 |
| PM | `gh auth login`；裝插件；`apm setup --hub owner/倉庫` | 「/agent-pm-pm 把 XXX 拆成任務」「/agent-pm-pm review」 |
| Worker | 接受 hub 邀請；`gh auth login`；裝插件；`/agent-pm-worker join labels=code` | 「/agent-pm-worker」做一個，「/agent-pm-worker loop」連續做 |

沒有服務器地址、沒有 token 要發、沒有 `claude mcp add`。每個人都用自己的 GitHub 帳號。

## 安裝

需要 Node 20 以上、git、GitHub CLI（`gh`）。

```bash
gh auth login              # 選 GitHub.com、HTTPS，按提示在瀏覽器登入
```

**Claude Code 用戶**：在 Claude Code 裡輸入

```
/plugin marketplace add ali-sx-org-free/project_manager_and_worker
/plugin install agent-pm@agent-pm
```

裝好後 `agent-pm-pm`、`agent-pm-worker` 兩個 Skill 和 `apm` 命令就都有了（插件啟用時 `apm` 在 Claude Code 的 PATH 上）。
第一次用時 Skill 會跑 `apm setup --hub <倉庫>`：檢查登入和權限、寫本機設定 `~/.agent-pm/config.json`、
在 `~/.agent-pm/bin/apm` 裝一個啟動器，並在 `~/.claude/settings.json` 的 `permissions.allow` 加上 `Bash(apm *)`。
最後這一步很重要：agent 在後台被喚醒時，如果 `apm` 還要人逐次批准，續約就會卡住、任務被收回。

**其他 agent 或手動使用**：clone 這個倉庫後

```bash
node plugin/lib/apm.mjs setup --hub ali-sx-org-free/agent-pm-hub
export PATH="$HOME/.agent-pm/bin:$PATH"     # 或 apm setup --link 放一份到 ~/.local/bin
apm doctor
```

`plugin/lib/apm.mjs` 是打包好的單檔，不需要 `npm install`。從源碼重新打包：`npm run build:apm`。

## 管理員：建 hub

```bash
apm init ali-sx-org-free/agent-pm-hub --create   # 倉庫已經存在就不用 --create
apm invite amy                                    # 邀請成員（Write 權限），對方要到 GitHub 接受邀請
```

`apm init` 會：確認倉庫是**私有**的（公開倉庫直接拒絕：任務正文會被 agent 當作指令執行），建好全部標籤，
寫入 `.agent-pm/config.yml`，開一個「Worker 名冊」Issue。可以重複執行，已有的東西不動。

`.agent-pm/config.yml`（在 GitHub 網頁上改完 commit 就生效）：

```yaml
lease_minutes: 10       # 租約：持有者超過這麼久沒續約，別人就可以接手
heartbeat_minutes: 2    # apm keepalive 的續約間隔，要比租約短得多
idle_minutes: 30        # agent 這麼久沒調用任何 apm 命令，keepalive 停止續約
admins: [amy]           # 除了倉庫 admin 之外的 hub 管理員
```

權限：PM 和 Worker 都需要 hub 的 **Write**（鎖是推分支）。Worker 還需要代碼倉庫的 Write（推任務分支、開 PR）；
批准時要合併 PR 的 PM 也需要代碼倉庫的 Write。無人值守的電腦建議用 fine-grained token（只授權 hub 和代碼倉庫的
Contents、Issues、Pull requests 讀寫，設過期日），設成環境變量 `GH_TOKEN`。

## PM：建項目、review

把需求寫成計劃 JSON（格式和原來的 `docs/examples/*.json` 一樣，多了幾個欄位），然後：

```bash
apm project create -f plan.json
```

```json
{
  "key": "guestbook",
  "title": "部落格加上留言功能",
  "description": "人類的原始請求和背景",
  "priority": 3,
  "max_parallel": null,
  "repo": "ali-sx-org-free/blog",
  "base": "main",
  "merge_on_approve": true,
  "contributors": ["amy", "bob"],
  "tasks": [
    { "key": "api", "title": "留言 API", "caps": ["code"], "description": "…", "acceptance": "- 有單元測試" },
    { "key": "ui", "title": "留言區前端", "caps": ["code"], "deps": ["api"], "acceptance": "…", "human_review": true }
  ]
}
```

| 欄位 | 說明 |
| --- | --- |
| `repo` | 代碼倉庫；不填就是 hub 自己（只有一個倉庫的小團隊可以這樣用） |
| `base` | 任務分支從哪裡開、PR 合到哪裡；不填用倉庫預設分支 |
| `merge_on_approve` | 批准時順便合併 PR，預設開。關掉的話下游拿不到上游的代碼 |
| `managers` / `contributors` / `viewers` | 項目角色（GitHub 帳號）。建立者自動是 manager。**只有 manager 和 contributor 的 worker 領得到任務**；只有 manager 能 review、解除阻塞、改設定 |
| `tasks[].caps` | 需要的能力（原來叫 `labels`，兩個都認），worker 的能力必須全部包含 |
| `tasks[].deps` | 同計劃裡的任務 key，或已有任務的編號（`"#57"`，可以跨項目） |
| `tasks[].human_review` | 必須由人批准：`apm review --approve` 要加 `--human`，PM agent 的 Skill 不會自己加 |

建好後 GitHub 上：項目 Issue 帶 `apm:project` 標籤，任務是它的 sub-issue（自動顯示完成進度）；
任務 Issue 帶 `apm:task`、`project:<key>`、`status:ready` 或 `status:pending`、`cap:*` 標籤。

Review：`apm status` 看待 review 的任務，`apm task show 42` 看交付和接力記錄，然後

```bash
apm review 42 --approve --comment "很好"          # 開了 merge_on_approve 會合併 PR；解鎖下游；最後一個任務批准後項目自動交付
apm review 42 --reject --comment "未登入時要返回 401"   # 意見同時留在任務和 PR 上，任務優先還給原 worker
```

人也可以直接在 PR 頁面點 Approve、Request changes 或合併；`apm reconcile`（或管理端的「對齊標籤」）會把結果補到任務上。

其他：`apm unblock 42 --note …`、`apm revoke 42`（收回正在執行的任務）、`apm task add / edit / cancel`、
`apm project set site --priority 5 --max-parallel 2`、`apm project member site amy contributor`、`apm project close site --cancel`。

## Worker：領任務、續作、交付

```bash
apm join --labels code,docs [--projects site,blog] [--repo owner/repo=/本機路徑]
apm claim                 # 返回任務、續作資訊 resume、分支和 commit 格式
apm keepalive &           # 後台續約；任務結束自己退出，被接手時退出碼 3
apm checkpoint --summary "做完了什麼" --next "接下來做什麼" --progress 60 --commit abc1234
apm submit --summary "做了什麼、怎麼驗證"   # 還沒有 PR 就用任務分支自動開一個；已有的話用 --pr 指定
apm release --reason usage_limit --note "停在哪裡"      # 或 apm block --reason "缺什麼"
```

Worker Skill 把這些串成完整流程（沿用原來 PR #1 的五條鐵律：穩定的 worker id、接手不重做、先 push 再存檢查點、
`lease_lost` 立刻停手、沒推上去的改動收進 stash）。

worker id 預設是主機名。同一台電腦跑兩個 worker：`APM_WORKER_ID=home-pc-2`（本機狀態按 id 分開存）。

退出碼：0 成功，1 出錯，2 沒有任務，3 租約已經不屬於你（被接手或被收回）。

**租約怎麼算**：領取時鎖寫上「到期時間 = 現在 + 10 分鐘」（時間用 GitHub 的，不看本機時鐘）。`apm keepalive` 每 2 分鐘續一次。
電腦斷線 10 分鐘後，下一個跑 `apm claim` 的 worker 會接手，並替上一位補記一條「租約超時」。原 worker 回來時：
如果還沒人接手，續約照樣成功（自動領回）；已經被接手就收到 `lease_lost`。

## 管理端

```bash
npm install && npm run build      # 第一次
npm run console                   # 連 apm setup 設定的 hub；或 npm run console -- --hub owner/倉庫
npm run console -- --fake         # 不連 GitHub：記憶體裡的假 hub，三個假 worker 和一個假 PM 在幹活
```

打開 <http://localhost:4000>。就是原來的 3D 網頁，數據來自 hub：總覽、回放、接力記錄、review、解除阻塞、改優先級和配額都能用。
右上角的「GitHub · owner/倉庫」打開 hub 面板：同步狀態、API 額度、正在執行的任務（可以收回）、Worker 名冊、
「對齊標籤」、「清理舊鎖」。

它只是你電腦上的一個進程：用 `gh` 的登入代你調 GitHub，token 不進瀏覽器，只聽 127.0.0.1，
只接受本機頁面發來的 JSON 請求（防止別的網站借你的瀏覽器操作 hub）。每 15 秒同步一次，帶 ETag，沒變化的請求不算 API 額度。

不裝管理端也可以：直接在 GitHub 網頁或手機 App 看 hub 的 Issue，有 sub-issue 進度條、標籤篩選和 PR review。

## hub 上的數據

| 東西 | 在 hub 裡是什麼 |
| --- | --- |
| 項目 | Issue，標籤 `apm:project`、`project:<key>`；設定在正文末尾的 `<!-- apm:project … -->` 隱藏區塊 |
| 任務 | Issue，標籤 `apm:task`、`project:<key>`、`status:*`、`cap:*`、`review:human`；key、所屬項目、依賴在 `<!-- apm:task … -->` |
| 狀態 | 關閉（completed）= 完成，關閉（not planned）= 取消；其餘看 `status:*` 標籤 |
| 執行中 | `apm-lock/<任務編號>` 分支指向的空 commit，commit 標題是一段 JSON（誰、第幾次、到期時間） |
| 接力記錄 | 任務 Issue 的留言，開頭一行 `<!-- apm {…} -->`。每次領取只開一條進度留言，之後的檢查點就地編輯它（不發通知） |
| Worker | 名冊 Issue（`apm:roster`）裡每個 worker 一條留言 |
| 設定 | `.agent-pm/config.yml` |

**以哪個為準**：鎖和 Issue 開關是準的，標籤只是方便篩選的索引，可能短暫落後（例如持有者斷線時標籤還是 claimed）。
`apm` 和管理端都按「鎖 > 開關 > 標籤」推導狀態；`apm reconcile` 把標籤改成推導出來的樣子。

**為什麼不會兩個人同時做**：所有鎖的寫入都是 `git push --force-with-lease=apm-lock/42:<剛讀到的值>`。
GitHub 在服務器端比對分支現值，不一致就拒絕，兩個 worker 從同一個舊值出發只有一個成功。
這在真實 GitHub 上測過（8 個進程同時推，只有 1 個成功），倉庫裡也有對應的自動測試。

請不要手動改隱藏區塊、刪 `apm-lock/*` 分支（已關閉任務的鎖用 `apm locks prune` 或管理端清理）。

## 退出

| 情況 | 做什麼 | 留下什麼 |
| --- | --- | --- |
| 暫時不做 | `/agent-pm-worker leave`（存檢查點、交出手上的任務、名冊標成離開） | 名冊記錄 |
| 直接關機、斷網 | 什麼都不用做，租約到期後別人自動接手 | 名冊記錄 |
| 永久離開 | `apm leave --forget`；管理員 `apm uninvite <帳號>` | 只有歷史留言和 commit |
| PM 交接 | `apm project member <項目> <新 PM> manager` | 無 |

## 額度和限制

- GitHub REST：每個帳號每小時 5,000 個請求；寫入另有大約每分鐘 80 個的限制。一個 worker 每小時約 30 個續約（git push，不佔 REST 額度）加上檢查點留言，
  同一個帳號同時跑 5 到 8 個 worker 沒問題；更多請分帳號。碰到 GitHub 要求放慢時 `apm` 會自動等待重試。
- 並行配額 `max_parallel` 是軟限制：兩個 worker 在同一秒領同一個項目的不同任務時可能多出一個，晚領的那個會馬上讓出。
- 一個項目最多 100 個 sub-issue（超過的任務照樣能用，只是不掛在項目下顯示進度）。
- 斷線到被接手約 10 到 12 分鐘（原協調服務是 3 分鐘）。演示時可以把 `lease_minutes` 改成 2。
- hub 裡的所有協作者看得到所有項目。要對某些人隱藏，就分開建 hub（管理端一次連一個）。

## 排錯

| 現象 | 原因和處理 |
| --- | --- |
| `沒有 GitHub 登入` | `gh auth login`，或設 `GH_TOKEN` |
| `沒有 hub 倉庫的推送權限` | 請管理員 `apm invite <你>`，到 `https://github.com/<hub>/invitations` 接受 |
| `apm` 每次都要批准 | `apm setup` 沒加權限，或你拒絕了：在 `~/.claude/settings.json` 的 `permissions.allow` 加 `"Bash(apm *)"` |
| 退出碼 3 / `lease_lost` | 任務已經被別人接手或被收回。停手，照 Worker Skill 第 7 節收起本地改動 |
| `連不上 GitHub` 而且在公司網路裡 | Node 22 以上時 `apm` 會自動用 `HTTPS_PROXY`；Node 20 請升級 |
| 標籤看起來不對 | `apm reconcile`（先加 `--dry-run` 看會改什麼） |
| `apm claim` 一直領不到 | `apm list` 的 `not_claimable` 列出每個任務的原因：不是項目成員、能力不符、配額已滿、依賴沒完成 |

## 本機演練（不碰真 GitHub）

```bash
npm run fake-github -- --users pm,alice,bob      # 本機假 GitHub，印出每個帳號要設的環境變量
```

在另外幾個終端貼上它印出的 `export …`，就可以用 `apm` 當不同的人操作（`npm run apm -- <命令>` 或 `node plugin/lib/apm.mjs <命令>`）。
`npm test` 裡的端到端測試就是這樣跑的。

## 和原來的協調服務

`packages/server`（協調服務 + MCP）和 `packages/runner` 還在，舊的 [TUTORIAL.md](TUTORIAL.md)、[DEPLOY.md](DEPLOY.md) 仍然適用，
但新項目建議用 hub。兩套共用 `packages/core` 的狀態機、可領排序和續作資訊。
