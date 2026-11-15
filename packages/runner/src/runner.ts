/**
 * Worker runner：每台電腦常駐一個。
 *   1. 定時問協調服務「有沒有適合我的任務」，有就原子領取
 *   2. 用 headless 模式啟動本地 agent（預設 `claude -p`）去執行
 *   3. 執行期間定時發心跳、定時存檢查點
 *   4. 任何原因中斷時，盡量把現場交接出去，讓別的 worker 接著做而不是重做
 *
 * 中斷時 runner 做什麼：
 *   - 人工打斷（Ctrl+C / SIGTERM）  停掉 agent → 存最後一個檢查點 → release_task(reason=interrupted)，任務立刻可被接手
 *   - agent 用量額度用完            agent 異常退出且輸出命中 HANDOFF_PATTERN → 存檢查點 → release_task(reason=usage_limit)，
 *                                   然後本機冷卻 COOLDOWN_MS 再領任務
 *   - 斷網、關機、runner 被強殺     什麼都來不及做。靠的是之前定時存下的檢查點；租約超時後任務回到任務池
 *   - 短暫網絡抖動                  心跳失敗只重試，不停 agent。如果租約已經超時但還沒人接手，重新領回來繼續
 *   - 租約被別人拿走                立刻停掉 agent，不再寫入
 *
 * 用法：
 *   PM_URL=http://host:4000 WORKER_ID=home-pc WORKER_LABELS=code,gpu npm run runner
 *   WORK_DIR=~/code/my-repo GIT_SYNC=1 ... npm run runner   # 中間成果自動 commit 並 push 到任務分支
 *   npm run runner -- --dry-run     # 不啟動真實 agent，假裝分 6 步幹活、每步存檢查點
 *   npm run runner -- --fake-agent  # 用 docs/examples/fake-agent.mjs 當 agent（寫一份五章的文件），驗收接力用
 *   npm run runner -- --once        # 做完（或交出）一個任務就退出
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildResume, httpApi, INTERRUPT_LABEL, PmError, type ResumeContext, type Task } from '@agent-pm/core';

const args = new Set(process.argv.slice(2));
const env = process.env;
/** 使用者敲命令時所在的目錄（npm 會把 cwd 換成 packages/runner，所以用 INIT_CWD） */
const startDir = env.INIT_CWD ?? process.cwd();
const fakeAgent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/examples/fake-agent.mjs');

