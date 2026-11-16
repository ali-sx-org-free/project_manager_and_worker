import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './app.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

const port = Number(process.env.PORT ?? 4000);
// 預設在所有網卡上監聽；前面有 Caddy 這類反向代理時設成 127.0.0.1，外面就只能經過代理連進來
const host = process.env.HOST || undefined;
const leaseMs = Number(process.env.LEASE_MS ?? 30 * 60 * 1000);
const dbFile = process.env.PM_DB ?? path.join(root, 'data/pm.db');
const token = process.env.PM_TOKEN || undefined;

const { server, engine } = createServer({
  dbFile,
  leaseMs,
  token,
  webDir: process.env.WEB_DIR ?? path.join(root, 'packages/web/dist'),
});

engine.on((e) => {
  if (e.type !== 'heartbeat') console.log(`[event] ${e.type.padEnd(17)} ${e.message}`);
});

server.listen(port, host, () => {
  console.log(`[server] 協調服務  http://localhost:${port}`);
  console.log(`[server] REST      http://localhost:${port}/api/state`);
  console.log(`[server] WebSocket ws://localhost:${port}/ws`);
  console.log(`[server] MCP       http://localhost:${port}/mcp`);
  console.log(`[server] 資料庫 ${dbFile}，租約 ${leaseMs}ms${token ? '，已啟用 token 鑒權' : ''}${host ? `，只監聽 ${host}` : ''}`);
});
