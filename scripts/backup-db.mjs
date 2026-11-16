#!/usr/bin/env node
/**
 * 備份協調服務的資料庫。服務不用停：用的是 SQLite 的線上備份，備出來的是某一時刻完整一致的副本。
 *
 *   node scripts/backup-db.mjs [資料庫路徑] [備份目錄] [保留份數]
 *
 * 預設：資料庫是 $PM_DB（沒設就是 data/pm.db），備份放在資料庫旁邊的 backups/ 目錄，只保留最近 14 份。
 * 服務器上：cd ~/agent-pm && node scripts/backup-db.mjs（詳見 docs/DEPLOY.md 第 13 步）
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve(process.argv[2] ?? process.env.PM_DB ?? 'data/pm.db');
const dir = path.resolve(process.argv[3] ?? path.join(path.dirname(src), 'backups'));
const keep = Number(process.argv[4] ?? 14);

if (!fs.existsSync(src)) {
  console.error(`找不到資料庫 ${src}`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261116-030000（UTC）
const dest = path.join(dir, `pm-${stamp}Z.db`);

const db = new Database(src, { fileMustExist: true });
await db.backup(dest);
db.close();

const old = fs
  .readdirSync(dir)
  .filter((f) => /^pm-\d{8}-\d{6}Z\.db$/.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) fs.rmSync(path.join(dir, f));

const kb = Math.round(fs.statSync(dest).size / 1024);
console.log(`已備份到 ${dest}（${kb} KB）${old.length ? `，刪掉 ${old.length} 份舊備份` : ''}`);
