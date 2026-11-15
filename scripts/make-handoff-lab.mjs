#!/usr/bin/env node
/**
 * 建一個驗收「跨電腦接力」用的小實驗室：
 *   lab/remote.git   裸倉庫，當作 GitHub
 *   lab/pc-a         第一台電腦上的 clone
 *   lab/pc-b         第二台電腦上的 clone
 * 用法：node scripts/make-handoff-lab.mjs   （重跑會清空重建）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lab = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lab');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

fs.rmSync(lab, { recursive: true, force: true });
fs.mkdirSync(lab, { recursive: true });
git(lab, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
git(lab, 'clone', '-q', 'remote.git', 'pc-a');
fs.writeFileSync(path.join(lab, 'pc-a/README.md'), '# 接力實驗用的倉庫\n');
git(path.join(lab, 'pc-a'), 'add', '-A');
git(path.join(lab, 'pc-a'), '-c', 'user.name=lab', '-c', 'user.email=lab@agent-pm.local', 'commit', '-q', '-m', 'init');
git(path.join(lab, 'pc-a'), 'push', '-q', 'origin', 'HEAD:main');
git(lab, 'clone', '-q', 'remote.git', 'pc-b');
console.log(`已建立 ${lab}`);
console.log('  remote.git  遠端倉庫\n  pc-a        第一台電腦的工作目錄\n  pc-b        第二台電腦的工作目錄');
