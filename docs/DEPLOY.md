# 部署教程：在 Debian 12 雲服務器上跑 PM 協調服務

這份教程把協調服務（PM 的大腦：任務、進度、檢查點、用戶和權限都在它那裡）裝到一台租來的谷歌雲或 AWS 服務器上，讓工作電腦、家裡電腦這些在不同網絡的 worker 都能連進來。不用 Docker，直接裝在系統上。

部署好之後是這樣分工的：

| 在哪裡 | 跑什麼 | 存什麼 |
| --- | --- | --- |
| 雲服務器 | 協調服務 | 資料庫 `data/pm.db` |
| 每台 worker 電腦 | runner 和 Claude Code | 共用工作倉庫（例如 `projects_site_v01`）的 clone |
| GitHub | 什麼都不跑 | 代碼：每個任務一個 `project/<項目>/<任務>-<編號>` 分支 |
| 你的瀏覽器 | 3D 視窗 | 什麼都不存 |

worker 和瀏覽器都不會直接碰資料庫，它們只跟服務器的地址說話。git 推送也不經過服務器，是每台 worker 電腦直接推到 GitHub。

教程分兩部分：

- **第一部分：快速驗證**（約 20 分鐘）。用 `http://服務器IP:4000` 先跑起來，確認瀏覽器和 worker 都連得上。
- **第二部分：正式使用**。驗證通了再做：換成正式的 token、開機自動啟動、加上 HTTPS、每天備份。

每一步都寫了「應該看到」。最後一節寫了哪些步驟我實際跑過、哪些沒有。

---

# 第一部分：快速驗證

## 1. 建服務器

在谷歌雲或 AWS 建一台服務器：

- **系統**：Debian 12（谷歌雲叫 `debian-12-bookworm`，AWS 的映像叫 `Debian 12`）。
- **架構**：x86/64。不要選 ARM（谷歌雲的 `t2a`、AWS 的 `t4g` 系列），下面的命令是按 x86/64 寫的。
- **規格**：1 個 vCPU、**2 GB 內存**、20 GB 硬盤就夠了。例如谷歌雲的 `e2-small`，或 AWS 的 `t3.small`。

建好後**把公網 IP 固定下來**，不然服務器停機再開機後 IP 會變，所有電腦都得改地址：

- 谷歌雲：「VPC 網絡 → IP 地址」，找到這台服務器的外部 IP，點「升級為靜態」。
- AWS：「EC2 → 彈性 IP」，分配一個彈性 IP，再把它關聯到這台服務器。以後就用這個彈性 IP。

然後 SSH 登入。谷歌雲可以直接在控制台點「SSH」按鈕；AWS 用 `ssh -i 你的密鑰.pem admin@服務器IP`（AWS 的 Debian 預設用戶名是 `admin`）。

## 2. 在雲防火牆放行 4000 端口

協調服務用 4000 端口。快速驗證時先讓外面能直接連它：

- **谷歌雲**：「VPC 網絡 → 防火牆」，建一條規則：方向「入站」、目標「網絡中的所有實例」（或者這台服務器的網絡標記）、來源 `0.0.0.0/0`、協議和端口 `tcp:4000`。
- **AWS**：這台服務器的「安全組 → 編輯入站規則」，加一條：類型「自定義 TCP」、端口 `4000`、來源 `0.0.0.0/0`。

## 3. 裝 git、編譯工具和 Node 22

在服務器上執行：

```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential python3
curl -fsSL https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-x64.tar.gz | sudo tar -xz -C /usr/local --strip-components=1
node -v
```

應該看到：最後一行是 `v22.23.5`。

`build-essential` 和 `python3` 是編譯工具，不能省。少了它們，下一步的 `npm install` 會在 SQLite 模組那裡報錯 `gyp ERR! stack Error: not found: make`，我試過。

## 4. 取代碼、安裝

```bash
cd ~
git clone https://github.com/ali-sx-org-free/project_manager_and_worker agent-pm
cd agent-pm
npm install
npm run build
```

應該看到：`npm install` 最後是 `added 201 packages`（數字可能略有不同），`npm run build` 最後是 `✓ built in …`。

## 5. 啟動

```bash
cd ~/agent-pm
PM_TOKEN=test123 LEASE_MS=180000 nohup npm run server > pm.log 2>&1 &
sleep 5; tail -1 pm.log
```

應該看到：

```
[server] 資料庫 /home/你的用戶名/agent-pm/data/pm.db，租約 180000ms，已啟用 token 鑒權
```

