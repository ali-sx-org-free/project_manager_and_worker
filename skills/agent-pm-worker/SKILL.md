---
name: agent-pm-worker
description: 作為 agent-pm 協調服務的 Worker，透過 agent-pm 的 MCP 工具註冊、領取任務、續約、存檢查點、交付或交出。使用者說「當 worker」「去 agent-pm 領任務」「接手 agent-pm 的任務」或輸入 /agent-pm-worker 時使用。
argument-hint: "[worker_id=…] [labels=code,docs] [projects=site,blog] [task=<任務 id>] [loop]"
allowed-tools: mcp__agent-pm__register_worker, mcp__agent-pm__list_ready_tasks, mcp__agent-pm__claim_task, mcp__agent-pm__heartbeat, mcp__agent-pm__save_checkpoint, mcp__agent-pm__release_task, mcp__agent-pm__submit_result, mcp__agent-pm__report_blocked, mcp__agent-pm__get_task
---

# agent-pm Worker

你是 agent-pm 的 Worker：從協調服務領一個任務，在目前的工作目錄（通常是共用的代碼倉庫）裡做完，交給 PM review。

任務做到哪了是記在協調服務上的，不在你的對話裡。你隨時可能斷線、被打斷、用完額度，接手的 agent（也可能是下一次的你）只看得到兩樣東西：你存的**檢查點**，和你推上去的**任務分支**。所以整個流程的重點是：小步走、每步推上去、每步寫清楚。

runner（`npm run runner`）會自動續約、切分支、push、交接。用這份 Skill 時沒有 runner，這些都由你自己做。

這次的參數：`$ARGUMENTS`

## 五條鐵律

1. **續約**。領到任務後，每隔約 1 分鐘（`heartbeat_every_ms`）至少調用一次 `heartbeat` 或 `save_checkpoint`，兩次之間絕不能超過 `lease_ms`（正式環境通常 3 分鐘）。超過了任務會被收回給別人。
2. **只在任務分支上提交**。所有項目共用一個倉庫。只在 `git.branch` 上 commit 和 push，不切到別的分支，不碰其他項目的分支，不 force push。
3. **先 push，再存檢查點**。檢查點裡的 `commit` 必須是已經 push 到任務分支的 commit。push 之前先 `heartbeat` 確認任務還在你手上。
4. **收到 `lease_lost` 立刻停手**。任何工具返回 `[lease_lost]`，表示任務已經不屬於你：照第 7 節處理，不再 push、不再交付。
5. **接手不重做**。`claim_task` 返回的 `resume` 不是 `null` 時，已經有人做了一部分。以任務分支上的實際內容為準，從沒做完的地方接著做。

## 1. 準備

**解析參數**（`$ARGUMENTS`，也可以是使用者用自然語言說的）：

| 參數 | 含義 | 沒給時 |
| --- | --- | --- |
| `worker_id` | 這個 worker 的固定 id | 用 `hostname` 命令的輸出轉成小寫、加上 `-cc`，例如 `home-pc-cc` |
| `labels` | 能力標籤，逗號分隔，例如 `code,gpu` | 不傳，沿用上次註冊時的標籤 |
| `projects` | 只為這些項目（短名）幹活 | 不傳，有權參與的項目都做 |
| `task` | 指定要領的任務 id | 自動挑 |
| `loop` 或 `loop=N` | 做完一個再領下一個（最多 N 個） | 只做一個 |

`worker_id` 要**穩定**（這台電腦每次都用同一個，斷線回來時協調服務靠它認出你、把你做到一半的任務優先還給你）而且**唯一**（同一時間只能有一個會話用它；一個 worker 一次只能持有一個任務，同一台電腦開第二個會話請用 `-cc2` 之類的 id）。

**檢查 MCP**：如果沒有 `mcp__agent-pm__*` 這些工具，停下來告訴使用者先在終端執行下面的命令，然後重新開 Claude Code：

```bash
claude mcp add --transport http -s user agent-pm <協調服務地址>/mcp --header "Authorization: Bearer <token>"
```

**權限**：這份 Skill 自帶的工具許可只在被調用的那一輪有效。之後的每一輪（使用者再說話、背景命令的通知把你喚醒）如果 agent-pm 工具還要逐次批准，續約就會卡住、租約會過期。任何 agent-pm 工具因為沒有權限被拒時，告訴使用者在 `~/.claude/settings.json` 的 `permissions.allow` 裡加上 `"mcp__agent-pm"`（或在 `/permissions` 裡加），然後照第 7 節的規則處理：拿不到 `heartbeat` 的確認就不 push。

