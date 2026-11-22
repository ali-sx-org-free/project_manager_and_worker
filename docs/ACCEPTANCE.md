# 驗收教程：一步步確認「不用服務器」方案能用

這份教程帶你從零走完整套流程，每一關都寫了**做什麼**和**應該看到什麼**。對不上的地方就是問題，把那一關的輸出貼給我。

| 關卡 | 驗什麼 | 要真 GitHub 嗎 | 大約時間 |
| --- | --- | --- | --- |
| 第 1 關 | 自動測試和離線自測 | 不要 | 5 分鐘 |
| 第 2 關 | 管理端（假 hub） | 不要 | 5 分鐘 |
| 第 3 關 | 建 hub、本機設定 | 要 | 10 分鐘 |
| 第 4 關 | PM 建項目 | 要 | 5 分鐘 |
| 第 5 關 | 6 個 worker 同時搶任務不撞車 | 要 | 5 分鐘 |
| 第 6 關 | 做到一半交出，另一個 worker 接著做 | 要 | 10 分鐘 |
| 第 7 關 | 斷線：租約過期被接手，原 worker 收到 lease_lost | 要 | 5 分鐘 |
| 第 8 關 | 交付、自動開 PR、退回、批准合併；在 GitHub 網頁上合併 | 要 | 10 分鐘 |
| 第 9 關 | 真的讓 Claude Code 當 Worker 和 PM | 要 | 15 分鐘 |
| 第 10 關 | 管理端連真 hub，人工批准，項目交付 | 要 | 5 分鐘 |
| 第 11 關 | 退出和清理 | 要 | 5 分鐘 |

整個過程只用你自己一個 GitHub 帳號：同一個帳號既當 PM 也當幾個 worker（用不同的 worker id 區分），和真實多人使用的流程一樣，只是少了邀請成員那一步。

## 準備

需要：Node.js 20 以上、git、GitHub CLI（`gh`），第 9 關要 Claude Code。

```bash
node -v          # v20 以上
git --version
gh --version     # 沒有的話：https://cli.github.com
```

Windows 請在 Git Bash 裡跑下面的命令。

拿代碼（PR 合併之前用 `claude/github-hub` 分支，合併後用 `main`）：

```bash
git clone https://github.com/ali-sx-org-free/project_manager_and_worker.git
cd project_manager_and_worker
git checkout claude/github-hub
npm install
```

在第 3 關裝好啟動器之前，先用一個臨時別名代替 `apm` 命令：

```bash
alias apm="node $PWD/plugin/lib/apm.mjs"
apm version      # 印出 0.2.0
```

## 第 1 關：自動測試和離線自測

```bash
npm test
apm selftest --text
```

**應該看到**

- `npm test` 跑四個包，每個包最後都是 `# fail 0`（core 18 個、server 6 個、github 21 個、console 2 個）。
- `apm selftest` 的最後幾行：

  ```
  ✓ 建 hub（標籤、設定、名冊）
  ✓ 20 個 worker 同時搶 5 個任務，每個任務只有一個人拿到：5 個 worker 領到，15 個什麼都沒拿到
  ✓ 上游批准前下游不可領；批准後解鎖；全部完成後交付：全部完成後項目自動交付
  ✓ 交出後別人續作，拿到上一位的檢查點：從 40% 接著做：寫第三章
  ✓ 斷線超過租約，別人接手；原 worker 回來得到 lease_lost

  全部通過
  ```

`selftest` 不連網，用的是記憶體裡的假 GitHub，但走的是和真 GitHub 完全一樣的代碼路徑（除了鎖的那一層，第 5 關在真 GitHub 上驗）。

## 第 2 關：管理端（假 hub）

```bash
npm run build
npm run console -- --fake
```

瀏覽器打開 <http://localhost:4000>。

**應該看到**

