#!/usr/bin/env node
/**
 * 把 `vite build --mode single` 產出的單檔 HTML 轉成可以直接發布/內嵌的片段：
 * 去掉 doctype、html、head、body 外殼，只留 title、樣式、根節點和腳本。
 * 產物不依賴協調服務，協調邏輯和模擬器都在瀏覽器裡跑。
 *   npm run build:single -w @agent-pm/web && node scripts/make-artifact.mjs <輸出路徑>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'packages/web/dist-single/index.html');
const out = process.argv[2] ?? path.join(root, 'packages/web/dist-single/agent-pm-viewer.html');

let html = fs.readFileSync(src, 'utf8');
html = html
  .replace(/<!doctype html>/i, '')
  .replace(/<\/?(html|head|body)[^>]*>/gi, '')
  .replace(/<meta charset[^>]*>/i, '')
  .replace(/<meta name="viewport"[^>]*>/i, '<meta name="claude:viewport-fit-sides" content="cover">')
  .trim();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html + '\n');
console.log(`已寫出 ${out}（${(html.length / 1024 / 1024).toFixed(2)} MB）`);
