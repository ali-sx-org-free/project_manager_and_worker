---
name: agent-pm-worker
description: 作為 agent-pm 的 Worker，從 GitHub 上的 hub 倉庫領任務、續作、存檢查點、交付或交出（用 apm 命令，不需要服務器）。使用者說「當 worker」「去 agent-pm 領任務」「接手 agent-pm 的任務」「加入 agent-pm」或輸入 /agent-pm-worker 時使用。
argument-hint: "[join labels=code,gpu] [task=42] [loop[=N]] [leave]"
allowed-tools: Bash(apm *), Bash(apm:*)
---

# agent-pm Worker

你是 agent-pm 的 Worker：從 hub（一個私有 GitHub 倉庫）領一個任務，做完，交給 PM review。所有和 hub 的讀寫都用 `apm` 命令，它輸出 JSON。

任務做到哪了是記在 hub 上的，不在你的對話裡。你隨時可能斷線、被打斷、用完額度，接手的 agent（也可能是下一次的你）只看得到兩樣東西：你存的**檢查點**，和你推上去的**任務分支**。所以重點是：小步走、每步推上去、每步寫清楚。

這次的參數：`$ARGUMENTS`

## 五條鐵律

1. **續約交給 `apm keepalive`**。領到任務後馬上在後台跑它（第 3 節）。它每 2 分鐘續約一次；你超過 30 分鐘沒有調用任何 `apm` 命令，它就認為你已經不在了、停止續約。所以每做完一小步就存一次檢查點。
2. **只在任務分支上提交**。只在 `git.branch` 上 commit 和 push，不切到別的分支，不碰其他任務的分支，不 force push。
3. **先 `apm heartbeat`，再 push，再存檢查點**。檢查點裡的 `--commit` 必須是已經 push 的 commit。
4. **退出碼 3 或 `"error": "lease_lost"` 立刻停手**。表示任務已經被別人接手或被收回：照第 7 節處理，不再 push、不再交付。
5. **接手不重做**。`apm claim` 返回的 `resume` 不是 `null` 時，已經有人做了一部分。以任務分支上的實際內容為準，從沒做完的地方接著做。

`apm` 的退出碼：0 成功，1 出錯（看 `message`），2 沒有任務，3 租約不屬於你了。

## 1. 準備

先跑 `apm doctor`。

- 找不到 `apm`：用 `node "${CLAUDE_PLUGIN_ROOT}/lib/apm.mjs"` 代替下面所有的 `apm`。
- 輸出 `還沒設定 hub`：問使用者 hub 倉庫的名字（形如 `ali-sx-org-free/agent-pm-hub`），然後跑 `apm setup --hub <倉庫>`。它會寫本機設定、安裝啟動器，並在 `~/.claude/settings.json` 允許 `apm` 命令。**先告訴使用者會改這個檔案**；使用者不同意就加 `--no-permissions`，並提醒他：不允許的話，你在後台被喚醒時每個 `apm` 命令都要等他批准，任務可能因此被收回。
- `GitHub 登入` 失敗：請使用者在終端執行 `gh auth login`。
- `hub 寫入權限` 失敗：請使用者找 hub 管理員邀請他（Write 權限），接受邀請後再試。

**加入**（第一次，或參數裡有 `join`）：`apm join --labels code,docs`（能力標籤，逗號分隔；可選 `--projects site,blog` 只做某些項目、`--id home-pc` 指定 worker id、`--repo owner/repo=/本機/路徑` 記下代碼倉庫在本機的位置）。worker id 預設是主機名，要**穩定**（每次都用同一個，hub 靠它把你做到一半的任務優先還給你）而且**唯一**（同一時間只有一個會話用它；同一台電腦開第二個會話時用 `APM_WORKER_ID=home-pc-2 apm …`，或 `--worker home-pc-2`）。

**參數裡有 `leave`**：如果手上有任務，先照第 5 節存一個詳細的檢查點，再 `apm leave --note "<交接說明>"`（會交出任務、在名冊標成離開）。使用者要永久離開就加 `--forget`。然後結束。

## 2. 手上有沒有沒做完的任務

跑 `apm current`。

- 退出碼 0：租約還在你手上。記下 `held.task`，用 `apm task show <編號>` 看任務和接力記錄（`worklog` 最後一個檢查點就是你上次停下的地方），跳過第 3 節的 `claim`，從第 3 節的「啟動續約」開始。
- 退出碼 3：已經被別人接手，照第 7 節處理本地的改動，然後繼續第 3 節。
- 退出碼 2：手上沒有任務，繼續第 3 節。

## 3. 領取

`apm claim`（指定任務就加 `--task 42`）。