- 原來的 3D 介面，兩個項目，三個假 worker（amy-laptop、bob-pc、amy-desktop）在領任務、存檢查點、交付；一個假 PM 大多數批准、偶爾退回。
- 右上角有「GitHub · demo/agent-pm-hub」按鈕，點開左邊出現 hub 面板：同步狀態、API 額度、正在執行的任務（每個有「收回」）、Worker 名冊、「立即同步」「對齊標籤」「清理舊鎖」。
- 點任何一個任務，右邊側欄有接力記錄（第幾次領取、檢查點、交接）和「在 GitHub 上打開 #編號」。
- 試試在側欄批准或退回一個待 review 的任務，狀態馬上變。

看完按 Ctrl+C 結束。

## 第 3 關：建 hub、本機設定

先登入 GitHub：

```bash
gh auth login        # GitHub.com → HTTPS → 用瀏覽器登入
gh auth status       # 看到 Logged in to github.com account <你的帳號>
```

接下來都用這個變量代表 hub 倉庫（把 `<你的帳號>` 換掉；也可以用組織名）：

```bash
export HUB=<你的帳號>/agent-pm-hub-test
apm init $HUB --create
```

**應該看到**

```
hub 已就緒：https://github.com/<你的帳號>/agent-pm-hub-test
私有：是 · 設定檔：已建立 · 名冊：#1
```

到 GitHub 網頁上看這個倉庫：

- [ ] 倉庫名旁邊標著 **Private**。
- [ ] 有 `.agent-pm/config.yml` 和 `README.md`。
- [ ] Issues → Labels 裡有 `apm:project`、`apm:task`、`apm:roster`、`status:ready`、`status:claimed`、`status:in-review` 等。
- [ ] Issue #1「Worker 名冊」。

**把租約改短**，後面等「斷線被接手」時不用等 10 分鐘：在網頁上編輯 `.agent-pm/config.yml`，把兩行改成下面這樣並 commit。

```yaml
lease_minutes: 2
heartbeat_minutes: 1
```

然後做本機設定：

```bash
apm setup --hub $HUB --labels docs
```

**應該看到**：本機設定和啟動器的路徑，`Claude Code 權限：在 ~/.claude/settings.json 加上 Bash(apm *)…`，然後是一串檢查，`hub 設定` 那一行是 `租約 2 分鐘、續約間隔 1 分鐘`。

照它的提示把啟動器加進 PATH，換掉臨時別名：

```bash
export PATH="$HOME/.agent-pm/bin:$PATH"   # 想長期用就寫進 ~/.zshrc 或 ~/.bashrc
unalias apm
apm doctor
```

- [ ] `apm doctor` 每一行都是 ✓。`本機時鐘` 是 ✗ 也可以繼續（租約只看 GitHub 的時間），但說明你的電腦時間不準。

## 第 4 關：PM 建項目

練習項目在 [examples/github-plan.json](examples/github-plan.json)：寫一本團隊手冊，三個互不依賴的章節，加一個依賴它們三個、而且必須由人批准的目錄頁。不寫代碼，文件直接放在 hub 倉庫裡，所以不需要另外的代碼倉庫。

```bash
apm project create -f docs/examples/github-plan.json
apm status
```

**應該看到**

```
建好項目 #2「驗收練習：寫一本團隊手冊」（handbook）：https://github.com/<你的帳號>/agent-pm-hub-test/issues/2
   #3 onboarding 可領取
   #4 review 可領取
   #5 oncall 可領取
   #6 index 等依賴
```

（編號以你那邊的輸出為準，下面都按 #3 到 #6 寫。）

到 GitHub 上看：

- [ ] Issue #2 帶 `apm:project` 標籤，下面掛著 4 個 sub-issue，顯示 0 / 4 的進度。
- [ ] #3、#4、#5 帶 `status:ready`、`cap:docs`；#6 帶 `status:pending` 和 `review:human`。
- [ ] 打開 #3：正文就是任務說明和驗收標準（隱藏的機器數據在原始 Markdown 末尾，網頁上看不到）。

