#!/usr/bin/env node
/**
 * 假 agent，用來驗收「斷連後接手續作」。不需要任何 AI 額度。
 *
 * 它的「任務」是把一份 5 章的文件一章一章寫進工作目錄的 work/<任務 key>.md，每章花 FAKE_STEP_MS（預設 2 秒）。
 * 啟動時先看檔案裡已經寫到第幾章，從下一章接著寫。每章都標上是哪個 worker 寫的，
 * 所以最後看檔案就知道：有沒有哪一章被重寫、每一章是誰做的。
 *
 * 由 runner 啟動：AGENT_CMD="node /絕對路徑/docs/examples/fake-agent.mjs"
 * 環境變量：
 *   FAKE_STEP_MS=2000     每章耗時
 *   FAKE_FAIL_AT=3        寫完第 3 章後假裝額度用完（輸出 usage limit 並以非 0 退出）
 *   FAKE_NO_CHECKPOINT=1  不自己存檢查點（模擬不會調用 save_checkpoint 的 agent，只靠 runner 的自動檢查點）
 *   FAKE_COMMIT=1         每寫完一章自己 git commit 一次（訊息故意不帶項目標記，用來驗證 runner 裝的 git hook 會補上）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHAPTERS = 5;
const stepMs = Number(process.env.FAKE_STEP_MS ?? 2000);
const failAt = Number(process.env.FAKE_FAIL_AT ?? 0);
const worker = process.env.PM_WORKER_ID ?? 'unknown';
const key = process.env.PM_TASK_KEY ?? 'task';
const file = path.join(process.cwd(), 'work', `${key}.md`);
const api = `${process.env.PM_URL ?? 'http://localhost:4000'}/api/tasks/${process.env.PM_TASK_ID}/checkpoint`;

fs.mkdirSync(path.dirname(file), { recursive: true });
const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const done = (existing.match(/^## 第 \d+ 章/gm) ?? []).length;
console.log(done ? `檔案裡已有 ${done} 章，從第 ${done + 1} 章接著寫` : '檔案是空的，從第 1 章開始');

for (let n = done + 1; n <= CHAPTERS; n++) {
  await new Promise((r) => setTimeout(r, stepMs));
  fs.appendFileSync(file, `## 第 ${n} 章\n\n由 ${worker} 完成。\n\n`);
  console.log(`寫完第 ${n}/${CHAPTERS} 章`);
  if (process.env.FAKE_COMMIT) {
    const git = (...a) => execFileSync('git', a, { stdio: ['ignore', 'pipe', 'pipe'] });
    git('add', '-A');
    git('-c', `user.name=${worker}`, '-c', `user.email=${worker}@agent-pm.local`, 'commit', '-q', '-m', `寫完第 ${n} 章`);
  }
  // 相當於真實 agent 調用 MCP 的 save_checkpoint
  if (process.env.PM_TASK_ID && n < CHAPTERS && !process.env.FAKE_NO_CHECKPOINT) {
    await fetch(api, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.PM_TOKEN ? { authorization: `Bearer ${process.env.PM_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        worker_id: worker,
        summary: `寫完第 ${n}/${CHAPTERS} 章`,
        next_steps: `從第 ${n + 1} 章接著寫`,
        progress: Math.round((n / CHAPTERS) * 100),
      }),
    }).catch(() => {});
  }
  if (n === failAt) {
    console.log('Error: usage limit reached, try again later');
    process.exit(1);
  }
}
console.log(`全部 ${CHAPTERS} 章完成，本次寫了第 ${done + 1} 到 ${CHAPTERS} 章`);