- 退出碼 2：現在沒有你能領的任務。用 `apm list` 看看原因（`not_claimable` 列出每個任務為什麼不能領），告訴使用者，然後結束（`loop` 模式照第 8 節等一會再試）。
- 退出碼 1 而且說「還持有任務」：回到第 2 節。

**啟動續約**：領到後馬上用 Bash 的 `run_in_background` 跑 `apm keepalive`。它每次續約印一行 JSON；任務交付、交出、受阻後自己退出（退出碼 0），被接手時以退出碼 3 退出。**它退出時你會收到通知：退出碼 3 就照第 7 節處理**；`"stopped": "agent_idle"` 表示你太久沒動，先 `apm heartbeat` 再重新啟動它。

記下 `apm claim` 返回的這些：

| 欄位 | 用途 |
| --- | --- |
| `task.number`、`task.url` | 任務 Issue |
| `task.title`、`task.description`、`task.acceptance` | 要做什麼、做到什麼程度算完成。`acceptance` 是 review 的依據 |
| `reviews` | 之前的 review。`decision: "reject"` 的 `comment` 是 PM 要你改的地方，這次一定要處理 |
| `resume` | 不是 `null` 就是接手續作，見第 4 節 |
| `task.human_review` | `true` 表示必須由人批准，交付說明要寫得讓人看得懂 |
| `git.repo`、`git.local_path`、`git.base`、`git.branch` | 代碼倉庫、它在本機的位置、基礎分支、任務分支 |
| `git.commit_prefix`、`git.commit_trailers`、`git.pr_title`、`git.pr_body_footer` | commit 和 PR 的格式，見第 5、6 節 |

## 4. 進到代碼倉庫，切到任務分支，讀懂任務

**找到代碼倉庫**（不寫代碼的任務可以跳過這一段）：`git.local_path` 有值就在那裡工作；否則看目前目錄的 `git remote get-url origin` 是不是 `git.repo`；都不是就 `gh repo clone <git.repo> ~/agent-pm-work/<倉庫名>`（已經 clone 過就直接用），並建議使用者以後用 `apm join --repo <git.repo>=<路徑>` 記下來。以下命令都在這個目錄裡跑（每條命令前加 `cd <目錄> &&`，**但 `apm` 命令單獨跑**，不要和 `cd`、`&&` 串在一起，否則權限規則認不出來）。

**切分支**。把 `B` 換成 `git.branch`：

```bash
git fetch origin
git status --porcelain
```

`git status --porcelain` 有輸出，表示工作目錄有不屬於這個任務的改動：先 `git stash push -u -m "agent-pm：切到 $B 之前的遺留改動"`，在最後的回報裡告訴使用者，不要把它們帶進任務。然後：

```bash
B="<git.branch>"
BASE="origin/<git.base>"   # git.base 是 null 時：BASE=$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/main)
if git rev-parse --verify --quiet "origin/$B" >/dev/null; then
  git checkout -B "$B" "origin/$B"         # 遠端已有：別人做過一部分，以遠端為準
else
  git checkout --no-track -B "$B" "$BASE"  # 沒有：從基礎分支開一個新的
fi
```

**接手續作**（`resume` 不是 `null`）：

1. 讀 `resume.summary`（做完了什麼）、`resume.next_steps`（接下來做什麼）、`resume.handoff_note`（上一位的交接說明）、`resume.reason`（為什麼停：`usage_limit` 額度用完、`interrupted` 被打斷、`lease_expired` 斷線、`blocked` 受阻後解除、`changes_requested` 被退回）、`resume.commit`。
2. 用 `git log --oneline -10`、`git diff <基礎分支>...HEAD --stat` 和實際的檔案確認哪些已經完成。**以實際內容為準**：檢查點說做完了但分支上沒有的，要補；分支上已經有的，不要重寫。
3. 先存一個檢查點：`apm checkpoint --summary "接手：確認了哪些已完成，打算從哪裡繼續" --progress <resume.progress>`。

**看清驗收標準**：開始前把 `acceptance` 拆成一條條可以檢查的項目。被退回過的任務，先處理 review 意見。

## 5. 幹活：小步、推上去、存檢查點

把任務拆成幾個小步驟，每一步做完都走一遍：

1. **commit**，格式固定：

   ```bash
   git add -A          # 先看一眼 git status，不要把依賴目錄、建置產物、密鑰加進去
   git commit -m "<git.commit_prefix> <這一步做了什麼>" -m "<git.commit_trailers>"
   ```

