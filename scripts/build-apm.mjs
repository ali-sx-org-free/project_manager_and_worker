#!/usr/bin/env node
/** 把 apm 打包成一個不需要 npm install 的檔案：plugin/lib/apm.mjs（Node 20 以上直接跑） */
import { build } from 'esbuild';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'plugin/lib/apm.mjs');
const version = JSON.parse(readFileSync(path.join(root, 'packages/github/package.json'), 'utf8')).version;

await build({
  entryPoints: [path.join(root, 'packages/github/src/cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  banner: { js: `// apm ${version} · agent-pm 命令行（由 scripts/build-apm.mjs 從 packages/github 打包，不要手改）` },
  logLevel: 'warning',
});
chmodSync(outfile, 0o755);
console.log(`plugin/lib/apm.mjs ${(statSync(outfile).size / 1024).toFixed(0)} KB`);