const config = {
  url: env.PM_URL ?? 'http://localhost:4000',
  token: env.PM_TOKEN,
  workerId: env.WORKER_ID ?? os.hostname(),
  name: env.WORKER_NAME ?? env.WORKER_ID ?? os.hostname(),
  machine: env.WORKER_MACHINE ?? os.hostname(),
  labels: (env.WORKER_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** 只為這些項目（短名）幹活；不設就是「這個 token 的主人有權參與的項目都做」 */
  projects: env.WORKER_PROJECTS ? env.WORKER_PROJECTS.split(',').map((s) => s.trim()).filter(Boolean) : null,
  /** 啟動 agent 的命令，任務提示詞會作為最後一個參數傳入 */
  agentCmd: args.has('--fake-agent') ? `node ${fakeAgent}` : (env.AGENT_CMD ?? 'claude -p'),
  /** agent 的工作目錄，通常是這台電腦上的代碼倉庫；預設為啟動 runner 時所在的目錄 */
  workDir: path.resolve(startDir, env.WORK_DIR ?? '.'),
  pollMs: Number(env.POLL_MS ?? 5000),
  /** 每隔多久自動存一次檢查點（真實 agent 模式） */
  checkpointMs: Number(env.AUTO_CHECKPOINT_MS ?? 60_000),
  /** 開啟後，檢查點會把 WORK_DIR 的改動 commit 並 push 到任務分支；領取時先切到該分支。需要 WORK_DIR 是 git 倉庫 */
  gitSync: env.GIT_SYNC === '1',
  /** agent 異常退出時，輸出命中這個正則就視為「額度用完」而不是任務有問題 */
  handoffPattern: new RegExp(env.HANDOFF_PATTERN ?? 'usage limit|rate limit|quota|額度', 'i'),
  /** 額度用完後本機冷卻多久再領任務 */
  cooldownMs: Number(env.COOLDOWN_MS ?? 10 * 60_000),
  dryRun: args.has('--dry-run'),
  once: args.has('--once'),
};

const api = httpApi(config.url, config.token);
const log = (msg: string) => console.log(`[runner ${config.workerId}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── git：中間成果跟著任務分支走 ─────────────────────────

function git(...a: string[]): string {
  return execFileSync('git', a, { cwd: config.workDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const gitOk = (...a: string[]) => {
  try {
    git(...a);
    return true;
  } catch {
    return false;
  }
};

/** 領取後切到任務分支。
 *  - 分支在遠端已存在（別人做過一部分）：以遠端為準，這就是「接著做」的起點
 *  - 不存在：從主幹（GIT_BASE，預設遠端的預設分支）開一個新的
 *  本機上一次被強殺留下的未提交改動先 stash 起來，不帶進這個任務。 */
function gitPrepare(branch: string) {
  gitOk('fetch', 'origin');
  if (git('status', '--porcelain')) {
    git('stash', 'push', '-u', '-q', '-m', `agent-pm：切到 ${branch} 之前的遺留改動`);
    log('工作目錄有未提交的遺留改動，已 stash');
  }
  if (gitOk('rev-parse', '--verify', '--quiet', `origin/${branch}`)) {
    git('checkout', '-q', '-B', branch, `origin/${branch}`);
    log(`已切到任務分支 ${branch}（接續遠端 ${git('rev-parse', '--short', 'HEAD')}）`);
    return;
  }
  const base =
    env.GIT_BASE ??
    ['origin/HEAD', 'origin/main', 'origin/master'].find((b) => gitOk('rev-parse', '--verify', '--quiet', b)) ??
    'HEAD';
  git('checkout', '-q', '-B', branch, base);
  log(`已從 ${base} 建立任務分支 ${branch}`);
}

const HOOK_MARK = '# agent-pm-hook';
const HOOK = `#!/bin/sh
${HOOK_MARK} v1：所有項目共用一個倉庫。agent 在任務裡自己 commit 時，自動補上項目和任務標記，
# 這樣 git log --grep='Project: <項目短名>' 就能篩出一個項目的全部提交。不在任務裡（沒有 PM_ 環境變量）時什麼都不做。
[ -n "$PM_PROJECT_KEY" ] && [ -n "$PM_TASK_ID" ] || exit 0
f="$1"
grep -q "^Project: " "$f" && exit 0
first=$(head -n 1 "$f")
case "$first" in
  ""|"["*|"#"*) ;;
  *) { printf '[%s/%s] %s\n' "$PM_PROJECT_KEY" "$PM_TASK_KEY" "$first"; tail -n +2 "$f"; } > "$f.agentpm" && mv "$f.agentpm" "$f" ;;