- `PM_TOKEN=test123` 是管理員 token。第一部分只是驗證，先用一個好記的；第二部分會換成正式的。
- `LEASE_MS=180000`：worker 斷線 3 分鐘後，它的任務交給別人接手。
- `nohup … &` 讓服務在背景跑，關掉 SSH 視窗後也不會停。

要停掉它：

```bash
pkill -f "tsx src/index.ts"
```

## 6. 驗證：從你自己的電腦連進來

**瀏覽器**：打開 `http://服務器IP:4000/?token=test123`。

應該看到：右上角顯示「實時連線」，場景是空的（還沒有項目）。不帶 `?token=` 打開，右上角顯示「token 無效」，這是對的。

**命令行**（在你自己的電腦上）：

```bash
curl http://服務器IP:4000/api/me -H "authorization: Bearer test123"
```

應該看到：`{"user":{"id":"admin","name":"PM","admin":true,…},"auth":true}`。

連不上的話，多半是第 2 步的防火牆規則沒生效，或者第 5 步的服務沒跑起來（在服務器上看 `cat ~/agent-pm/pm.log`）。

## 7. 連一台 worker

在家裡或公司的電腦上（需要 Node 20 以上和 git），照 [TUTORIAL.md](TUTORIAL.md) 的路線 B 把原型 clone 下來並 `npm install`。

先建一個練習項目，再用 dry-run 確認連得通。dry-run 不呼叫 Claude、不碰 git，只是假裝分 6 步做完任務：

```bash
curl -X POST http://服務器IP:4000/api/projects -H "authorization: Bearer test123" \
  -H "content-type: application/json" -d @docs/examples/multi-site.json

PM_URL=http://服務器IP:4000 PM_TOKEN=test123 WORKER_ID=home-pc WORKER_NAME=家裡電腦 \
  npm run runner -- --dry-run
```

應該看到：

```
[runner home-pc] 連接 http://服務器IP:4000，標籤 []，dry-run
[runner home-pc] 身分：PM（管理員）
[runner home-pc] 領取 [site]「官網：寫 API 文件」（第 1 次領取），從頭開始
…
[runner home-pc] agent 正常退出，已代為提交
```

瀏覽器裡同時會出現一個叫「家裡電腦」的機器人，把「官網改版」的兩個任務一個一個做完。按 `Ctrl+C` 停掉 runner。

到這裡第一部分就驗證完了：服務器跑起來了，瀏覽器和另一個網絡的電腦都連得上。

Windows 的 PowerShell 寫法：

```powershell
$env:PM_URL="http://服務器IP:4000"; $env:PM_TOKEN="test123"
$env:WORKER_ID="work-pc"; $env:WORKER_NAME="工作電腦"
npm run runner -- --dry-run
```

**注意**：第一部分走的是 http，token 在公網上是明文傳的，任何中途經過的人都能截到。只拿來驗證，`test123` 不要留著正式用。

---

# 第二部分：正式使用

## 8. 換成正式 token，設成系統服務

設成系統服務之後，服務器重啟會自動起來，程序崩潰也會在 3 秒內自動重啟。

先停掉第一部分用 `nohup` 啟動的那個：

```bash
pkill -f "tsx src/index.ts"
```

產生一個正式的管理員 token，連同其他設定寫進 `~/agent-pm/.env`（整段複製貼上）：

```bash
cd ~/agent-pm
T=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
cat > .env <<EOF
PM_TOKEN=$T
LEASE_MS=180000
HOST=127.0.0.1
EOF
chmod 600 .env
echo "管理員 token：$T"
```

最後一行印出的 48 個字就是**正式的管理員 token**，記在密碼管理器裡。忘了的話用 `cat ~/agent-pm/.env` 查。

`HOST=127.0.0.1` 讓協調服務只接受本機的連線，外面要經過第 9 步的 HTTPS 才能連進來。**所以做完這一步、第 9 步還沒做之前，`http://服務器IP:4000` 會暫時連不上，這是正常的。**

建系統服務（整段複製貼上，裡面的用戶名和路徑會自動填好）：

```bash
sudo tee /etc/systemd/system/agent-pm.service >/dev/null <<EOF
[Unit]
Description=agent-pm 協調服務
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$HOME/agent-pm
EnvironmentFile=$HOME/agent-pm/.env
ExecStart=$(which node) node_modules/tsx/dist/cli.mjs packages/server/src/index.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now agent-pm
systemctl is-active agent-pm
```

應該看到：最後一行是 `active`。再看一眼日誌：

```bash
sudo journalctl -u agent-pm -n 3 --no-pager
```

應該看到最後一行是：`[server] 資料庫 …/agent-pm/data/pm.db，租約 180000ms，已啟用 token 鑒權，只監聽 127.0.0.1`。