## 第 5 關：6 個 worker 同時搶任務

先把 hub clone 到本機（任務分支要推到這裡），並告訴 apm 它在哪：

```bash
gh repo clone $HUB ~/agent-pm-work/agent-pm-hub-test
apm join --labels docs --repo $HUB=$HOME/agent-pm-work/agent-pm-hub-test
```

讓 6 個 worker 同時領：

```bash
for i in 1 2 3 4 5 6; do
  (APM_WORKER_ID=race-$i apm claim > /dev/null 2>&1; echo "race-$i 退出碼 $?") &
done; wait
apm locks
```

**應該看到**

- [ ] 剛好 3 個 `退出碼 0`，另外 3 個 `退出碼 2`（沒有可領的任務）。不應該有退出碼 1。
- [ ] `apm locks` 列出 3 條 `held` 的鎖：#3、#4、#5 各一條，持有者是退出碼 0 的那 3 個 race-N，沒有一個任務出現兩次。
- [ ] GitHub 倉庫的 Branches 頁面多了 `apm-lock/3`、`apm-lock/4`、`apm-lock/5`；這三個 Issue 的標籤變成 `status:claimed`，各有一條「第 1 次領取」的留言。

為什麼不會撞車：每個 worker 都是 `git push --force-with-lease` 推鎖分支，GitHub 在服務器端比對，只有一個能成功。

把它們都交出去，再從名冊裡刪掉這幾個臨時 worker：

```bash
for i in 1 2 3 4 5 6; do APM_WORKER_ID=race-$i apm leave --forget; done
apm status
```

- [ ] `apm status` 裡 #3、#4、#5 回到「可領取」。

## 第 6 關：做到一半交出，另一個 worker 接著做

開兩個終端，A 和 B（第二個終端記得也 `export HUB=…` 和 `export PATH=…`）。

**終端 A**（worker `pc-a`）：

```bash
export APM_WORKER_ID=pc-a
apm claim --task 3
```

應該看到 `領到 #3「手冊：新人入職」（handbook，第 2 次領取）`、`從頭開始`、`分支 project/handbook/onboarding-3`（第 1 次是第 5 關的 race-N，它沒存檢查點就交出了，所以是從頭開始）。

在 hub 的本機副本裡寫第一節，提交、推送、存檢查點：

```bash
cd ~/agent-pm-work/agent-pm-hub-test
git fetch origin
git checkout --no-track -B project/handbook/onboarding-3 origin/main
mkdir -p handbook
printf '# 新人入職\n\n## 第一天\n\n- 領電腦和帳號\n- 跟導師吃午飯\n- 讀完這本手冊\n' > handbook/onboarding.md
git add handbook && git commit -m "[handbook/onboarding] 第一天"
git push -u origin HEAD:project/handbook/onboarding-3
apm checkpoint --summary "寫好了「第一天」" --next "接著寫「第一週」和「找誰問問題」" --progress 30 --commit $(git rev-parse --short HEAD)
apm release --reason usage_limit --note "額度快用完了。第一天寫好了，從第一週接著寫"
```

- [ ] GitHub 上 #3 多了兩條留言：「**第 2 次領取** · pc-a」的進度留言（檢查點是就地更新進這一條的，編輯留言不發通知），和「**交出任務**（用量額度用完）· pc-a」的交接說明。
- [ ] #3 回到 `status:ready`，`apm status` 裡顯示「可領取 30%」。

**終端 B**（worker `pc-b`）：

```bash
export APM_WORKER_ID=pc-b
apm claim --task 3
```

**應該看到**

```
領到 #3「手冊：新人入職」（handbook，第 3 次領取）
續作：上一位 pc-a 做到 30%（usage_limit）
  寫好了「第一天」
  接下來：接著寫「第一週」和「找誰問問題」
```

再確認 B 拿得到 A 推上去的內容：

