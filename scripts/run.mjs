#!/usr/bin/env node
/**
 * 一條命令啟動多個進程，日誌加前綴。
 *   node scripts/run.mjs demo   協調服務（示範資料庫、短租約）+ 模擬器，網頁由服務直接提供
 *   node scripts/run.mjs dev    協調服務 + 模擬器 + vite 開發服務器（改前端即時刷新）
 *   加 --no-sim 不啟動模擬器
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'demo';
const noSim = process.argv.includes('--no-sim');
const port = process.env.PORT ?? '4000';

const dbFile = path.join(root, 'data/demo.db');
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });

const env = {
  ...process.env,
  PORT: port,
  PM_DB: dbFile,
  LEASE_MS: process.env.LEASE_MS ?? '6000',
  PM_URL: `http://localhost:${port}`,
};

// 直接用 node 啟動 tsx / vite，不經過 npm，這樣 Ctrl+C 時子進程能乾淨退出
const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs');
const vite = path.join(root, 'node_modules/vite/bin/vite.js');
const children = [];
function start(name, args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (buf) =>
    String(buf)
      .split('\n')
      .filter((l) => l.trim())
      .forEach((l) => console.log(`${name.padEnd(6)}| ${l}`));
  child.stdout.on('data', prefix);
  child.stderr.on('data', prefix);
  child.on('exit', (code) => {
    if (code) console.log(`${name} 退出，code ${code}`);
  });
  children.push(child);
}

start('server', [tsx, 'packages/server/src/index.ts']);
if (!noSim) start('sim', [tsx, 'packages/simulator/src/index.ts']);
if (mode === 'dev') start('web', [vite], path.join(root, 'packages/web'));

console.log(
  mode === 'dev'
    ? `\n  打開 http://localhost:5173 看 3D 視窗（API 在 http://localhost:${port}）\n`
    : `\n  打開 http://localhost:${port} 看 3D 視窗\n`,
);

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