第一部分建的項目和數據都還在，因為用的是同一個資料庫。

## 9. 加上 HTTPS

### 9.1 準備一個名字

HTTPS 證書要發給一個名字，只有 IP 申請不到。

- **還沒有域名（只有 IP）**：用免費的 [sslip.io](https://sslip.io)，什麼都不用註冊。把公網 IP 的點換成橫線，後面加 `.sslip.io`。例如 IP 是 `34.12.56.78`，名字就是 `34-12-56-78.sslip.io`，它會自動解析到 `34.12.56.78`。
- **有域名**：到域名服務商加一條 A 記錄，例如 `pm.你的域名.com` 指向服務器的公網 IP。

下面用 `34-12-56-78.sslip.io` 舉例，請換成你的。

在你自己的電腦上確認這個名字指向服務器（不要用 `ping`，AWS 的安全組預設擋掉 ping）：

```bash
nslookup 34-12-56-78.sslip.io
```

應該看到：`Address:` 那一行是服務器的公網 IP。

### 9.2 改雲防火牆：開 80 和 443，關掉 4000

- **谷歌雲**：在這台服務器的編輯頁勾上「允許 HTTP 流量」和「允許 HTTPS 流量」，然後到「VPC 網絡 → 防火牆」刪掉第 2 步建的 4000 規則。
- **AWS**：在安全組的入站規則加 HTTP（80）和 HTTPS（443），來源 `0.0.0.0/0`，再刪掉 4000 那條。

80 端口是證書申請和把 http 自動轉到 https 用的，不能不開。

### 9.3 裝 Caddy

Caddy 是一個網頁服務器，在這裡做兩件事：自動向 Let's Encrypt 申請並續期 HTTPS 證書，再把收到的請求轉給本機的協調服務。

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

寫設定（把名字換成你的），然後重新載入：

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
34-12-56-78.sslip.io {
	reverse_proxy 127.0.0.1:4000
}
EOF
sudo systemctl reload caddy
```

等半分鐘，確認證書申請到了：

```bash
sudo journalctl -u caddy --no-pager | grep -i "certificate obtained"
```

應該看到：一行帶 `certificate obtained successfully` 的日誌。沒有的話看 `sudo journalctl -u caddy -n 30 --no-pager`，最常見的原因是 80 端口沒開，或者名字還沒指向服務器。

Caddy 的 apt 包已經把它設成系統服務，開機會自動起來。WebSocket（網頁的實時更新）和 MCP 不用另外設定，Caddy 會原樣轉發。

### 9.4 驗證

在你自己的電腦上：

```bash
curl -i https://34-12-56-78.sslip.io/api/state
curl https://34-12-56-78.sslip.io/api/me -H "authorization: Bearer <正式 token>"
```

應該看到：第一條的第一行是 `HTTP/2 401`；第二條返回管理員身分。瀏覽器打開 `https://34-12-56-78.sslip.io/?token=<正式 token>`，網址列有鎖頭，右上角顯示「實時連線」。

從現在起，所有地方都用 `https://34-12-56-78.sslip.io`，不再用 `http://IP:4000`。

## 10. 建用戶、建項目

只有你自己用的話，所有電腦都用管理員 token 就可以，這節可以跳過。有別人加入時，給每人建一個用戶：

```bash
PM=https://34-12-56-78.sslip.io
A="authorization: Bearer <正式 token>"
J="content-type: application/json"
curl -X POST $PM/api/users -H "$A" -H "$J" -d '{"id":"amy","name":"Amy"}'
```

應該看到：`{"user":{…},"token":"pm_…"}`。**這個 token 只顯示這一次**（服務器只存它的雜湊），把它交給 Amy。她的 token 丟了或外洩時，用同一個 `id` 再建一次：會發一個新 token，舊的馬上失效，她在各項目的角色不變。

項目通常由 PM agent 透過 MCP 建（見第 12 節），也可以用命令建，再把人加進去：

```bash
curl -X POST $PM/api/projects -H "$A" -H "$J" -d @docs/examples/multi-site.json
curl -X PUT $PM/api/projects/site/members/amy -H "$A" -H "$J" -d '{"role":"contributor"}'
```

角色有三種：`manager`（負責人，可 review、改設定、管成員）、`contributor`（參與者，她的 worker 可以領任務）、`viewer`（觀察者，只能看）。

## 11. 正式連接 worker 電腦

每台要幹活的電腦都做一次。這台電腦需要：

- **Node 20 以上**和 **git**。
- **Claude Code**，並且已經登入（`claude` 命令能用）。
- **共用工作倉庫的推送權限**。`projects_site_v01` 是私有倉庫，這台電腦的 git 要能 clone 和 push 它。最簡單的是裝 GitHub CLI 後執行一次 `gh auth login`。

```bash
git clone https://github.com/ali-sx-org-free/projects_site_v01 ../projects_site_v01

PM_URL=https://34-12-56-78.sslip.io PM_TOKEN=<這個人的 token> \
WORKER_ID=home-pc WORKER_NAME=家裡電腦 WORKER_LABELS=code \
WORK_DIR=../projects_site_v01 GIT_SYNC=1 \
  npm run runner
```

- `WORKER_ID` 每台電腦要不一樣，而且每次啟動都用同一個（斷線後回來時靠它認出是誰）。
- `WORKER_LABELS` 是這台電腦的能力標籤，只會領到它具備全部標籤的任務。例如有 GPU 的電腦寫 `code,gpu`。
- `GIT_SYNC=1`：領到任務就切到任務分支，存檢查點和交接時推到 GitHub。別的電腦接手時從這個分支接著做。
- **正式項目建好之後就不要再跑 `--dry-run` 了**，它會把真的任務假裝做完並交付。

Windows 的 PowerShell 寫法：

```powershell
$env:PM_URL="https://34-12-56-78.sslip.io"; $env:PM_TOKEN="<這個人的 token>"
$env:WORKER_ID="work-pc"; $env:WORKER_NAME="工作電腦"; $env:WORKER_LABELS="code"
$env:WORK_DIR="..\projects_site_v01"; $env:GIT_SYNC="1"
npm run runner
```

runner 要一直開著。服務器重啟或網絡斷掉時，它只會顯示「出錯，稍後重試」並自己重連。

### 不跑 runner：用 Skill 接入

不想在 worker 電腦上 clone 原型、裝 Node，可以讓 Claude Code 自己透過 MCP 領任務。這台電腦只需要 Claude Code、git 和工作倉庫的推送權限：

```bash
git clone https://github.com/ali-sx-org-free/projects_site_v01 ~/code/projects_site_v01

claude mcp add --transport http -s user agent-pm https://34-12-56-78.sslip.io/mcp \
  --header "Authorization: Bearer <這個人的 token>"

mkdir -p ~/.claude/skills/agent-pm-worker
curl -fsSL https://raw.githubusercontent.com/ali-sx-org-free/project_manager_and_worker/main/skills/agent-pm-worker/SKILL.md \
  -o ~/.claude/skills/agent-pm-worker/SKILL.md
```

再在 `~/.claude/settings.json` 的 `permissions.allow` 裡加上 `"mcp__agent-pm"`，然後：

```bash
cd ~/code/projects_site_v01 && claude
```

在 Claude Code 裡輸入 `/agent-pm-worker worker_id=home-pc-cc labels=code`。`worker_id` 的規則和 runner 的 `WORKER_ID` 一樣：每台電腦不一樣、每次都用同一個。和 runner 不要用同一個 id。

Windows 的寫法、每個參數的意思、和 runner 的差別，見 [TUTORIAL.md 的 D5 和 D7](TUTORIAL.md#d5-讓-agent-當-workerskill不用-runner)。

## 12. 讓 Claude Code 當 PM

在你要當 PM 的那台電腦上：

```bash
claude mcp add --transport http agent-pm https://34-12-56-78.sslip.io/mcp \
  --header "Authorization: Bearer <正式 token>"
```

之後在 Claude Code 裡就能用 `create_project`、`list_projects`、`review_task` 等 16 個工具。提示詞的寫法見 [TUTORIAL.md 的路線 D](TUTORIAL.md#路線-d接真實-agentmcp)，把裡面的 `http://localhost:4000` 換成你的地址就行。

## 13. 日常維護

下面的命令都在服務器上執行。

### 看日誌

```bash
sudo journalctl -u agent-pm -f        # 協調服務，每個事件一行，Ctrl+C 退出
sudo journalctl -u caddy -n 50 --no-pager   # 證書和連線問題看這裡
```

### 重啟、停止

```bash
sudo systemctl restart agent-pm
sudo systemctl stop agent-pm
```

### 更新到最新代碼

```bash
cd ~/agent-pm
git pull
npm install
npm run build
sudo systemctl restart agent-pm
```

資料庫在 `data/` 目錄裡，更新不會動它。重啟時協調服務會停幾秒，worker 會自己重連。

### 備份資料庫

整個系統的狀態只在 `data/pm.db` 這一個檔案裡（任務、進度、檢查點、用戶和 token 雜湊）。代碼在 GitHub 上，不用另外備份。

手動備份一次（服務不用停）：

```bash
cd ~/agent-pm && node scripts/backup-db.mjs
```

應該看到：`已備份到 /home/你的用戶名/agent-pm/data/backups/pm-20261116-030000Z.db（72 KB）`。預設只保留最近 14 份，更早的自動刪掉。

每天凌晨 3 點（服務器時間，雲服務器預設是 UTC）自動備份：

```bash
sudo apt-get install -y cron
(crontab -l 2>/dev/null; echo "0 3 * * * cd $HOME/agent-pm && $(which node) scripts/backup-db.mjs >> data/backup.log 2>&1") | crontab -
crontab -l
```

應該看到：`crontab -l` 印出剛加的那一行。

這些備份和資料庫在同一塊硬盤上，硬盤壞了會一起丟。建議在雲控制台開啟硬盤的自動快照（谷歌雲叫「快照排程」，AWS 叫「Data Lifecycle Manager」）。

### 從備份恢復

```bash
sudo systemctl stop agent-pm
cd ~/agent-pm
cp data/backups/pm-20261116-030000Z.db data/pm.db
rm -f data/pm.db-wal data/pm.db-shm
sudo systemctl start agent-pm
```

恢復後，備份時間點之後的變化（新任務、新檢查點）都會消失。那段時間裡正在執行的任務，runner 會在下一次心跳時發現，停下來重新領取。

### 換管理員 token

改 `~/agent-pm/.env` 裡的 `PM_TOKEN`，然後 `sudo systemctl restart agent-pm`。所有用管理員 token 的 runner 和 MCP 都要換成新的。

### 以後換成正式域名

從 sslip.io 換到正式域名時，資料庫不受影響。

1. 在域名服務商加 A 記錄，指向**同一個**公網 IP，用 `nslookup` 確認已經生效。
2. 在服務器上把 `/etc/caddy/Caddyfile` 第一行的名字換成新域名，然後 `sudo systemctl reload caddy`。想新舊地址同時能用一段時間，第一行寫成 `pm.你的域名.com, 34-12-56-78.sslip.io {`。
3. 把用到舊地址的地方改成新地址：每台 worker 的 `PM_URL`（改完重啟 runner）、MCP 設定（`claude mcp remove agent-pm` 後再照第 12 節加一次）、瀏覽器書籤。

---

## 我驗證過什麼，沒驗證過什麼

**驗證過**（在 Debian 12 上，用的是這份教程裡的命令）：

- 第 3 步裝 Node 22 的命令，`node -v` 印出 `v22.23.5`。
- 沒有編譯工具時 `npm install` 報 `not found: make`；有編譯工具時 `npm install` 和 `npm run build` 都成功。
- 第 5 步啟動後，關掉那個終端服務仍在跑；`pkill -f "tsx src/index.ts"` 能停掉它。
- 第 6、7 步：瀏覽器顯示「實時連線」，不帶 token 時返回 401；另一台機器上的 runner 連進來，領取並做完兩個任務，開了 `GIT_SYNC=1` 時任務分支推到了 git 倉庫。
- 第 8 步：系統服務啟動成功並設成開機啟動；`HOST=127.0.0.1` 時 4000 端口從外面連不到；把進程強殺後 3 秒內自動重啟。
- 第 9 步的 Caddyfile 寫法：HTTPS 轉發正常，http 自動轉到 https，網頁自動改用加密的 WebSocket（`wss://`）。
- 第 13 步：備份腳本在服務運行中備份、只保留指定份數；照「從備份恢復」的步驟恢復後服務正常。

**沒驗證過**：

- **`apt-get` 的那幾行**（第 3 步的 `apt-get install`、第 9.3 節裝 Caddy、第 13 步裝 cron 和加定時備份）。我的測試環境連不上 Debian 和 Caddy 的軟件源，所以測試時用的是已經裝好這些工具的 Debian 12 環境。這幾行都是官方文檔的標準寫法。
- **Let's Encrypt 真證書和 sslip.io**。測試時 Caddy 用的是給 `localhost` 的自簽證書。
- **谷歌雲、AWS 控制台裡的操作**（防火牆、靜態 IP、SSH 登入）和服務器重啟後自動起來。
- **Windows 上的 runner**，以及**真實的 Claude Code 透過公網連 MCP**。第 11 節的 Skill 接法我只在本機對著 `http://localhost` 的協調服務跑過真實的 Claude Code（見 TUTORIAL.md 的 D8），沒有經過 HTTPS 和公網。

另外，正式使用前要知道：token 不會過期；網頁的 `?token=` 會留在瀏覽器歷史裡。自己和信任的人用還行，人多了之後要再加強。