**檢查工作目錄**：執行 `git rev-parse --show-toplevel` 和 `git remote get-url origin`。不是 git 倉庫或沒有 `origin` 時，只能做不寫代碼的任務；領到需要改代碼的任務就照第 6 節的「交出」處理，`note` 寫明原因。

## 2. 註冊

調用 `register_worker`：`worker_id`、`name`（沒給就用 worker_id）、`machine`（`hostname` 的輸出）、有給才傳 `labels` 和 `projects`。

- 返回 `forbidden`（「已經登記在別人名下」）：這個 id 被別人用了，換一個再註冊，並告訴使用者。
- 返回的 `current_task` 不是 `null`：你上次可能有任務沒做完。用 `get_task` 查它。如果 `state` 是 `claimed` 而且 `assignee` 是你，**租約還在你手上**：馬上 `heartbeat`，然後把它的 `worklog` 裡最後一個 `kind: "checkpoint"` 當作續作說明（`summary`、`next_steps`、`commit`），`branch` 當作任務分支，跳過第 3 節、直接做第 4 節，不要再 `claim_task`。

## 3. 領取

調用 `claim_task`（`worker_id`，指定了任務就加 `task_id`）。

- 返回 `null`：現在沒有你能領的任務。可以用 `list_ready_tasks` 確認一下，告訴使用者，然後結束（`loop` 模式照第 8 節等一會再試）。
- 返回 `conflict`「還有未完成的任務」：回到第 2 節處理 `current_task`。

領到後記下這些，之後每一步都會用到：

| 欄位 | 用途 |
| --- | --- |
| `task.id` | 所有工具的 `task_id` |
| `task.title`、`task.description`、`task.acceptance` | 要做什麼、做到什麼程度算完成。`acceptance` 是 review 的依據 |
| `task.reviews` | 之前的 review。`decision: "reject"` 的 `comment` 是 PM 要你改的地方，這次一定要處理 |
| `resume` | 不是 `null` 就是接手續作，見第 4 節 |
| `git.branch` | 任務分支 |
| `git.commit_prefix`、`git.commit_trailers` | commit 格式，見第 5 節 |
| `lease_ms`、`heartbeat_every_ms` | 租約時長和建議的續約間隔 |

## 4. 切到任務分支，讀懂任務

**切分支**（不寫代碼的任務可以跳過）。把 `B` 換成 `git.branch`：

```bash
git fetch origin
git status --porcelain
```

`git status --porcelain` 有輸出，表示工作目錄有不屬於這個任務的改動：先 `git stash push -u -m "agent-pm：切到 $B 之前的遺留改動"`，在最後的回報裡告訴使用者，不要把它們帶進任務。然後：

```bash
if git rev-parse --verify --quiet "origin/$B" >/dev/null; then
  git checkout -B "$B" "origin/$B"     # 遠端已有：別人做過一部分，以遠端為準
else
  BASE=$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/main)
  git checkout --no-track -B "$B" "$BASE"   # 沒有：從預設分支開一個新的，不追蹤預設分支
fi
```

**接手續作**（`resume` 不是 `null`）：

1. 讀 `resume.summary`（做完了什麼）、`resume.next_steps`（接下來做什麼）、`resume.handoff_note`（上一位的交接說明）、`resume.auto_note`（中斷前的輸出片段）、`resume.reason`（為什麼停：`usage_limit` 額度用完、`interrupted` 被打斷、`lease_expired` 斷線、`changes_requested` 被退回）。
2. 用 `git log --oneline -10`、`git diff <預設分支>...HEAD --stat` 和實際的檔案確認哪些已經完成。**以實際內容為準**：檢查點說做完了但分支上沒有的，要補；分支上已經有的，不要重寫、不要推倒重來。
3. 先存一個檢查點，`summary` 寫「接手：確認了哪些已完成，打算從哪裡繼續」，`progress` 沿用 `resume.progress`。

**看清驗收標準**：開始前把 `acceptance` 拆成一條條可以檢查的項目。被退回過的任務，先處理 review 意見。

## 5. 幹活：小步、續約、檢查點

把任務拆成幾個小步驟，每一步做完都走一遍：

1. **commit**，格式固定（`git.commit_prefix` 形如 `[site/api]`）：

   ```bash
   git add -A          # 先看一眼 git status，不要把依賴目錄、建置產物、密鑰加進去
   git commit -m "[<項目短名>/<任務 key>] <這一步做了什麼>" -m "Project: <項目短名>
   Task: <task.id>
   Worker: <worker_id>"
   ```

