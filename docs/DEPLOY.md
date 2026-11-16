# 部署教程：把 PM 協調服務放到雲服務器上

這份教程把協調服務（PM 的大腦：任務、進度、檢查點、用戶和權限都在它那裡）部署到一台租來的谷歌雲或 AWS 服務器上，讓工作電腦、家裡電腦這些在不同網絡的 worker 都能透過 `https://你的域名` 連進來。

部署好之後是這樣分工的：

| 在哪裡 | 跑什麼 | 存什麼 |
| --- | --- | --- |
| 雲服務器 | 協調服務（容器 `pm`）和 HTTPS 反向代理（容器 `caddy`） | 資料庫 `data/pm.db` 和它的備份 |
| 每台 worker 電腦 | runner 和 Claude Code | 共用工作倉庫（例如 `projects_site_v01`）的 clone |
| GitHub | 什麼都不跑 | 代碼：每個任務一個 `project/<項目>/<任務>-<編號>` 分支 |
| 你的瀏覽器 | 3D 視窗 | 什麼都不存 |

worker 和瀏覽器都不會直接碰資料庫，它們只跟 `https://你的域名` 說話。git 推送也不經過服務器，是每台 worker 電腦直接推到 GitHub。

每一步都標了「應該看到」。最後一節寫了哪些步驟我實際跑過、哪些沒有。

---

## 0. 先選作業系統

**如果還能選，請選 Ubuntu 24.04 LTS。** CentOS 7 也能用，只是麻煩一些，原因有三個：

1. **CentOS 7 在 2024 年 6 月 30 日停止維護**，之後沒有安全更新。這台服務器要暴露在公網上，這一點最要緊。
2. **它的系統庫太舊（glibc 2.17），跑不了 Node 18 以後的版本。** 這個原型需要 Node 20 以上。我在 CentOS 7 上試過官方的 Node 22，啟動就報錯：

   ```
   node: /lib64/libstdc++.so.6: version `GLIBCXX_3.4.21' not found (required by node)
   ```

3. **官方的軟件源已經下線**，`yum` 直接用會報 `Cannot find a valid baseurl for repo: base/7/x86_64`，要先改成存檔源 `vault.centos.org`。

這份教程的做法是**把協調服務放進 Docker 容器裡跑**。容器裡帶著自己的 Node 22 和系統庫，所以不受宿主機系統版本的限制。兩種系統只有第 2 步「安裝 Docker」不一樣，其他步驟完全相同。

---

## 1. 準備服務器、防火牆和域名

### 1.1 服務器規格

1 個 vCPU、**2 GB 內存**、20 GB 硬盤就夠了。例如谷歌雲的 `e2-small`，或 AWS 的 `t3.small`。

第一次建置映像時要安裝依賴、打包網頁，1 GB 內存的機器可能會不夠。如果只能用 1 GB，先照第 2.3 節加一個交換分區。

### 1.2 雲防火牆：只開 22、80、443

瀏覽器和 worker 只需要 443（HTTPS）。80 是給證書申請和把 http 自動轉到 https 用的。**不要開 4000**，協調服務只讓同一台機器上的 Caddy 連。

- **谷歌雲**：建 VM 時勾上「允許 HTTP 流量」和「允許 HTTPS 流量」。已經建好的，到「VPC 網絡 → 防火牆」加一條規則：入站、目標是這台 VM、來源 `0.0.0.0/0`、TCP `80,443`。
- **AWS**：在這台 EC2 的「安全組 → 入站規則」加兩條：HTTP（80）和 HTTPS（443），來源 `0.0.0.0/0`。SSH（22）建議只對你自己的 IP 開。

### 1.3 域名（只有 IP 也行）

Caddy 會自動向 Let's Encrypt 申請 HTTPS 證書，這需要一個指向服務器公網 IP 的**域名**，只有 IP 申請不到。`PM_DOMAIN` 不能省略也不能留空，留空的話第 4 步啟動時會直接報錯：

```
required variable PM_DOMAIN is missing a value: 請在 .env 裡設定 PM_DOMAIN
```

**第一步，不管有沒有域名都先做：把公網 IP 固定下來。** 谷歌雲和 AWS 的公網 IP 預設在服務器停機再開機後會變，IP 一變，下面兩種做法的地址都會失效。

- 谷歌雲：「VPC 網絡 → IP 地址」，找到這台 VM 的外部 IP，點「升級為靜態」（或「保留」）。
- AWS：「EC2 → 彈性 IP」，分配一個新的彈性 IP，再把它關聯到這台 EC2。關聯之後服務器的公網 IP 就換成這個彈性 IP 了，以它為準。

然後按你的情況選一種：

#### 情況 A：現在只有 IP，沒有域名

用免費的 [sslip.io](https://sslip.io)，什麼都不用註冊。它的規則是：任何 `<IP>.sslip.io` 形式的名字，都會自動解析到名字裡寫的那個 IP。所以：

1. 把公網 IP 的點換成橫線。
2. 後面加上 `.sslip.io`。

| 公網 IP | `PM_DOMAIN` 填 | 之後所有人用的地址 |
| --- | --- | --- |
| `34.12.56.78` | `34-12-56-78.sslip.io` | `https://34-12-56-78.sslip.io` |
| `3.112.45.6` | `3-112-45-6.sslip.io` | `https://3-112-45-6.sslip.io` |