```bash
cd ~/agent-pm-work/agent-pm-hub-test
git fetch origin
git checkout -B project/handbook/onboarding-3 origin/project/handbook/onboarding-3
cat handbook/onboarding.md      # 有「第一天」那一節
```

## 第 7 關：斷線，租約過期被接手

這一關不跑 `apm keepalive`，模擬電腦斷線。

**終端 A**：

```bash
apm claim --task 4
```

然後什麼都不做，**等 3 分鐘**（租約是 2 分鐘）。

```bash
apm status
```

- [ ] #3 和 #4 都顯示「失聯，待接手」（B 拿著 #3 也沒有續約）。

**開第三個終端 C**：

```bash
export APM_WORKER_ID=pc-c
apm claim --task 4
```

- [ ] C 領到 #4（第 3 次領取）。GitHub 上 #4 多了一條替 pc-a 補記的「**租約超時** · pc-a（第 2 次領取）超過租約沒有續約，由 pc-c 接手。」

回到**終端 A**：

```bash
apm heartbeat; echo "退出碼 $?"
```

- [ ] 錯誤：`任務 #4 的租約已經不屬於你（現在：pc-c held），請停手`，**退出碼 3**。Worker Skill 收到它就會停手、把沒推的改動收進 stash。

回到**終端 B**：

```bash
apm heartbeat
```

- [ ] `#3 已續約`。租約過期但還沒人接手時，原持有者回來照樣能續上。

正常使用時，Worker Skill 領到任務後會在後台跑 `apm keepalive`，每 1 分鐘（預設 2 分鐘）續約一次，就不會失聯了。想看它怎麼工作：在終端 B 跑 `apm keepalive`，它每次續約印一行 JSON，看兩行後 Ctrl+C。

## 第 8 關：交付、自動開 PR、退回、批准

**終端 B** 把 #3 寫完並交付：

```bash
cd ~/agent-pm-work/agent-pm-hub-test
printf '\n## 第一週\n\n- 跑通本機環境\n- 修一個小 bug\n- 參加週會\n\n## 找誰問問題\n\n- 導師\n- 團隊頻道\n- 值班的人\n' >> handbook/onboarding.md
git commit -am "[handbook/onboarding] 第一週、找誰問問題"
apm heartbeat
git push origin HEAD:project/handbook/onboarding-3
apm submit --summary "三節都寫好了，每節三行"
```

**應該看到**：`#3 已交付，等待 review：https://github.com/…/pull/7（apm 開的 PR）`

- [ ] GitHub 上有這個 PR：標題 `[handbook/onboarding] 手冊：新人入職`，正文是交付說明加上 `Project: handbook`、`Task: …#3`，目標分支 main。
- [ ] #3 變成 `status:in-review`。

**當 PM 退回**（哪個終端都可以；review 和 worker id 無關，看的是你的 GitHub 帳號是不是項目 manager）：

```bash
apm review 3 --reject --comment "「第一天」再加一行：誰來接你"
```

- [ ] #3 和 PR #7 上都出現了這條意見；#3 變成 `status:changes-requested`。

**終端 B** 重新領（被退回的任務優先還給原來的 worker）：

```bash
apm claim
```

- [ ] 輸出裡有 `被退回：「第一天」再加一行：誰來接你`。

改完再交：

```bash
cd ~/agent-pm-work/agent-pm-hub-test
sed -i.bak 's/- 讀完這本手冊/- 讀完這本手冊\n- 導師在門口接你/' handbook/onboarding.md && rm handbook/onboarding.md.bak
git commit -am "[handbook/onboarding] 第一天：誰來接你"
apm heartbeat
git push origin HEAD:project/handbook/onboarding-3
apm submit --summary "按意見補了「導師在門口接你」"
```

（macOS 的 sed 不認 `\n` 的話，直接用編輯器在「讀完這本手冊」下面加一行也可以。）

- [ ] 這次沒有開新的 PR，用的還是 #7。

**當 PM 批准**：

