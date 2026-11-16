# agent-pm 協調服務（REST + WebSocket + MCP + 網頁）。
# 程式和它需要的系統庫都在容器裡，所以宿主機是 CentOS 7 這種 glibc 太舊、裝不了 Node 22 的系統也能跑。
# 一般用 docker compose 啟動（見 docker-compose.yml 和 docs/DEPLOY.md）。

ARG NODE_IMAGE=node:22-bookworm

# ── 建置：安裝依賴、打包網頁 ──
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# better-sqlite3 優先下載預編譯檔；下載不到時用這個映像自帶的編譯器從源碼編譯，頭文件用映像裡現成的
ENV npm_config_nodedir=/usr/local
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/runner/package.json packages/runner/
COPY packages/simulator/package.json packages/simulator/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ── 執行 ──
FROM node:22-bookworm-slim
WORKDIR /app
ENV PORT=4000 \
    PM_DB=/data/pm.db \
    LEASE_MS=180000
COPY --from=build /app /app
VOLUME /data
EXPOSE 4000
# 開了 token 時 /api/me 不帶 token 會回 401，能回應就算健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4000/api/me').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "node_modules/tsx/dist/cli.mjs", "packages/server/src/index.ts"]