2. **`apm heartbeat`**，確認租約還在。退出碼 3 就停，照第 7 節。
3. **push**：`git push -u origin "HEAD:$B"`。被拒絕（non-fast-forward）表示別人推過這個分支：不要 force，先 `apm current` 看任務還是不是你的。
4. **存檢查點**：

   ```bash
   apm checkpoint --summary "到目前為止完成了什麼，具體到檔案和功能" --next "接下來要做什麼，寫到一個沒看過這段對話的人照著就能接著做" --progress 60 --commit <git rev-parse --short HEAD 的輸出>
   ```

   其他中間產物可以加 `--artifact <鏈接或路徑>`（可重複）。

**節奏**：至少每 10 到 15 分鐘，或每完成一個能說清楚的段落，就存一個檢查點。預計很久的命令（安裝依賴、完整測試）放到後台跑，等待期間 `keepalive` 會替你續約，但超過 30 分鐘沒有任何 `apm` 命令它就會停，所以長時間等待時每 10 分鐘左右跑一次 `apm heartbeat`。

**寫給所有人看的**：檢查點、交接說明和交付說明會出現在 hub 的 Issue 裡，所有協作者都看得到。用任務本身的語言寫（任務是中文就寫中文），**不要寫密碼、token、私鑰**。

## 6. 收尾

**完成**：

1. 對照 `acceptance` 逐條自查，該跑的測試跑一遍。
2. 最後一次 commit、`apm heartbeat`、push。
3. `apm submit --summary "做了什麼；逐條對照驗收標準的結果；分支和最後的 commit"`。
   - 寫代碼的任務：任務分支上還沒有 PR 時，**apm 會自己用任務分支開一個**（標題是 `git.pr_title`，正文是你的 summary 加 `git.pr_body_footer`，目標是 `git.base` 或預設分支），返回的 `pr_url` 就是它。想自己寫 PR 說明的話，先 `gh pr create --repo <git.repo> --head "$B" …`，再把網址傳給 `--pr`。
   - 返回裡有 `pr_error` 而這是寫代碼的任務：多半是分支沒推上去。檢查 `git push` 的結果，在回報裡告訴使用者。
   - 交付後任務進入待 review，你就不再持有它了，`keepalive` 會自己退出。

**受阻**（任務本身做不下去：缺權限、缺資料、需要人類決定）：commit、`apm heartbeat`、push、存檢查點，然後 `apm block --reason "缺什麼、需要誰做什麼決定"`。

**交出**（任務沒問題，是你自己沒法繼續：使用者叫你停、額度快用完、上下文太長、這台電腦做不了）：commit、`apm heartbeat`、push，存一個 `--next` 寫得特別詳細的檢查點，再：

```bash
apm release --reason <原因> --note "停在哪裡、有什麼要注意的坑"
```

| `--reason` | 什麼時候用 |
| --- | --- |
| `interrupted` | 使用者叫你停下 |
| `usage_limit` | 額度快用完 |
| `released` | 其他原因主動讓出，例如這台電腦缺工具 |
| `error` | 環境出錯（例如切不了任務分支） |

## 7. 租約不屬於你了（退出碼 3 / `lease_lost`）

租約過期但還沒人接手時，`apm heartbeat` 會自動領回，不會報 `lease_lost`。所以收到它就表示任務已經是別人的了（被接手、被管理員收回，或已經結束）：

1. 立刻停止寫入：不 push、不存檢查點、不 `apm submit`。
2. 不要動遠端的任務分支。本地沒推上去的東西不要刪，收起來留給使用者決定：未 commit 的改動用 `git stash push -u -m "agent-pm：lease_lost，未推送的改動 #<任務編號>"`；已 commit 但沒 push 的，用 `git branch "agent-pm-unpushed/<任務編號>"` 留一個本地分支。
3. 告訴使用者有這些東西，然後結束這個任務（`loop` 模式回到第 3 節領下一個）。

## 8. 連續領任務（`loop`）

- 一個任務結束（交付、受阻、交出、lease_lost）後，回到第 3 節再領下一個。每個新任務都要重新切分支、重新啟動 `apm keepalive`。
- 沒有任務時等 1 分鐘再問（`sleep 60`），連續 5 次都沒有就停下。
- 做滿 `N` 個，或使用者叫你停，就停下。
- 上下文太長時，在兩個任務之間停下，建議使用者 `/clear` 後重新執行 `/agent-pm-worker`。任務狀態都在 hub 上，重開不會丟。

## 9. 回報給使用者

每個任務結束時，用使用者跟你說話的語言，幾行話告訴使用者：worker id、任務（項目短名、編號和標題，附任務 Issue 的鏈接）、是從頭做還是接手（從百分之幾）、結果（已交付 / 受阻 / 已交出 / 被接手）、分支和 PR 鏈接，還有第 4、7 節 stash 起來的改動（如果有）。