```bash
apm review 3 --approve --comment "可以了"
```

- [ ] 輸出 `#3 通過，PR 已合併`。PR #7 已合併，#3 已關閉（completed），項目 #2 的進度變成 1 / 4。

**在 GitHub 網頁上合併**：人不一定用 apm，也可以直接在 PR 頁面操作，apm 事後補上。

**終端 C**（第 7 關接手了 #4）把 #4 交了：

```bash
cd ~/agent-pm-work/agent-pm-hub-test
git fetch origin && git checkout --no-track -B project/handbook/review-4 origin/main
mkdir -p handbook
printf '# 代碼 review 規範\n\n## 什麼時候要 review\n\n- 每個 PR\n- 改設定\n- 改權限\n\n## 看什麼\n\n- 對不對\n- 測試\n- 可讀性\n\n## 怎麼給意見\n\n- 具體\n- 給理由\n- 分清必改和建議\n' > handbook/review.md
git add handbook && git commit -m "[handbook/review] 三節"
apm heartbeat
git push -u origin HEAD:project/handbook/review-4
apm submit --summary "review.md 三節寫好了"
```

然後到 GitHub 上打開它開的 PR，點 **Merge pull request**。再：

```bash
apm reconcile --dry-run   # 先看會改什麼：應該是「#4：PR 上的 review：已批准/合併」
apm reconcile
apm status
```

- [ ] #4 變成「完成」並已關閉。（你在網頁上點 Approve 或 Request changes 也會被補上；但 GitHub 不讓你 approve 自己開的 PR，所以單帳號驗收只能試合併。）

## 第 9 關：讓 Claude Code 當 Worker 和 PM

現在只剩 #5（值班）可領，#6（目錄頁）在等依賴。

**裝插件**。PR 合併之前，直接從本機目錄載入：

```bash
cd ~/agent-pm-work/agent-pm-hub-test
claude --plugin-dir <project_manager_and_worker 的路徑>/plugin
```

（合併以後換成正式安裝：在 Claude Code 裡 `/plugin marketplace add ali-sx-org-free/project_manager_and_worker`，再 `/plugin install agent-pm@agent-pm`。）

這個終端**不要**設 `APM_WORKER_ID`，Claude 會用 `apm setup` 存下的 worker id（預設是主機名）。

**Worker**：在 Claude Code 裡輸入

```
/agent-pm-worker
```

Claude 問 git 和寫檔的權限時允許。`apm` 命令不會再問（第 3 關的 `apm setup` 已經允許了）。

**應該看到** Claude 依次：`apm doctor` → `apm current` → `apm claim`（領到 #5）→ 在後台啟動 `apm keepalive` → 切到 `project/handbook/oncall-5` → 每寫一節就 commit、`apm heartbeat`、push、`apm checkpoint` → `apm submit`（自動開 PR）→ 用幾行中文告訴你結果和 PR 鏈接。

- [ ] 一邊看 GitHub 上 #5 的頁面：進度留言裡的檢查點一條條變多，標籤從 `status:claimed` 變成 `status:in_review`，最後有一個 PR。
- [ ] （可選）Claude 寫到一半時按 Esc，說「先停下，把任務交出去」。它應該存檢查點，然後 `apm release --reason interrupted`。再輸入 `/agent-pm-worker`，它會領回同一個任務並從檢查點接著做。

**PM**：在同一個或另一個 Claude Code 會話裡輸入

```
/agent-pm-pm review
```

- [ ] Claude 用 `apm status` 找到待 review 的 #5，用 `gh pr diff` 看改動，逐條對照驗收標準，然後 `apm review 5 --approve`（或者寫清楚理由退回）。
- [ ] 批准後 #6 自動解鎖成「可領取」。

**再當一次 Worker** 做 #6：

```
/agent-pm-worker
```

做完後再 `/agent-pm-pm review`：

- [ ] #6 帶 `review:human`，**Claude 不會自己批准**。它應該把交付內容和自己的意見整理給你看，告訴你需要你來批准。

