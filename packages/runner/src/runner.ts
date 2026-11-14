/**
 * Worker runner：每台電腦常駐一個。只做三件事：
 *   1. 定時問協調服務「有沒有適合我的任務」，有就原子領取
 *   2. 用 headless 模式啟動本地 agent（預設 `claude -p`）去執行
 *   3. 執行期間定時發心跳；租約丟失就殺掉 agent
 *
 * Agent 可以自己通過 MCP 調用 submit_result（帶 PR 鏈接）。如果 agent 退出時還沒提交，
 * runner 會兜底：正常退出就用輸出尾部作為 summary 提交，異常退出就回報 blocked。
 *
 * 用法：
 *   PM_URL=http://host:4000 WORKER_ID=home-pc WORKER_LABELS=code,gpu npm run runner
 *   WORK_DIR=~/code/my-repo ... npm run runner   # 指定 agent 的工作目錄（預設是啟動 runner 時所在的目錄）
 *   npm run runner -- --dry-run     # 不啟動真實 agent，假裝幹幾秒活，用來驗證連通
 *   npm run runner -- --once        # 做完一個任務就退出
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { httpApi, PmError, type Task } from '@agent-pm/core';

const args = new Set(process.argv.slice(2));
const env = process.env;

const config = {
  url: env.PM_URL ?? 'http://localhost:4000',
  token: env.PM_TOKEN,
  workerId: env.WORKER_ID ?? os.hostname(),
  name: env.WORKER_NAME ?? env.WORKER_ID ?? os.hostname(),
  machine: env.WORKER_MACHINE ?? os.hostname(),
  labels: (env.WORKER_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** 啟動 agent 的命令，任務提示詞會作為最後一個參數傳入 */
  agentCmd: env.AGENT_CMD ?? 'claude -p',
  /** agent 的工作目錄，通常是這台電腦上的代碼倉庫；預設為啟動 runner 時所在的目錄 */
  workDir: env.WORK_DIR ?? env.INIT_CWD ?? process.cwd(),
  pollMs: Number(env.POLL_MS ?? 5000),
  dryRun: args.has('--dry-run'),
  once: args.has('--once'),
};

const api = httpApi(config.url, config.token);
const log = (msg: string) => console.log(`[runner ${config.workerId}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildPrompt(task: Task): string {
  const reviews = task.reviews
    .filter((r) => r.decision === 'reject')
    .map((r) => `- ${r.reviewer}：${r.comment}`)
    .join('\n');
  return [
    `你是 Worker Agent「${config.name}」（worker_id: ${config.workerId}），已經為你領取了下面這個任務。`,
    ``,
    `任務 id：${task.id}`,
    `標題：${task.title}`,
    `描述：${task.description || '（無）'}`,
    `驗收標準：${task.acceptance || '（無）'}`,
    reviews ? `上一次被 PM 退回的意見：\n${reviews}` : '',
    ``,
    `完成後請調用 agent-pm 的 MCP 工具 submit_result（worker_id、task_id、summary；代碼改動請開 PR 並填 pr_url）。`,
    `如果無法繼續，調用 report_blocked 並說明原因。心跳由 runner 負責，你不需要調用 heartbeat。`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** 啟動 agent，返回退出碼和輸出尾部。onChild 讓外面在租約丟失時可以殺掉它。 */
function runAgent(task: Task, onChild: (kill: () => void) => void) {
  return new Promise<{ code: number; tail: string }>((resolve) => {
    if (config.dryRun) {
      const timer = setTimeout(() => resolve({ code: 0, tail: `（dry-run）假裝完成了「${task.title}」` }), 6000);
      onChild(() => {
        clearTimeout(timer);
        resolve({ code: 143, tail: '被終止' });
      });
      return;
    }
    const [cmd, ...cmdArgs] = config.agentCmd.split(' ').filter(Boolean);
    const child = spawn(cmd, [...cmdArgs, buildPrompt(task)], {
      cwd: config.workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, PM_TASK_ID: task.id, PM_WORKER_ID: config.workerId, PM_URL: config.url },
    });
    let tail = '';
    const keep = (buf: Buffer) => {
      process.stdout.write(buf);
      tail = (tail + buf.toString()).slice(-2000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => resolve({ code: 127, tail: `無法啟動 agent（${config.agentCmd}）：${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, tail }));
    onChild(() => child.kill('SIGTERM'));
  });
}

async function work(task: Task, leaseMs: number) {
  log(`領取「${task.title}」（第 ${task.attempt} 次）`);
  let kill = () => {};
  let leaseLost = false;
  const hb = setInterval(
    async () => {
      try {
        await api.heartbeat(config.workerId, task.id);
      } catch (err) {
        // lease_lost 也可能是 agent 已經自己 submit 了，此時不該殺它
        if (err instanceof PmError && err.code === 'lease_lost') {
          const cur = await api.getTask(task.id).catch(() => null);
          if (cur && cur.state === 'claimed') {
            leaseLost = true;
            log('租約已丟失，終止 agent');
            kill();
          }
        }
      }
    },
    Math.max(1000, Math.floor(leaseMs / 3)),
  );

  const { code, tail } = await runAgent(task, (k) => (kill = k));
  clearInterval(hb);
  if (leaseLost) return;

  // 兜底：agent 沒有自己提交時由 runner 收尾
  const cur = await api.getTask(task.id);
  if (cur.state !== 'claimed' || cur.assignee !== config.workerId) {
    log(`agent 已自行處理，任務狀態 ${cur.state}`);
    return;
  }
  if (code === 0) {
    await api.submitResult(config.workerId, task.id, { summary: tail.trim().slice(-1500) || '已完成' });
    log('agent 正常退出，已代為提交');
  } else {
    await api.reportBlocked(config.workerId, task.id, `agent 異常退出（code ${code}）：${tail.trim().slice(-500)}`);
    log(`agent 異常退出（code ${code}），已回報 blocked`);
  }
}

async function main() {
  log(`連接 ${config.url}，標籤 [${config.labels.join(', ')}]${config.dryRun ? '，dry-run' : `，agent 工作目錄 ${config.workDir}`}`);
  let registered = false;
  for (;;) {
    try {
      if (!registered) {
        await api.registerWorker({
          id: config.workerId,
          name: config.name,
          machine: config.machine,
          labels: config.labels,
        });
        registered = true;
      }
      const task = await api.claimTask(config.workerId);
      if (task) {
        const { lease_ms } = await api.snapshot();
        await work(task, lease_ms);
        if (config.once) return;
        continue;
      }
    } catch (err) {
      registered = false;
      log(`出錯，稍後重試：${err instanceof Error ? err.message : err}`);
    }
    await sleep(config.pollMs);
  }
}

await main();
