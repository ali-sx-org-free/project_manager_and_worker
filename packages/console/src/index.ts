#!/usr/bin/env node
/**
 * 本機管理端。在原型倉庫裡：
 *   npm run console                       連 ~/.agent-pm/config.json 裡設定的 hub（apm setup 寫的）
 *   npm run console -- --hub owner/repo   指定 hub
 *   npm run console -- --fake             不連 GitHub，用記憶體裡的假 hub 和假 worker 演示
 * 然後打開 http://localhost:4000
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub, loadConfig, resolveToken } from '@agent-pm/github';
import { startFakeHub } from './fake.ts';
import { ConsoleServer } from './server.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const port = Number(opt('port') ?? process.env.PORT ?? 4000);
const webDir = opt('web') ?? join(root, 'packages/web/dist');
let hub: Hub;
let interval = Number(opt('interval') ?? 15) * 1000;

if (flag('fake')) {
  const fake = await startFakeHub({ sim: !flag('no-sim'), examplesDir: join(root, 'docs/examples') });
  hub = fake.hub;
  interval = Number(opt('interval') ?? 2) * 1000;
  console.log('[console] 演示模式：記憶體裡的假 hub（demo/agent-pm-hub），三個假 worker 和一個假 PM 正在幹活，租約 1 分鐘');
} else {
  const cfg = loadConfig();
  const name = opt('hub') ?? process.env.APM_HUB ?? cfg.hub;
  if (!name) {
    console.error('還沒設定 hub：npm run console -- --hub owner/repo（或先跑 apm setup --hub owner/repo）。只想看看長什麼樣：npm run console -- --fake');
    process.exit(1);
  }
  const token = resolveToken();
  if (!token) {
    console.error('沒有 GitHub 登入：先執行 gh auth login');
    process.exit(1);
  }
  hub = new Hub({ repo: name, token, etags: true, apiBase: process.env.APM_API_BASE || undefined, gitRemote: process.env.APM_GIT_REMOTE || undefined });
}

if (!existsSync(join(webDir, 'index.html'))) console.log('[console] 網頁還沒構建，先執行 npm run build（不然打開只會看到一行字）');
const server = new ConsoleServer({ hub, port, webDir, intervalMs: interval });
let url: string;
try {
  url = await server.start();
} catch (err) {
  console.error(`啟動失敗：${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
console.log(`[console] hub ${hub.name}，每 ${interval / 1000} 秒同步一次`);
console.log(`[console] 打開 ${url}`);
if (flag('open')) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}