## 第 10 關：管理端連真 hub，人工批准

```bash
cd <project_manager_and_worker 的路徑>
npm run console            # 用 apm setup 設的 hub
```

打開 <http://localhost:4000>。

- [ ] 看到 handbook 項目：3 個完成、#6 待 review，worker 有 pc-a、pc-b、pc-c 和 Claude 用的那個。
- [ ] 點右上角「GitHub · <你的帳號>/agent-pm-hub-test」：同步時間、API 額度、Worker 名冊。

**（可選）試「收回」**：先加一個臨時任務讓 pc-a 領走

```bash
apm task add handbook --key extra --title "試收回" --caps docs
APM_WORKER_ID=pc-a apm claim
```

在 hub 面板的「正在執行」裡點它的**收回**，然後：

```bash
APM_WORKER_ID=pc-a apm heartbeat; echo "退出碼 $?"   # 被管理員收回了，退出碼 3
apm task cancel <這個任務的編號> --note "驗收用，不做了"
```

**人工批准**：

- [ ] 點 #6，側欄有「這個任務必須由人批准（review:human）」和「在 GitHub 上打開 #6」。點**批准**。
- [ ] 十幾秒內 #6 變成完成，項目變成已交付；GitHub 上 #6 的 PR 已合併，Issue #2 已關閉，sub-issue 都打了勾。

## 第 11 關：退出和清理

```bash
for id in pc-a pc-b pc-c; do APM_WORKER_ID=$id apm leave; done   # 交出手上的任務（如果有），名冊標成離開
apm locks prune --dry-run      # 看會刪哪些已關閉任務的鎖
apm locks prune
```

- [ ] `apm locks prune` 之後，Branches 頁面上 `apm-lock/*` 只剩還沒關閉的任務（應該一條都不剩）。

不再需要測試倉庫的話：

```bash
gh auth refresh -h github.com -s delete_repo   # gh 預設沒有刪倉庫的權限
gh repo delete $HUB --yes
rm -rf ~/agent-pm-work/agent-pm-hub-test ~/.agent-pm
```

`~/.claude/settings.json` 裡 `permissions.allow` 的 `Bash(apm *)` 等三條也可以手動刪掉。

## 驗收清單

| # | 項目 | 結果 |
| --- | --- | --- |
| 1 | 自動測試全過，`apm selftest` 全部通過 | ☐ |
| 2 | 管理端假 hub 能看、能操作 | ☐ |
| 3 | `apm init` 建出私有 hub（標籤、設定、名冊），`apm setup` / `apm doctor` 通過 | ☐ |
| 4 | 項目和任務以 Issue / sub-issue 的形式出現，依賴的任務是「等依賴」 | ☐ |
| 5 | 6 個 worker 同時搶 3 個任務：剛好 3 個領到，沒有重複 | ☐ |
| 6 | 交出後，接手的人拿到上一位的檢查點和分支 | ☐ |
| 7 | 斷線超過租約被接手；原 worker 收到退出碼 3；沒人接手時能續回 | ☐ |
| 8 | 交付自動開 PR；退回意見同時在任務和 PR 上；批准合併 PR、關閉任務；網頁上合併後 `apm reconcile` 補上 | ☐ |
| 9 | Claude Code 照 Worker Skill 完整做完一個任務；PM Skill 能 review，不會自己批准 `review:human` 的任務 | ☐ |
| 10 | 管理端連真 hub，人工批准後項目交付 | ☐ |
| 11 | 退出和清理 | ☐ |

## 卡住了

- 先跑 `apm doctor`，看哪一行是 ✗。
- `apm task show <編號>` 會列出一個任務的全部接力記錄、review 和現在的鎖。
- 每個命令加 `--json` 可以看到完整輸出。把它和你做的那一步一起貼給我。
- 常見問題見 [GITHUB.md 的「排錯」](GITHUB.md#排錯)。