**這份教程後面所有寫著 `pm.你的域名.com` 的地方，都換成這個名字。**

以後有了正式域名，照 [9.6 節](#96-以後換成正式域名)改一行設定就能換過去，數據不受影響。

#### 情況 B：已經有域名

到你的域名服務商加一條 A 記錄，例如主機名 `pm`、值是服務器的公網 IP，得到 `pm.你的域名.com`。

#### 確認名字已經指向服務器

在你自己的電腦上執行（換成你的名字）：

```bash
nslookup 34-12-56-78.sslip.io
```

應該看到：`Address:` 那一行是服務器的公網 IP。（不要用 `ping` 確認，AWS 的安全組預設擋掉 ping，會誤以為不通。）

**為什麼不直接用 `http://IP:4000`？** 技術上可以，但那樣 token 會以明文在公網上傳，任何中途經過的人都能截到、冒充你。sslip.io 讓你在沒有域名時也能用上 HTTPS。

---

## 2. 安裝 Docker

用 SSH 登入服務器，選對應系統的一節做。

### 2.1 Ubuntu 24.04

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo apt-get install -y git
docker compose version
```

應該看到：`Docker Compose version v2.…`。

### 2.2 CentOS 7

```bash
# 1. 官方源已下線，改用存檔源
sudo sed -i -e 's|^mirrorlist=|#mirrorlist=|g' \
  -e 's|^#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g' /etc/yum.repos.d/CentOS-*.repo
sudo yum clean all && sudo yum makecache

# 2. Docker 官方的 CentOS 7 源（Docker 給 CentOS 7 的最後一版是 26.1.4，夠用）
sudo yum install -y yum-utils git
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
docker compose version
```

應該看到：`Docker Compose version v2.27.1`。

如果系統開著 firewalld（`sudo firewall-cmd --state` 顯示 `running`），也放行 80 和 443：

```bash
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

SELinux 不用關。`docker-compose.yml` 裡掛載目錄時已經加了 `:Z`，開著 SELinux 也能寫入。

### 2.3 （只有 1 GB 內存時）加 2 GB 交換分區

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 3. 取代碼、填設定

```bash
sudo git clone https://github.com/ali-sx-org-free/project_manager_and_worker /opt/agent-pm
cd /opt/agent-pm
sudo cp .env.example .env
openssl rand -hex 24
```

最後一條命令會印出一串 48 個字的隨機字串，這就是**管理員 token**。把它記在密碼管理器裡，然後編輯 `.env`：

```bash
sudo vi .env
```

填上三項：

```bash
PM_DOMAIN=pm.你的域名.com        # 只有 IP 時填 34-12-56-78.sslip.io 這種寫法（見 1.3）；不要加 https://，不能留空
PM_TOKEN=剛才印出來的那串字
LEASE_MS=180000                 # worker 斷線 3 分鐘後，它的任務交給別人接手
```

例如公網 IP 是 `34.12.56.78`、還沒有域名，第一行就寫 `PM_DOMAIN=34-12-56-78.sslip.io`。

`.env` 不會被提交到 git（已經寫在 `.gitignore` 裡）。

---

## 4. 啟動

```bash
cd /opt/agent-pm
sudo docker compose up -d --build
```

第一次要下載映像、安裝依賴、打包網頁，大約 3 到 5 分鐘。之後確認兩個容器都在跑：

```bash
sudo docker compose ps
sudo docker compose logs pm
```

應該看到：`pm` 和 `caddy` 兩行，狀態是 `Up`，`pm` 過一會兒會顯示 `(healthy)`。日誌最後一行是：

```
[server] 資料庫 /data/pm.db，租約 180000ms，已啟用 token 鑒權
```

（日誌裡寫的 `http://localhost:4000` 是容器內部的地址，外面用的是 `https://你的域名`。）

`docker compose` 設了 `restart: unless-stopped`，Docker 又設成了開機自動啟動，所以服務器重啟後兩個容器會自己起來，不用再寫 systemd 服務。

---

## 5. 確認外面連得到

在**你自己的電腦上**執行（把域名和 token 換成你的）：

```bash
curl -i https://pm.你的域名.com/api/state
curl https://pm.你的域名.com/api/me -H "authorization: Bearer <管理員 token>"
```

應該看到：

- 第一條的第一行是 `HTTP/2 401`。沒有 token 連讀都不行，這是對的。
- 第二條返回 `{"user":{"id":"admin","name":"PM","admin":true,…},"auth":true}`。

再用瀏覽器打開 `https://pm.你的域名.com/?token=<管理員 token>`。

應該看到：網址列有鎖頭（證書有效），右上角顯示「實時連線」，場景是空的（還沒有項目）。

如果第一條命令卡住或連不上，多半是雲防火牆沒開 443，或域名還沒指向服務器。如果報證書錯誤，看 `sudo docker compose logs caddy`，裡面會寫申請證書失敗的原因，最常見的是 80 端口沒開。

---

## 6. 建用戶、建項目

下面的命令在哪台電腦上執行都可以。先設兩個變量：

```bash
PM=https://pm.你的域名.com
A="authorization: Bearer <管理員 token>"
J="content-type: application/json"
```

### 6.1 給每個人建一個用戶

只有你自己用的話，可以跳過這步，所有電腦都用管理員 token。有別人加入時，給每人建一個：

```bash
curl -X POST $PM/api/users -H "$A" -H "$J" -d '{"id":"amy","name":"Amy"}'
```

應該看到：`{"user":{…},"token":"pm_…"}`。**這個 token 只顯示這一次**（服務器只存它的雜湊），把它交給 Amy。

### 6.2 建項目、加成員

項目通常由 PM agent 透過 MCP 的 `create_project` 建（見第 8 節）。也可以用命令建，格式見 `docs/examples/multi-site.json`：

```bash
curl -X POST $PM/api/projects -H "$A" -H "$J" -d @docs/examples/multi-site.json
curl -X PUT $PM/api/projects/site/members/amy -H "$A" -H "$J" -d '{"role":"contributor"}'
```

角色有三種：`manager`（負責人，可 review、改設定、管成員）、`contributor`（參與者，他的 worker 可以領任務）、`viewer`（觀察者，只能看）。管理員不用加，什麼都看得到。

---

## 7. 連接 worker 電腦

每台要幹活的電腦（工作電腦、家裡電腦）都做一次。

### 7.1 準備

這台電腦需要：

- **Node 20 以上**和 **git**。
- **Claude Code**，並且已經登入（`claude` 命令能用）。
- **共用工作倉庫的推送權限**。`projects_site_v01` 是私有倉庫，這台電腦的 git 要能 clone 和 push 它。最簡單的是裝 GitHub CLI 後執行一次 `gh auth login`。

```bash
git clone https://github.com/ali-sx-org-free/project_manager_and_worker agent-pm
cd agent-pm && npm install
git clone https://github.com/ali-sx-org-free/projects_site_v01 ../projects_site_v01
```

### 7.2 先用 dry-run 確認連得通

dry-run 不呼叫 Claude，也不碰 git，只確認這台電腦連得上服務器、token 有效：

```bash
PM_URL=https://pm.你的域名.com PM_TOKEN=<這個人的 token> WORKER_ID=home-pc WORKER_NAME=家裡電腦 \
  npm run runner -- --dry-run
```

應該看到：

```
[runner home-pc] 連接 https://pm.你的域名.com，標籤 []，dry-run
```

下一行是「身分：…」，寫著這個 token 是誰。網頁上會多出一個叫「家裡電腦」的機器人。如果有可領的任務，它會假裝做完並交付，所以**正式項目建好之後就不要再跑 dry-run 了**。確認完按 `Ctrl+C`。

### 7.3 正式啟動

```bash
PM_URL=https://pm.你的域名.com PM_TOKEN=<這個人的 token> \
WORKER_ID=home-pc WORKER_NAME=家裡電腦 WORKER_LABELS=code \
WORK_DIR=../projects_site_v01 GIT_SYNC=1 \
  npm run runner
```

- `WORKER_ID` 每台電腦要不一樣，而且每次啟動都用同一個（斷線後回來時靠它認出是誰）。
- `WORKER_LABELS` 是這台電腦的能力標籤，只會領到它具備全部標籤的任務。例如有 GPU 的電腦寫 `code,gpu`。
- `GIT_SYNC=1`：領到任務就切到任務分支，存檢查點和交接時推到 GitHub。別的電腦接手時從這個分支接著做。

Windows 的 PowerShell 寫法：

```powershell
$env:PM_URL="https://pm.你的域名.com"; $env:PM_TOKEN="<這個人的 token>"
$env:WORKER_ID="work-pc"; $env:WORKER_NAME="工作電腦"; $env:WORKER_LABELS="code"
$env:WORK_DIR="..\projects_site_v01"; $env:GIT_SYNC="1"
npm run runner
```

runner 要一直開著。服務器重啟或網絡斷掉時，它只會顯示「出錯，稍後重試」並自己重連，不用管它。

---

## 8. 讓 Claude Code 當 PM

PM agent 透過 MCP 拆解需求、建項目、review。在你要當 PM 的那台電腦上：

```bash
claude mcp add --transport http agent-pm https://pm.你的域名.com/mcp \
  --header "Authorization: Bearer <管理員 token>"
```

之後在 Claude Code 裡就能用 `create_project`、`list_projects`、`review_task` 等 16 個工具。提示詞的寫法見 [TUTORIAL.md 的路線 D](TUTORIAL.md#路線-d接真實-agent)，只要把裡面的 `http://localhost:4000` 換成你的域名。

---

## 9. 日常維護

所有命令都在服務器的 `/opt/agent-pm` 目錄下執行。

### 9.1 看日誌

```bash
sudo docker compose logs -f pm       # 每個事件一行，Ctrl+C 退出
sudo docker compose logs caddy       # 證書和連線問題看這裡
```

### 9.2 更新到最新代碼

```bash
sudo git pull
sudo docker compose up -d --build
```

資料庫在 `data/` 目錄裡，更新不會動它。更新時協調服務會停幾秒，worker 會自己重連。

### 9.3 備份資料庫

整個系統的狀態只在 `data/pm.db` 這一個檔案裡（任務、進度、檢查點、用戶和 token 雜湊）。代碼在 GitHub 上，不用另外備份。

手動備份一次（服務不用停）：

```bash
sudo docker compose exec -T pm node scripts/backup-db.mjs
```

應該看到：`已備份到 /data/backups/pm-20261116-030000Z.db（96 KB）`。這個檔案在服務器上的位置是 `/opt/agent-pm/data/backups/`。預設只保留最近 14 份，更早的會自動刪掉。

每天凌晨 3 點自動備份：

```bash
sudo crontab -e
```

加一行：

```
0 3 * * * cd /opt/agent-pm && docker compose exec -T pm node scripts/backup-db.mjs >> /opt/agent-pm/data/backup.log 2>&1
```

這些備份和資料庫在同一塊硬盤上，硬盤壞了會一起丟。建議再定期把 `data/backups/` 複製到別處，或者在雲控制台開啟硬盤的自動快照（谷歌雲叫「快照排程」，AWS 叫「Data Lifecycle Manager」）。

### 9.4 從備份恢復

```bash
sudo docker compose stop pm
sudo cp data/backups/pm-20261116-030000Z.db data/pm.db
sudo rm -f data/pm.db-wal data/pm.db-shm
sudo docker compose start pm
```

恢復後，備份時間點之後的變化（新任務、新檢查點）都會消失。那段時間裡正在執行的任務，runner 會在下一次心跳時發現租約不在了，停下來重新領取。

### 9.5 換管理員 token

改 `.env` 裡的 `PM_TOKEN`，然後執行 `sudo docker compose up -d`。所有用管理員 token 的 runner 和 MCP 都要換成新的。

普通用戶的 token 丟了或外洩時，用同一個 `id` 再建一次（6.1 的命令）。會發一個新 token，舊的馬上失效，他在各項目的角色不變。

### 9.6 以後換成正式域名

從 sslip.io 換到正式域名（或者換一個域名）時，資料庫不受影響，項目、任務、用戶和 token 都照舊。

1. 在域名服務商加 A 記錄，指向**同一個**公網 IP。用 `nslookup pm.你的域名.com` 確認已經生效。
2. 在服務器上改 `.env` 的第一行，例如 `PM_DOMAIN=34-12-56-78.sslip.io` 改成 `PM_DOMAIN=pm.你的域名.com`：

   ```bash
   cd /opt/agent-pm
   sudo vi .env
   sudo docker compose up -d
   sudo docker compose logs caddy | grep -i certificate
   ```

   `up -d` 會發現設定變了，只重建 `caddy` 容器，`pm` 不動。Caddy 會給新域名申請證書，日誌裡出現 `certificate obtained successfully` 就好了。
3. 把用到舊地址的地方都改成新地址：
   - 每台 worker 電腦：runner 的 `PM_URL`（改完重啟 runner）。
   - 當 PM 的那台電腦的 MCP 設定：

     ```bash
     claude mcp remove agent-pm
     claude mcp add --transport http agent-pm https://pm.你的域名.com/mcp \
       --header "Authorization: Bearer <管理員 token>"
     ```

   - 瀏覽器的書籤。

換過去之後舊的 sslip.io 地址就不能用了。想新舊地址同時能用一段時間，可以把 `deploy/Caddyfile` 第一行的 `{$PM_DOMAIN}` 改成 `{$PM_DOMAIN}, 34-12-56-78.sslip.io`，再執行 `sudo docker compose up -d --force-recreate caddy`。

---

## 10. 我驗證過什麼，沒驗證過什麼

**驗證過**（在一台 Ubuntu 24.04 上，用 Docker 29 和這份 `docker-compose.yml`）：

- 建置映像、`docker compose up` 啟動兩個容器，`pm` 的健康檢查變成 `healthy`。
- 透過 Caddy 的 HTTPS：不帶 token 返回 401，帶 token 返回管理員身分；http 自動轉到 https；4000 端口從外面連不到。
- 網頁經過 HTTPS 打開，自動改用 `wss://` 連 WebSocket，顯示「實時連線」；token 錯誤時顯示「token 無效」。
- MCP 經過 HTTPS 列出 16 個工具。
- 一台 runner 用普通用戶的 token、`PM_URL=https://…`、`GIT_SYNC=1` 連進來，領取並做完兩個任務，任務分支 `project/site/…` 推到了 git 倉庫。
- 重啟容器後數據都在，用戶 token 仍然有效；用同一個 `id` 重建用戶後，舊 token 返回 401，新 token 能用，項目角色還在。
- 備份腳本在服務運行中備份、只保留指定份數；照 9.4 恢復後回到備份時的狀態。
- `PM_DOMAIN` 留空時啟動報錯（1.3 裡的那段就是實際輸出）；改 `PM_DOMAIN` 後 `docker compose up -d` 只重建 `caddy`，`pm` 照常運行；9.6 裡新舊兩個地址並存的寫法 Caddy 能正確解析。
- CentOS 7 上：官方 Node 22 無法執行（上面的報錯就是實際輸出）；沒改源之前 `yum` 報錯；Docker 的 CentOS 7 源仍然可以用，裡面有 `docker-ce 26.1.4` 和 `docker-compose-plugin 2.27.1`。

**沒驗證過**：

- **在真正的 CentOS 7 服務器上從頭走一遍。** 我的測試環境連不上 `vault.centos.org`，所以第 2.2 節改源之後的 `yum install` 沒有實際跑過。我也沒有在 CentOS 7 的 3.10 版內核上跑過容器，Node 22 官方沒有把這麼舊的內核列為支持平台。
- **Let's Encrypt 真證書和 sslip.io。** 測試時用的是 Caddy 給 `localhost` 自簽的證書，沒有用真的公網域名或 sslip.io 的名字申請過。我的測試環境也查不了外部 DNS，所以 `nslookup` 那一步沒有實際跑過。
- **谷歌雲、AWS 的防火牆設定、靜態 IP 和服務器重啟後自動起來。**
- **Windows 上的 runner。**
- **真實的 Claude Code 透過公網連 MCP。**

另外兩件正式使用前要知道的事：token 不會過期；網頁的 `?token=` 會留在瀏覽器歷史裡。自己和信任的人用還行，人多了之後要再加強。