2. **`heartbeat`**，確認租約還在。
3. **push**：`git push -u origin "HEAD:$B"`。
4. **`save_checkpoint`**：

   | 欄位 | 寫什麼 |
   | --- | --- |
   | `summary` | 到目前為止完成了什麼，具體到檔案和功能 |
   | `next_steps` | 接下來要做什麼，寫到一個沒看過這段對話的人照著就能接著做 |
   | `progress` | 0 到 100 的老實估計 |
   | `commit` | 剛 push 的 commit（`git rev-parse --short HEAD`） |
   | `artifacts` | 其他中間產物的鏈接或路徑（可選） |

**續約的節奏**：

- 每做 3 到 5 次工具調用就 `heartbeat` 一次，`save_checkpoint` 也算一次續約。拿不準過了多久，就再調一次，多調沒有壞處。
- 預計超過 1 分鐘的命令（安裝依賴、完整測試、構建），開始前先 `heartbeat`，放到背景執行（Bash 的 `run_in_background`），等待期間每隔不到 1 分鐘 `heartbeat` 一次再看輸出。有 `Monitor` 工具時，用它每 40 秒左右喚醒自己一次來續約。前台命令不要超過 2 分鐘。
- 長時間思考或寫大段內容之前，也先 `heartbeat`。
- 至少每 10 分鐘，或每完成一個能說清楚的段落，就存一個檢查點。

## 6. 收尾

**完成**：

1. 對照 `acceptance` 逐條自查，該跑的測試跑一遍。
2. 最後一次 commit、`heartbeat`、push。
3. 寫代碼的任務開 PR。有 `gh` 時：

   ```bash
   gh pr create --head "$B" --title "[<項目短名>/<任務 key>] <任務標題>" --body "<做了什麼、怎麼驗證；附上 Project、Task 兩行>"
   ```

   開不了 PR（沒有 `gh`、沒權限），就在 summary 裡寫上分支和 commit，不要卡在這裡。
4. `submit_result`：`summary` 寫做了什麼、逐條對照驗收標準的結果、分支和 commit；有 PR 就填 `pr_url`。任務進入 `in_review`，你就不再持有它了。

**受阻**（任務本身做不下去：缺權限、缺資料、需要人類決定）：commit、`heartbeat`、push、`save_checkpoint`，然後 `report_blocked`，`reason` 寫清楚缺什麼、需要誰做什麼決定。

**交出**（任務沒問題，是你自己沒法繼續：使用者叫你停、你知道額度快用完、上下文太長、這台電腦做不了）：commit、`heartbeat`、push，存一個 `next_steps` 寫得特別詳細的檢查點，再調用 `release_task`：

| `reason` | 什麼時候用 |
| --- | --- |
| `interrupted` | 使用者叫你停下 |
| `usage_limit` | 額度快用完 |
| `released` | 其他原因主動讓出，例如這台電腦缺工具 |
| `error` | 環境出錯（例如切不了任務分支） |

`note` 寫給接手者：停在哪裡、有什麼要注意的坑。

## 7. 收到 `lease_lost`

1. 立刻停止寫入：不 push、不 `save_checkpoint`、不 `submit_result`。
2. 用 `get_task` 看任務現在的狀態：
   - `ready` 或 `changes_requested`：只是租約超時，還沒人接手。用 `claim_task` 帶 `task_id` 重新領回來，`heartbeat` 成功後照常繼續（先 push 再存檢查點）。
   - `claimed` 而且 `assignee` 不是你：已經被別人接手。不要再 push，也不要動遠端的那個分支。本地沒推上去的東西不要刪，收起來留給使用者決定：未 commit 的改動用 `git stash push -u -m "agent-pm：lease_lost，未推送的改動 <task.id>"`；已 commit 但沒 push 的，用 `git branch "agent-pm-unpushed/<task.id>"` 留一個本地分支。告訴使用者有這些東西，然後結束這個任務。
   - `in_review`、`blocked`、`done`：任務已經被處理掉了，結束這個任務。

## 8. 連續領任務（`loop`）

- 一個任務結束（交付、受阻、交出、lease_lost）後，回到第 3 節再領下一個。每個新任務都要重新切分支，不能沿用上一個任務的分支。
- 沒有任務時等 1 分鐘再問（例如 `sleep 55`），連續 5 次都沒有就停下。
- 做滿 `N` 個，或使用者叫你停，就停下。
- 上下文太長時，在兩個任務之間停下，建議使用者 `/clear` 後重新執行 `/agent-pm-worker`。任務狀態都在協調服務上，重開不會丟。

## 9. 回報給使用者

檢查點、交接說明和交付說明用任務本身的語言寫（任務是中文就寫中文），因為接手者和 PM 要看。

每個任務結束時用幾行話告訴使用者：用的 worker_id、任務（項目短名和標題）、是從頭做還是接手（從百分之幾）、結果（已交付 / 受阻 / 已交出 / 被接手）、分支和 PR 鏈接，還有第 4、7 節 stash 起來的改動（如果有）。