esac
printf '\nProject: %s\nTask: %s\nWorker: %s\n' "$PM_PROJECT_KEY" "$PM_TASK_ID" "$PM_WORKER_ID" >> "$f"
`;

/** 在工作目錄裝一個 prepare-commit-msg hook，讓 agent 自己的 commit 也帶上項目標記。
 *  已經有別的 hook 就不動它，只提醒一聲。 */
function gitInstallHook() {
  try {
    const file = path.resolve(config.workDir, git('rev-parse', '--git-path', 'hooks/prepare-commit-msg'));
    if (fs.existsSync(file)) {
      const cur = fs.readFileSync(file, 'utf8');
      if (cur === HOOK) return;
      if (!cur.includes(HOOK_MARK)) {
        log(`${file} 已有別的 hook，沒有覆蓋；agent 自己的 commit 不會自動帶項目標記`);
        return;
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, HOOK, { mode: 0o755 });
  } catch (err) {
    log(`裝 git hook 失敗：${err instanceof Error ? err.message.slice(0, 200) : err}`);
  }
}

/** 把目前的改動 commit 並 push 到任務分支，返回 commit。沒有改動時返回目前的 HEAD。 */
function gitCheckpoint(task: Task, label: string): string {
  git('add', '-A');
  if (!gitOk('diff', '--cached', '--quiet')) {
    const ident = gitOk('config', 'user.name')
      ? []
      : ['-c', `user.name=${config.name}`, '-c', `user.email=${config.workerId}@agent-pm.local`];
    // 標題帶 [項目/任務]，結尾三行標記：共用倉庫裡靠它們分清每個 commit 是哪個項目、哪個任務、誰做的
    const message = `[${task.project_key}/${task.key}] ${label}\n\nProject: ${task.project_key}\nTask: ${task.id}\nWorker: ${config.workerId}`;
    git(...ident, 'commit', '-q', '-m', message);
  }
  git('push', '-q', '-u', 'origin', `HEAD:${task.branch}`);
  return git('rev-parse', '--short', 'HEAD');
}

// ───────────────────────── 提示詞 ─────────────────────────

function buildPrompt(task: Task, resume: ResumeContext | null): string {
  const reviews = task.reviews
    .filter((r) => r.decision === 'reject')
    .map((r) => `- ${r.reviewer}：${r.comment}`)
    .join('\n');
  const lines = [
    `你是 Worker Agent「${config.name}」（worker_id: ${config.workerId}），已經為你領取了下面這個任務。`,
    ``,
    `項目：${task.project_key}`,
    `任務 id：${task.id}`,
    `標題：${task.title}`,
    `描述：${task.description || '（無）'}`,
    `驗收標準：${task.acceptance || '（無）'}`,
    reviews ? `上一次被 PM 退回的意見：\n${reviews}` : '',
  ];
  if (resume) {
    lines.push(
      ``,
      `【這是接手續作，不要從頭開始】`,
      `這個任務之前已經做到 ${resume.progress}%${resume.reason ? `，上一位停下的原因：${INTERRUPT_LABEL[resume.reason]}` : ''}。`,
      `最後一個檢查點：${resume.summary}`,
      resume.next_steps ? `接下來要做：${resume.next_steps}` : '',
      resume.handoff_note ? `交接說明：${resume.handoff_note}` : '',
      resume.auto_note ? `中斷前的輸出片段：${resume.auto_note}` : '',
      config.gitSync
        ? `已有的中間成果在分支 ${resume.branch}${resume.commit ? `（${resume.commit}）` : ''}，工作目錄已經切到這個分支。`
        : `已有的中間成果應該在分支 ${resume.branch}${resume.commit ? `（${resume.commit}）` : ''}。`,
      `請先查看目前的實際內容，確認哪些已經完成（以實際內容為準），再從未完成的部分接著做。`,
    );
  }
  lines.push(
    ``,
    `執行過程中，每完成一個有意義的小步驟，就調用 agent-pm 的 MCP 工具 save_checkpoint（worker_id、task_id、summary、next_steps、progress）。`,
    `你隨時可能被中斷，接手的 agent 只能看到檢查點，所以要寫到別人照著就能接著做的程度。`,
    `所有項目共用這一個倉庫。只在分支 ${task.branch} 上提交，不要切到別的分支，也不要改動其他項目的分支。`,
    `commit 標題以 [${task.project_key}/${task.key}] 開頭；開 PR 時標題也以它開頭。`,
    `全部完成後調用 submit_result（worker_id、task_id、summary；代碼改動請開 PR 並填 pr_url）。`,
    `如果任務本身無法繼續，調用 report_blocked 並說明原因。心跳由 runner 負責，你不需要調用 heartbeat。`,
  );
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
}

// ───────────────────────── 執行 agent ─────────────────────────

interface Run {
  done: Promise<{ code: number; tail: string }>;
  stop: () => void;
  tail: () => string;
}

/** dry-run：假裝分 6 步幹活，每步存一個檢查點；接手時從檢查點的下一步開始 */
function runFake(task: Task, resume: ResumeContext | null): Run {
  const STEPS = 6;
  let stopped = false;
  let tail = '';
  const from = resume ? Math.min(STEPS - 1, Math.round((resume.progress / 100) * STEPS)) : 0;
  const done = (async () => {
    if (from > 0) log(`（dry-run）接續檢查點，跳過前 ${from} 步，從第 ${from + 1}/${STEPS} 步開始`);
    for (let step = from + 1; step <= STEPS; step++) {
      await sleep(1500);
      if (stopped) return { code: 143, tail: '被終止' };
      tail = `（dry-run）完成第 ${step}/${STEPS} 步`;
      log(tail);
      if (step < STEPS) {
        await api
          .saveCheckpoint(config.workerId, task.id, {
            summary: `完成第 ${step}/${STEPS} 步`,
            next_steps: `從第 ${step + 1} 步繼續`,
            progress: Math.round((step / STEPS) * 100),
          })
          .catch(() => {});
      }
    }
    return { code: 0, tail: `（dry-run）完成「${task.title}」，本次執行了第 ${from + 1} 到 ${STEPS} 步` };
  })();
  return { done, stop: () => (stopped = true), tail: () => tail };
}

function runAgent(task: Task, resume: ResumeContext | null): Run {
  if (config.dryRun) return runFake(task, resume);
  // 假 agent 的路徑可能含空格，不走按空格拆分的 AGENT_CMD
  const [cmd, ...cmdArgs] = args.has('--fake-agent') ? [process.execPath, fakeAgent] : config.agentCmd.split(' ').filter(Boolean);
  let tail = '';
  let child: ChildProcess | null = null;
  const done = new Promise<{ code: number; tail: string }>((resolve) => {
    child = spawn(cmd, [...cmdArgs, buildPrompt(task, resume)], {
      cwd: config.workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        PM_URL: config.url,
        PM_WORKER_ID: config.workerId,
        PM_TASK_ID: task.id,
        PM_TASK_KEY: task.key,
        PM_PROJECT_KEY: task.project_key,
        PM_TASK_BRANCH: task.branch,
        PM_RESUME_PROGRESS: String(resume?.progress ?? 0),
      },
    });
    const keep = (buf: Buffer) => {
      process.stdout.write(buf);
      tail = (tail + buf.toString()).slice(-2000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (err) => resolve({ code: 127, tail: `無法啟動 agent（${config.agentCmd}）：${err.message}` }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 143 : 1), tail }));
  });
  return { done, stop: () => child?.kill('SIGTERM'), tail: () => tail };
}

// ───────────────────────── 一個任務的完整生命週期 ─────────────────────────

let interrupted = false; // 收到 Ctrl+C / SIGTERM
let current: { stop: () => void } | null = null;

async function work(task: Task, leaseMs: number): Promise<'done' | 'handed_off' | 'cooldown'> {
  const resume = buildResume(task);
  log(
    resume
      ? `${resume.from_worker === config.workerId ? '回來繼續' : '接手'} [${task.project_key}]「${task.title}」（第 ${task.attempt} 次領取），從 ${resume.progress}% 繼續。上一位：${resume.from_worker === config.workerId ? '自己' : resume.from_worker}${resume.reason ? `，${INTERRUPT_LABEL[resume.reason]}` : ''}`
      : `領取 [${task.project_key}]「${task.title}」（第 ${task.attempt} 次領取），從頭開始`,
  );

  if (config.gitSync && !config.dryRun) {
    try {
      gitPrepare(task.branch);
      gitInstallHook();
    } catch (err) {
      await api.releaseTask(config.workerId, task.id, {
        reason: 'error',
        note: `無法切到任務分支 ${task.branch}：${err instanceof Error ? err.message.slice(0, 300) : err}`,
      });
      log(`無法準備任務分支，已交出任務`);
      return 'handed_off';
    }
  }

  const run = runAgent(task, resume);
  current = run;
  let leaseLost = false;

  /** 存一個自動檢查點：先確認租約還在自己手上，再 push，最後記到協調服務 */
  let lastAuto = '';
  const autoCheckpoint = async (label: string, force = true) => {
    if (config.dryRun) return;
    await api.heartbeat(config.workerId, task.id); // 租約不在了就會拋錯，不會把過期的改動推上去
    const commit = config.gitSync ? gitCheckpoint(task, label) : undefined;
    const out = run.tail().trim().slice(-600);
    if (!force && lastAuto === `${commit}|${out}`) return; // 沒有新進展就不重複記
    lastAuto = `${commit}|${out}`;
    await api.saveCheckpoint(config.workerId, task.id, {
      summary: `${label}${out ? `。agent 輸出片段：${out}` : ''}`,
      commit,
      auto: true,
    });
  };

  const onLeaseLost = async () => {
    const cur = await api.getTask(task.id).catch(() => null);
    if (!cur) return;
    if (cur.state === 'ready' || cur.state === 'changes_requested') {
      // 網絡抖動太久導致租約超時，但還沒人接手：領回來繼續，agent 不用停
      const again = await api.claimTask(config.workerId, task.id).catch(() => null);
      if (again) return log('租約曾經超時，但任務還沒被接手，已重新領回，繼續執行');
    }
    if (cur.state === 'claimed' && cur.assignee !== config.workerId && !leaseLost) {
      leaseLost = true;
      log('任務已被別的 worker 接手，停止 agent（本機未推送的改動保留在本地，不會覆蓋對方）');
      run.stop();
    }
    // 其餘情況（in_review / blocked / done）是 agent 自己處理完了，不用管
  };

  const hb = setInterval(
    () => {
      api.heartbeat(config.workerId, task.id).catch((err) => {
        if (err instanceof PmError && err.code === 'lease_lost') void onLeaseLost();
        // 其他錯誤多半是網絡抖動，下一次心跳再試
      });
    },
    Math.max(1000, Math.floor(leaseMs / 3)),
  );
  const cp = setInterval(() => {
    autoCheckpoint('自動檢查點', false).catch((err) => {
      if (err instanceof PmError && err.code === 'lease_lost') void onLeaseLost();
    });
  }, config.checkpointMs);

  const { code, tail } = await run.done;
  clearInterval(hb);
  clearInterval(cp);
  current = null;
  if (leaseLost) return 'handed_off';

  const cur = await api.getTask(task.id);
  if (cur.state !== 'claimed' || cur.assignee !== config.workerId) {
    log(`agent 已自行處理，任務狀態 ${cur.state}`);
    return 'done';
  }
  const lastWords = tail.trim().slice(-500);

  if (interrupted) {
    await autoCheckpoint('被打斷前的最後狀態').catch(() => {});
    await api.releaseTask(config.workerId, task.id, {
      reason: 'interrupted',
      note: '在這台電腦上被人工打斷。已保存到最後一個檢查點，可以直接接著做。',
    });
    log('已保存檢查點並交出任務，其他 worker 可以立刻接手');
    return 'handed_off';
  }
  if (code === 0) {
    const commit = config.gitSync && !config.dryRun ? gitCheckpoint(task, '完成') : undefined;
    await api.submitResult(config.workerId, task.id, {
      summary: `${lastWords || '已完成'}${commit ? `\n分支 ${task.branch}，commit ${commit}` : ''}`,
    });
    log('agent 正常退出，已代為提交');
    return 'done';
  }
  if (config.handoffPattern.test(tail)) {
    await autoCheckpoint('額度用完前的最後狀態').catch(() => {});
    await api.releaseTask(config.workerId, task.id, {
      reason: 'usage_limit',
      note: `這台電腦上的 agent 用量額度用完。${lastWords ? `最後輸出：${lastWords}` : ''}`,
    });
    log(`agent 額度用完，已保存檢查點並交出任務`);
    return 'cooldown';
  }
  await autoCheckpoint('異常退出前的最後狀態').catch(() => {});
  await api.reportBlocked(config.workerId, task.id, `agent 異常退出（code ${code}）：${lastWords}`);
  log(`agent 異常退出（code ${code}），已回報 blocked`);
  return 'done';
}

async function main() {
  log(
    `連接 ${config.url}，標籤 [${config.labels.join(', ')}]${config.projects ? `，只做項目 [${config.projects.join(', ')}]` : ''}` +
      (config.dryRun ? '，dry-run' : `，agent 工作目錄 ${config.workDir}${config.gitSync ? '，git 同步已開啟' : ''}`),
  );
  let registered = false;
  while (!interrupted) {
    try {
      if (!registered) {
        const me = await api.me();
        if (me.auth) log(`身分：${me.user.name}（${me.user.admin ? '管理員' : '只會領到自己參與的項目的任務'}）`);
        await api.registerWorker({
          id: config.workerId,
          name: config.name,
          machine: config.machine,
          labels: config.labels,
          projects: config.projects,
        });
        registered = true;
      }
      const task = await api.claimTask(config.workerId);
      if (task) {
        const { lease_ms } = await api.snapshot();
        const outcome = await work(task, lease_ms);
        if (config.once || interrupted) return;
        if (outcome === 'cooldown') {
          log(`冷卻 ${Math.round(config.cooldownMs / 1000)} 秒後再領任務`);
          await sleep(config.cooldownMs);
        }
        continue;
      }
    } catch (err) {
      registered = false;
      log(`出錯，稍後重試：${err instanceof Error ? err.message : err}`);
    }
    await sleep(config.pollMs);
  }
}

// Ctrl+C / kill：不是直接退出，而是停掉 agent、存檢查點、交出任務後再退出
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (interrupted) process.exit(130); // 再按一次強制退出
    interrupted = true;
    if (current) {
      log('收到中斷信號，正在保存檢查點並交出任務…（再按一次強制退出）');
      current.stop();
    } else process.exit(0);
  });
}

await main();
process.exit(0);
