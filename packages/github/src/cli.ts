#!/usr/bin/env node
/**
 * apm：agent-pm 的命令行。PM 和 Worker 的 Skill 都只調用它，GitHub 上的讀寫全部在這裡。
 * 輸出 JSON（在終端裡跑時，status / list / locks 等改成人看的表格；加 --json 強制 JSON）。
 *
 * 退出碼：0 成功；1 出錯；2 沒有可領的任務 / 手上沒有任務；3 租約已不屬於你（lease_lost），立刻停手。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { InterruptReason, ProjectRole } from '@agent-pm/core';
import { resolveToken } from './client.ts';
import { Hub } from './hub.ts';
import { apmHome, defaultWorkerId, loadConfig, saveConfig, StateFile, type LocalConfig } from './local.ts';
import { PmOps, type Plan, type PlanTask } from './pm.ts';
import { LeaseLost, NothingHeld, WorkerOps, type WorkerIdentity } from './worker.ts';
import { selftest } from './selftest.ts';

export const VERSION = '0.2.1';

// ───────────────────────── 走代理的環境 ─────────────────────────

// Node 的 fetch 預設不看 HTTPS_PROXY。公司網路或雲端沙箱裡要設 NODE_USE_ENV_PROXY=1 才連得上 GitHub
if (
  (process.env.HTTPS_PROXY || process.env.https_proxy) &&
  !process.env.NODE_USE_ENV_PROXY &&
  !process.env.APM_NO_REEXEC &&
  Number(process.versions.node.split('.')[0]) >= 22
) {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      APM_NO_REEXEC: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --disable-warning=UNDICI-EHPA`.trim(),
    },
  });
  process.exit(r.status ?? 1);
}

// ───────────────────────── 參數 ─────────────────────────

const BOOL = new Set([
  'json',
  'text',
  'help',
  'approve',
  'reject',
  'human',
  'merge',
  'resume',
  'dry-run',
  'cancel',
  'create',
  'forget',
  'once',
  'permissions',
  'launcher',
  'link',
  'prs',
  'yes',
  'open-pr',
]);

interface Args {
  pos: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Args['flags'] = {};
  const put = (k: string, v: string | boolean) => {
    const prev = flags[k];
    if (prev === undefined || typeof v === 'boolean') flags[k] = v;
    else flags[k] = Array.isArray(prev) ? [...prev, v as string] : typeof prev === 'string' ? [prev, v as string] : v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) {
        put(k, a.slice(eq + 1));
        continue;
      }
      if (k.startsWith('no-') && BOOL.has(k.slice(3))) {
        put(k.slice(3), false);
        continue;
      }
      if (BOOL.has(k)) {
        put(k, true);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) put(k, true);
      else {
        put(k, next);
        i++;
      }
    } else if (a === '-f' && argv[i + 1] !== undefined) {
      put('file', argv[++i]);
    } else if (a === '-h') put('help', true);
    else pos.push(a);
  }
  return { pos, flags };
}

const str = (f: Args['flags'], k: string): string | undefined => {
  const v = f[k];
  if (v === undefined || typeof v === 'boolean') return undefined;
  return Array.isArray(v) ? v.at(-1) : v;
};
const list = (f: Args['flags'], k: string): string[] | undefined => {
  const v = f[k];
  if (v === undefined || typeof v === 'boolean') return undefined;
  return (Array.isArray(v) ? v : [v])
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean);
};
const num = (f: Args['flags'], k: string): number | undefined => {
  const v = str(f, k);
  if (v === undefined) return undefined;
  const n = Number(v.replace(/^#/, ''));
  if (Number.isNaN(n)) throw new UsageError(`--${k} 要是數字（收到「${v}」）`);
  return n;
};
const bool = (f: Args['flags'], k: string): boolean | undefined => {
  const v = f[k];
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(Array.isArray(v) ? v.at(-1) : v).toLowerCase();
  if (['true', 'yes', '1', 'on', '是'].includes(s)) return true;
  if (['false', 'no', '0', 'off', '否'].includes(s)) return false;
  throw new UsageError(`--${k} 要是 true 或 false`);
};
const taskNo = (s: string | undefined, what = '任務編號'): number => {
  const n = Number(String(s ?? '').replace(/^#/, ''));
  if (!s || !Number.isInteger(n) || n <= 0) throw new UsageError(`需要${what}，例如 apm task show 42`);
  return n;
};

class UsageError extends Error {
  readonly code = 'usage';
}

// ───────────────────────── 上下文 ─────────────────────────

interface Ctx {
  args: Args;
  cfg: LocalConfig;
  hubName: string | undefined;
  hub(): Hub;
  pm(): PmOps;
  worker(): Promise<WorkerOps>;
}

function makeCtx(args: Args): Ctx {
  const cfg = loadConfig();
  const hubName = str(args.flags, 'hub') || process.env.APM_HUB || cfg.hub;
  let hub: Hub | null = null;
  const getHub = () => {
    if (hub) return hub;
    if (!hubName) throw new UsageError('還沒設定 hub。先跑 apm setup --hub owner/repo（或加 --hub、設 APM_HUB）');
    const token = resolveToken();
    if (!token) throw new UsageError('沒有 GitHub 登入：先執行 gh auth login，或設環境變量 GH_TOKEN');
    // APM_API_BASE / APM_GIT_REMOTE：連 GitHub Enterprise，或在本機用假 GitHub 演練（scripts/fake-github）
    hub = new Hub({ repo: hubName, token, apiBase: process.env.APM_API_BASE || undefined, gitRemote: process.env.APM_GIT_REMOTE || undefined });
    return hub;
  };
  return {
    args,
    cfg,
    hubName,
    hub: getHub,
    pm: () => new PmOps(getHub()),
    worker: async () => {
      const h = getHub();
      const id = str(args.flags, 'worker') || process.env.APM_WORKER_ID || cfg.worker?.id || defaultWorkerId();
      const me: WorkerIdentity = {
        id,
        name: cfg.worker?.name || id,
        machine: cfg.worker?.machine || hostname(),
        labels: cfg.worker?.labels ?? [],
        projects: cfg.worker?.projects?.length ? cfg.worker.projects : null,
        owner: await h.me(),
      };
      return new WorkerOps(h, me, new StateFile(h.name, id));
    },
  };
}

// ───────────────────────── 輸出 ─────────────────────────

let forceJson = false;
let forceText = false;
const tty = () => forceText || !!process.stdout.isTTY;

function out(data: unknown, text?: () => string) {
  if (text && tty() && !forceJson) process.stdout.write(text() + '\n');
  else process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

const fmtTime = (t: number | null | undefined) => (t ? new Date(t).toLocaleString() : '—');
const fmtLeft = (s: number | null | undefined) => (s === null || s === undefined ? '' : s <= 0 ? '已過期' : s < 120 ? `${s} 秒` : `${Math.round(s / 60)} 分`);
const pad = (s: string, n: number) => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(1, n - w));
};
const STATE_ZH: Record<string, string> = {
  pending: '等依賴',
  ready: '可領取',
  claimed: '執行中',
  in_review: '待 review',
  changes_requested: '退回修改',
  blocked: '受阻',
  done: '完成',
};

// ───────────────────────── 安裝：啟動器和權限 ─────────────────────────

function selfPath(): string {
  return resolve(process.argv[1]);
}

function installLauncher(link: boolean): { bin: string; linked: string | null; mode: 'bundle' | 'dev'; from_installed_copy?: boolean } {
  const home = apmHome();
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  const me = selfPath();
  let cmd: string;
  let mode: 'bundle' | 'dev' = 'bundle';
  let fromCopy = false;
  if (me.endsWith('.ts')) {
    // 開發模式：從原型倉庫用 tsx 跑
    mode = 'dev';
    const root = resolve(dirname(me), '../../..');
    cmd = `"${process.execPath}" "${join(root, 'node_modules/tsx/dist/cli.mjs')}" "${me}"`;
  } else {
    const lib = join(home, 'lib');
    mkdirSync(lib, { recursive: true });
    const copy = join(lib, 'apm.mjs');
    // 用啟動器跑 apm setup 時，跑的就是這份副本：複製不會更新任何東西
    if (resolve(me) === resolve(copy)) fromCopy = true;
    else copyFileSync(me, copy);
    cmd = `node "${copy}"`;
  }
  const sh = join(binDir, 'apm');
  writeFileSync(sh, `#!/bin/sh\n# agent-pm 的 apm 啟動器（apm setup 生成）\nexec ${cmd} "$@"\n`);
  chmodSync(sh, 0o755);
  writeFileSync(join(binDir, 'apm.cmd'), `@echo off\r\n${cmd.replace(/\//g, '\\')} %*\r\n`);
  let linked: string | null = null;
  if (link) {
    const local = join(homedir(), '.local', 'bin');
    mkdirSync(local, { recursive: true });
    const target = join(local, 'apm');
    writeFileSync(target, `#!/bin/sh\nexec "${sh}" "$@"\n`);
    chmodSync(target, 0o755);
    linked = target;
  }
  return { bin: sh, linked, mode, ...(fromCopy ? { from_installed_copy: true } : {}) };
}

const RULES = (bin: string) => ['Bash(apm *)', 'Bash(apm:*)', `Bash(${bin} *)`];

function claudeSettingsPath() {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
}

/** 在 Claude Code 的使用者設定裡允許 apm 命令。不加的話，agent 在後台被喚醒後續約會卡在權限確認上 */
function allowInClaude(bin: string): { path: string; added: string[]; error?: string } {
  const path = claudeSettingsPath();
  let data: { permissions?: { allow?: string[] } } & Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { path, added: [], error: `${path} 不是合法的 JSON，沒有改它。請手動在 permissions.allow 加上 "Bash(apm *)"` };
    }
  }
  data.permissions ??= {};
  data.permissions.allow ??= [];
  const added = RULES(bin).filter((r) => !data.permissions!.allow!.includes(r));
  if (added.length) {
    data.permissions.allow.push(...added);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  }
  return { path, added };
}

function permissionsOk(): boolean {
  try {
    const d = JSON.parse(readFileSync(claudeSettingsPath(), 'utf8'));
    const allow: string[] = d?.permissions?.allow ?? [];
    return allow.some((r) => r === 'Bash(apm *)' || r === 'Bash(apm:*)');
  } catch {
    return false;
  }
}

// ───────────────────────── 檢查 ─────────────────────────

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function checks(ctx: Ctx, deep: boolean): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 20, `v${process.versions.node}${major < 20 ? '（需要 20 以上）' : ''}`);
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  add('git', git.status === 0, git.status === 0 ? git.stdout.trim() : '找不到 git，請先安裝：https://git-scm.com/downloads');
  const token = resolveToken();
  add('GitHub 登入', !!token, token ? (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.APM_TOKEN ? '用環境變量裡的 token' : '用 gh auth token') : '沒有登入：執行 gh auth login');
  if (!token || !ctx.hubName) {
    if (!ctx.hubName) add('hub', false, '還沒設定：apm setup --hub owner/repo');
    return out;
  }
  const hub = ctx.hub();
  try {
    const me = await hub.me();
    add('帳號', true, me);
    const info = (await hub.repoInfo()) as { private: boolean; permissions?: Record<string, boolean> };
    add('hub 倉庫', true, hub.name);
    add('hub 是私有的', info.private, info.private ? '是' : '不是！任務正文會被 agent 當指令執行，請改成 Private');
    add('hub 寫入權限', !!info.permissions?.push, info.permissions?.admin ? 'admin' : info.permissions?.push ? 'write' : '沒有：請管理員邀請你（Write）');
    const cfg = await hub.config();
    add('hub 設定', true, `租約 ${cfg.lease_minutes} 分鐘、續約間隔 ${cfg.heartbeat_minutes} 分鐘`);
    const skew = hub.now() - Date.now();
    add('本機時鐘', Math.abs(skew) < 120_000, `和 GitHub 差 ${Math.round(skew / 1000)} 秒（租約一律按 GitHub 的時間算）`);
    if (deep) {
      const t0 = Date.now();
      const locks = await hub.locks.list();
      add('讀取鎖（git）', true, `${locks.size} 條鎖，${Date.now() - t0} ms`);
      const projects = await hub.projects('open');
      add('項目', true, `${projects.length} 個進行中`);
      const rate = hub.gh.rate;
      if (rate) add('API 額度', rate.remaining > 200, `本小時還剩 ${rate.remaining}/${rate.limit}`);
    }
  } catch (err) {
    add('連接 hub', false, err instanceof Error ? err.message : String(err));
  }
  add('Claude Code 權限', permissionsOk(), permissionsOk() ? `${claudeSettingsPath()} 已允許 apm` : '還沒允許 apm 命令：apm setup 會加上（後台續約需要）');
  return out;
}

const checksText = (cs: Check[]) => cs.map((c) => `${c.ok ? '✓' : '✗'} ${pad(c.name, 18)}${c.detail}`).join('\n');

// ───────────────────────── 命令 ─────────────────────────

const HELP = `apm ${VERSION} · agent-pm 的命令行（GitHub 當中間層，不需要服務器）

開始
  apm setup --hub owner/repo [--id 名字] [--labels code,gpu]   檢查環境、寫本機設定、安裝啟動器、允許 Claude Code 調用 apm
  apm doctor                     檢查登入、hub 權限、時鐘、鎖
  apm selftest                   不連網，用假 GitHub 跑一遍完整流程（含 20 個 worker 搶 5 個任務）
  apm init owner/repo [--create] 建 hub（標籤、設定、名冊）

Worker
  apm join [--labels code] [--projects site,blog] [--repo owner/r=/本機路徑]
  apm list                       我能領的任務（排好序）
  apm claim [--task 42]          領取（返回任務、續作資訊、分支和 commit 格式）
  apm keepalive                  在後台跑：定時續約，任務結束或被接手時退出
  apm heartbeat                  手動續約
  apm checkpoint --summary "…" [--next "…"] [--progress 60] [--commit abc123] [--artifact 路徑]
  apm submit --summary "…" [--pr 網址] [--no-open-pr]   還沒有 PR 時自動用任務分支開一個
  apm block --reason "…"
  apm release [--reason usage_limit|interrupted|released|error] [--note "交接說明"]
  apm current                    手上的任務
  apm leave [--note "…"] [--forget]

PM
  apm status [項目]
  apm project create -f plan.json [--resume]
  apm project set <項目> [--priority 1-5] [--max-parallel N|none] [--repo owner/r] [--base main] [--merge-on-approve true|false]
  apm project member <項目> <GitHub 帳號> manager|contributor|viewer|none
  apm project close <項目> [--cancel] [--note "…"]
  apm task show <編號>
  apm task add <項目> --key k --title "…" [--desc "…"] [--acceptance "…"] [--caps code] [--deps api,#57] [--human]
  apm task edit <編號> [--title …] [--desc …] [--acceptance …] [--caps …] [--deps …] [--human true|false]
  apm task cancel <編號> [--note "…"]
  apm review <編號> --approve|--reject [--comment "…"] [--human] [--no-merge]
  apm unblock <編號> [--note "…"]
  apm revoke <編號> [--note "…"]          收回正在執行的任務
  apm reconcile [--dry-run]               讓標籤跟上鎖，補上在 GitHub 網頁上做的 PR review

管理員
  apm locks [prune [--dry-run]]
  apm invite <帳號> [--permission push]   apm uninvite <帳號>   apm members

通用參數：--hub owner/repo  --worker <id>  --json（強制 JSON）  --text（強制人看的格式）
退出碼：0 成功 · 1 出錯 · 2 沒有任務 · 3 租約已不屬於你（立刻停手）`;

type Handler = (ctx: Ctx) => Promise<number | void>;

const commands: Record<string, Handler> = {
  async help() {
    process.stdout.write(HELP + '\n');
  },
  async version() {
    out({ version: VERSION }, () => VERSION);
  },

  async selftest() {
    const r = await selftest();
    out(r, () => r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? `：${s.detail}` : ''}`).join('\n') + `\n\n${r.ok ? '全部通過' : '有失敗'}`);
    return r.ok ? 0 : 1;
  },

  async setup(ctx) {
    const f = ctx.args.flags;
    const cfg: LocalConfig = { ...ctx.cfg, worker: { ...ctx.cfg.worker } };
    const hub = str(f, 'hub') || ctx.cfg.hub;
    if (hub) cfg.hub = hub;
    applyWorkerFlags(cfg, f);
    saveConfig(cfg);
    const ctx2 = makeCtx({ ...ctx.args, flags: { ...f, hub: cfg.hub ?? '' } });
    const result: Record<string, unknown> = { config: join(apmHome(), 'config.json'), hub: cfg.hub ?? null, worker: cfg.worker };
    if (f.launcher !== false) result.launcher = installLauncher(f.link === true);
    if (f.permissions !== false) {
      const bin = (result.launcher as { bin?: string } | undefined)?.bin ?? join(apmHome(), 'bin', 'apm');
      result.permissions = allowInClaude(bin);
    }
    const cs = await checks(ctx2, true);
    result.checks = cs;
    result.ok = cs.every((c) => c.ok || c.name === 'Claude Code 權限');
    out(result, () => {
      const l = result.launcher as ReturnType<typeof installLauncher> | undefined;
      const p = result.permissions as ReturnType<typeof allowInClaude> | undefined;
      return [
        `本機設定：${result.config}`,
        l ? `啟動器：${l.bin}${l.linked ? `（也放到了 ${l.linked}）` : ''}` : '',
        l?.from_installed_copy
          ? `  現在跑的就是已安裝的 apm ${VERSION}，沒有更新。要更新：先拿到新版（git pull），再用新版的檔案跑 setup，例如 node ~/agent-pm-tools/plugin/lib/apm.mjs setup --hub <倉庫>`
          : '',
        l && !l.linked && !onPath(dirname(l.bin))
          ? `  在終端裡直接打 apm：把它加進 PATH，例如在 ~/.zshrc 或 ~/.bashrc 加一行 export PATH="${dirname(l.bin)}:$PATH"，或重跑 apm setup --link`
          : '',
        p ? (p.error ? `權限：${p.error}` : `Claude Code 權限：${p.added.length ? `在 ${p.path} 加上 ${p.added.join('、')}` : '已經有了'}`) : '',
        '',
        checksText(cs),
      ]
        .filter((x) => x !== '')
        .join('\n');
    });
    return result.ok ? 0 : 1;
  },

  async doctor(ctx) {
    const cs = await checks(ctx, true);
    const w = ctx.hubName ? new StateFile(ctx.hubName, str(ctx.args.flags, 'worker') || process.env.APM_WORKER_ID || ctx.cfg.worker?.id || defaultWorkerId()).load() : null;
    const ok = cs.every((c) => c.ok);
    out({ ok, checks: cs, held: w ? { task: w.task, title: w.title, attempt: w.attempt, lost: w.lost ?? null } : null }, () =>
      checksText(cs) + (w ? `\n\n手上的任務：#${w.task}「${w.title}」第 ${w.attempt} 次領取${w.lost ? '（已被接手）' : ''}` : ''),
    );
    return ok ? 0 : 1;
  },

  async init(ctx) {
    const repo = ctx.args.pos[1] || ctx.hubName;
    if (!repo) throw new UsageError('用法：apm init owner/repo [--create]');
    const c = makeCtx({ ...ctx.args, flags: { ...ctx.args.flags, hub: repo } });
    const r = await c.pm().init({ create: ctx.args.flags.create === true });
    if (!ctx.cfg.hub) saveConfig({ ...ctx.cfg, hub: r.hub });
    out(r, () =>
      [
        `hub 已就緒：${r.url}`,
        `私有：是 · 設定檔：${{ created: '已建立', exists: '已存在', default: '用預設值' }[r.config]} · 名冊：#${r.roster}`,
        ...r.notes.map((n) => `注意：${n}`),
        '',
        `下一步：邀請成員 apm invite <帳號>，然後建項目 apm project create -f plan.json`,
      ].join('\n'),
    );
  },

  // ───────────── Worker ─────────────

  async join(ctx) {
    const cfg: LocalConfig = { ...ctx.cfg, worker: { ...ctx.cfg.worker } };
    applyWorkerFlags(cfg, ctx.args.flags);
    // --worker / APM_WORKER_ID 只管這一次（同一台電腦的第二個 worker），不寫進設定；只有 --id 或第一次的主機名會存下來
    const transient = str(ctx.args.flags, 'worker') || process.env.APM_WORKER_ID;
    if (!cfg.worker!.id && !transient) cfg.worker!.id = defaultWorkerId();
    saveConfig(cfg);
    const id = str(ctx.args.flags, 'id') || transient || cfg.worker!.id || defaultWorkerId();
    const w = await makeCtx({ ...ctx.args, flags: { ...ctx.args.flags, worker: id } }).worker();
    const meta = await w.join();
    out({ worker: meta, config: join(apmHome(), 'config.json') }, () =>
      `已加入 ${w.hub.name}：${meta.id}（${meta.owner}），能力 ${meta.labels.join('、') || '（無）'}${meta.projects?.length ? `，只做 ${meta.projects.join('、')}` : ''}`,
    );
  },

  async leave(ctx) {
    const w = await ctx.worker();
    let released: number | null = null;
    const held = w.state.load();
    if (held && !held.lost) {
      try {
        released = (await w.release('released', str(ctx.args.flags, 'note') ?? '主動離開')).task;
      } catch (err) {
        if (!(err instanceof LeaseLost)) throw err;
      }
    }
    w.state.clear();
    let dropped = false;
    if (ctx.args.flags.forget === true) {
      await w.forget();
      // 只在離開的是本機設定裡的那個 worker 時才刪設定（用 APM_WORKER_ID 臨時開的第二個 worker 不影響主設定）
      const mainId = ctx.cfg.worker?.id;
      dropped = !mainId || mainId === w.me.id;
      if (dropped) {
        const cfg = { ...ctx.cfg };
        delete cfg.worker;
        saveConfig(cfg);
      }
    } else await w.updateRoster({ status: 'left', current_task: null });
    out({ left: w.me.id, released, forgot: ctx.args.flags.forget === true, config_removed: dropped }, () =>
      `${w.me.id} 已離開${released ? `，交出了 #${released}` : ''}${ctx.args.flags.forget === true ? `，名冊記錄${dropped ? '和本機的 worker 設定' : ''}已刪除` : ''}`,
    );
  },

  async list(ctx) {
    const w = await ctx.worker();
    const r = await w.list();
    const rows = r.candidates.map((c) => ({
      number: c.task.number,
      title: c.task.title,
      project: c.project.key,
      priority: c.project.priority,
      state: c.state,
      caps: c.task.caps,
      expired: c.expired,
      mine: c.lock?.worker === w.me.id,
      url: c.task.url,
    }));
    const why = [...r.why.entries()].slice(0, 30).map(([n, reason]) => ({ number: n, reason }));
    out({ worker: w.me.id, claimable: rows, not_claimable: why }, () =>
      rows.length
        ? rows.map((x, i) => `${i + 1}. #${x.number} ${pad(x.title, 30)} ${x.project}（優先級 ${x.priority}）${x.state === 'changes_requested' ? ' 退回修改' : ''}${x.expired ? ' 租約過期待接手' : ''}${x.mine ? ' ← 你做過' : ''}`).join('\n')
        : `沒有可領的任務。${why.length ? `\n\n${why.slice(0, 10).map((x) => `#${x.number}：${x.reason}`).join('\n')}` : ''}`,
    );
  },

  async claim(ctx) {
    const w = await ctx.worker();
    const n = num(ctx.args.flags, 'task') ?? (ctx.args.pos[1] ? taskNo(ctx.args.pos[1]) : undefined);
    const r = await w.claim(n);
    if (!r) {
      out({ claimed: null, message: '沒有可領的任務' }, () => '沒有可領的任務');
      return 2;
    }
    const local = ctx.cfg.worker?.repos?.[r.git.repo] ?? null;
    const res = { ...r, git: { ...r.git, local_path: local } };
    out(res, () =>
      [
        `領到 #${r.task.number}「${r.task.title}」（${r.task.project}，第 ${r.attempt} 次領取）`,
        r.resume ? `續作：上一位 ${r.resume.from_worker ?? '—'} 做到 ${r.resume.progress}%（${r.resume.reason ?? ''}）\n  ${r.resume.summary}\n  接下來：${r.resume.next_steps ?? '—'}` : '從頭開始',
        ...(r.reviews.at(-1)?.decision === 'reject' ? [`被退回：${r.reviews.at(-1)!.comment || '（沒有說明）'}（${r.reviews.at(-1)!.reviewer}）`] : []),
        `代碼倉庫 ${r.git.repo}${local ? `（本機 ${local}）` : ''}，分支 ${r.git.branch}`,
        `租約到 ${fmtTime(r.lease_expires_at)}。現在在後台跑 apm keepalive`,
      ].join('\n'),
    );
  },

  async current(ctx) {
    const w = await ctx.worker();
    const c = await w.current();
    if (!c.held) {
      out({ held: null }, () => '手上沒有任務');
      return 2;
    }
    const data = {
      held: { task: c.held.task, title: c.held.title, project: c.held.project_key, attempt: c.held.attempt, branch: c.held.branch, repo: c.held.code_repo, claimed_at: c.held.claimed_at },
      alive: c.alive,
      lost: c.held.lost ?? (c.lock && !(c.lock.worker === w.me.id && c.lock.attempt === c.held.attempt) ? { holder: c.lock.worker } : null),
      lease_expires_at: c.lock?.expires_at ?? null,
    };
    out(data, () =>
      `#${c.held!.task}「${c.held!.title}」第 ${c.held!.attempt} 次領取 · ${data.lost ? `已被 ${data.lost.holder ?? '別人'} 接手，請停手` : c.alive ? `租約到 ${fmtTime(data.lease_expires_at)}` : '租約已過期（還沒人接手，續約可以領回）'}`,
    );
    return data.lost ? 3 : 0;
  },

  async heartbeat(ctx) {
    const w = await ctx.worker();
    const r = await w.heartbeat();
    out(r, () => `#${r.task} 已續約，到 ${fmtTime(r.lease_expires_at)}`);
  },

  async keepalive(ctx) {
    const w = await ctx.worker();
    const cfg = await w.hub.config();
    const every = (num(ctx.args.flags, 'interval') ?? cfg.heartbeat_minutes * 60) * 1000;
    const idleMs = (num(ctx.args.flags, 'idle') ?? cfg.idle_minutes * 60) * 1000;
    const parent = num(ctx.args.flags, 'pid') ?? process.ppid;
    const start = w.state.load();
    if (!start) {
      out({ stopped: 'no_task' });
      return 2;
    }
    const line = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), task: start.task, ...o }) + '\n');
    const alive = (pid: number) => {
      if (pid <= 1) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    };
    line({ started: true, every_s: every / 1000, idle_stop_s: idleMs / 1000, parent });
    for (;;) {
      const s = w.state.load();
      if (!s || s.task !== start.task || s.attempt !== start.attempt) {
        line({ stopped: 'task_finished' });
        return 0;
      }
      if (s.lost) {
        line({ stopped: 'lease_lost', holder: s.lost.holder });
        return 3;
      }
      if (!alive(parent)) {
        line({ stopped: 'parent_gone' });
        return 0;
      }
      if (Date.now() - s.last_activity > idleMs) {
        line({ stopped: 'agent_idle', idle_s: Math.round((Date.now() - s.last_activity) / 1000) });
        return 0;
      }
      try {
        const r = await w.heartbeat({ background: true });
        line({ renewed: true, lease_expires_at: new Date(r.lease_expires_at).toISOString() });
      } catch (err) {
        if (err instanceof LeaseLost) {
          line({ stopped: 'lease_lost', message: err.message, holder: err.detail.holder });
          return 3;
        }
        if (err instanceof NothingHeld) {
          line({ stopped: 'task_finished' });
          return 0;
        }
        line({ error: err instanceof Error ? err.message : String(err) }); // 網路抖動：下一輪再試
      }
      if (ctx.args.flags.once === true) return 0;
      await new Promise((r) => setTimeout(r, every));
    }
  },

  async checkpoint(ctx) {
    const f = ctx.args.flags;
    const w = await ctx.worker();
    const r = await w.checkpoint({
      summary: str(f, 'summary') ?? '',
      next_steps: str(f, 'next') ?? str(f, 'next-steps'),
      progress: num(f, 'progress'),
      commit: str(f, 'commit'),
      artifacts: list(f, 'artifact') ?? list(f, 'artifacts'),
    });
    out(r, () => `#${r.task} 檢查點已保存（${r.progress}%），租約到 ${fmtTime(r.lease_expires_at)}`);
  },

  async submit(ctx) {
    const w = await ctx.worker();
    const r = await w.submit({ summary: str(ctx.args.flags, 'summary') ?? '', pr_url: str(ctx.args.flags, 'pr'), open_pr: ctx.args.flags['open-pr'] !== false });
    out(r, () => `#${r.task} 已交付，等待 review${r.pr_url ? `：${r.pr_url}${r.pr_created ? '（apm 開的 PR）' : ''}` : `（沒有 PR${r.pr_error ? `：${r.pr_error}` : ''}）`}`);
  },

  async block(ctx) {
    const w = await ctx.worker();
    const r = await w.block(str(ctx.args.flags, 'reason') ?? '');
    out(r, () => `#${r.task} 已標記受阻，等 PM 處理`);
  },

  async release(ctx) {
    const w = await ctx.worker();
    const reason = (str(ctx.args.flags, 'reason') ?? 'released') as InterruptReason;
    if (!['usage_limit', 'interrupted', 'released', 'error'].includes(reason)) {
      throw new UsageError('--reason 只能是 usage_limit / interrupted / released / error');
    }
    const r = await w.release(reason, str(ctx.args.flags, 'note') ?? '');
    out(r, () => `#${r.task} 已交出`);
  },

  // ───────────── PM ─────────────

  async status(ctx) {
    const r = await ctx.pm().status(ctx.args.pos[1]);
    out(r, () => {
      const lines = [`${r.hub} · ${fmtTime(r.now)}`, ''];
      if (!r.projects.length) lines.push('沒有進行中的項目');
      for (const p of r.projects) {
        const counts = Object.entries(p.counts).map(([k, v]) => `${STATE_ZH[k] ?? k} ${v}`).join('、');
        lines.push(`#${p.number} ${p.key} ${p.title}${p.status !== 'active' ? '（已結束）' : ''}`);
        lines.push(`   優先級 ${p.priority} · 配額 ${p.max_parallel ?? '不限'} · 代碼 ${p.repo} · ${counts}`);
        for (const t of p.tasks) {
          const who = t.assignee ? `${t.assignee} 租約剩 ${fmtLeft(t.lease_left_s)}` : t.expired ? `${t.last_assignee} 失聯，待接手` : t.last_assignee ? `上一位 ${t.last_assignee}` : '';
          lines.push(`   #${pad(String(t.number), 5)}${pad(t.key, 12)}${pad(STATE_ZH[t.state] ?? t.state, 10)}${pad(`${t.progress}%`, 6)}${who}${t.human_review ? ' [人工 review]' : ''}${t.pr_url ? ` ${t.pr_url}` : ''}`);
        }
        lines.push('');
      }
      if (r.workers.length) {
        lines.push('Workers');
        for (const w of r.workers) lines.push(`   ${pad(w.id, 18)}${pad(w.owner ?? '', 14)}${w.status === 'online' ? (w.current_task ? `在做 #${w.current_task}` : '閒置') : '離線'} · 最後出現 ${fmtTime(w.last_seen)}`);
      }
      return lines.join('\n');
    });
  },

  async project(ctx) {
    const [, sub, ref, ...rest] = ctx.args.pos;
    const f = ctx.args.flags;
    const pm = ctx.pm();
    if (sub === 'create') {
      const file = str(f, 'file') ?? ref;
      if (!file) throw new UsageError('用法：apm project create -f plan.json');
      const plan = JSON.parse(file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8')) as Plan;
      const r = await pm.createProject(plan, { resume: f.resume === true });
      out(r, () =>
        [`建好項目 #${r.project.number}「${r.project.title}」（${r.project.key}）：${r.project.url}`, ...r.tasks.map((t) => `   #${t.number} ${t.key} ${STATE_ZH[t.state]}`), r.skipped.length ? `   跳過已有的 ${r.skipped.length} 個任務` : '']
          .filter(Boolean)
          .join('\n'),
      );
      return;
    }
    if (!ref) throw new UsageError('用法：apm project set|member|close <項目短名或編號> …');
    if (sub === 'set') {
      const mp = str(f, 'max-parallel');
      const r = await pm.updateProject(ref, {
        priority: num(f, 'priority'),
        max_parallel: mp === undefined ? undefined : mp === 'none' || mp === 'null' ? null : Number(mp),
        repo: str(f, 'repo') === undefined ? undefined : str(f, 'repo') === 'hub' ? null : str(f, 'repo'),
        base: str(f, 'base'),
        merge_on_approve: bool(f, 'merge-on-approve'),
        merge_method: str(f, 'merge-method'),
        title: str(f, 'title'),
      });
      out(r, () => (r.changes.length ? r.changes.join('\n') : '沒有變化'));
      return;
    }
    if (sub === 'member') {
      const [login, role] = rest;
      if (!login || !role) throw new UsageError('用法：apm project member <項目> <GitHub 帳號> manager|contributor|viewer|none');
      const r = await pm.setMember(ref, login, role as ProjectRole | 'none');
      out(r, () => `${r.user} → ${r.role}${r.hint ? `\n${r.hint}` : ''}`);
      return;
    }
    if (sub === 'close') {
      const r = await pm.closeProject(ref, { cancel: f.cancel === true, note: str(f, 'note') });
      out(r, () => `項目 #${r.project} ${r.state === 'delivered' ? '已交付' : '已取消'}`);
      return;
    }
    throw new UsageError('用法：apm project create|set|member|close …');
  },

  async task(ctx) {
    const [, sub, ref] = ctx.args.pos;
    const f = ctx.args.flags;
    const pm = ctx.pm();
    if (sub === 'show') {
      const r = await pm.showTask(taskNo(ref));
      out(r, () =>
        [
          `#${r.number} ${r.title}（${r.project.key}/${r.key}）${STATE_ZH[r.state] ?? r.state} ${r.progress}% · 第 ${r.attempt} 次領取`,
          r.url,
          '',
          r.description,
          r.acceptance ? `\n驗收標準：\n${r.acceptance}` : '',
          r.result ? `\n交付：${r.result.summary}${r.result.pr_url ? `\nPR：${r.result.pr_url}` : ''}` : '',
          r.blocked_reason ? `\n受阻：${r.blocked_reason}` : '',
          r.worklog.length ? `\n接力記錄：\n${r.worklog.map((e) => `  ${fmtTime(e.at)} ${e.worker_id} ${e.kind === 'checkpoint' ? `${e.progress}% ${e.summary}` : `中斷（${e.reason}）${e.summary}`}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return;
    }
    if (sub === 'add') {
      if (!ref) throw new UsageError('用法：apm task add <項目> --key k --title "…"（或 -f task.json）');
      const file = str(f, 'file');
      const t: PlanTask = file
        ? JSON.parse(readFileSync(file, 'utf8'))
        : {
            key: str(f, 'key') ?? '',
            title: str(f, 'title') ?? '',
            description: str(f, 'desc') ?? str(f, 'description'),
            acceptance: str(f, 'acceptance'),
            caps: list(f, 'caps'),
            deps: list(f, 'deps'),
            human_review: f.human === true,
            branch: str(f, 'branch'),
          };
      const r = await pm.addTask(ref, t);
      out(r, () => `加了任務 #${r.number} ${r.key}（${STATE_ZH[r.state]}）：${r.url}`);
      return;
    }
    if (sub === 'edit') {
      const r = await pm.editTask(taskNo(ref), {
        title: str(f, 'title'),
        description: str(f, 'desc') ?? str(f, 'description'),
        acceptance: str(f, 'acceptance'),
        caps: f.caps === undefined ? undefined : (list(f, 'caps') ?? []),
        deps: f.deps === undefined ? undefined : (list(f, 'deps') ?? []),
        human_review: bool(f, 'human'),
        branch: str(f, 'branch'),
      });
      out(r, () => (r.changes.length ? r.changes.join('\n') : '沒有變化'));
      return;
    }
    if (sub === 'cancel') {
      const r = await pm.cancelTask(taskNo(ref), str(f, 'note') ?? '');
      out(r, () => `#${r.task} 已取消${r.unlocked.length ? `，解鎖了 ${r.unlocked.map((n) => `#${n}`).join('、')}` : ''}`);
      return;
    }
    throw new UsageError('用法：apm task show|add|edit|cancel …');
  },

  async review(ctx) {
    const f = ctx.args.flags;
    const n = taskNo(ctx.args.pos[1]);
    const decision = f.approve === true ? 'approve' : f.reject === true ? 'reject' : str(f, 'decision');
    if (decision !== 'approve' && decision !== 'reject') throw new UsageError('用法：apm review <編號> --approve 或 --reject --comment "意見"');
    const comment = str(f, 'comment') ?? '';
    const r = await ctx.pm().review(n, decision, comment, { human: f.human === true, merge: f.merge === false ? false : undefined });
    out(r, () =>
      r.decision === 'approve'
        ? `#${r.task} 通過${r.merged ? '，PR 已合併' : ''}${r.unlocked.length ? `；解鎖 ${r.unlocked.map((x) => `#${x}`).join('、')}` : ''}${r.delivered ? '；項目全部完成，已交付' : ''}`
        : `#${r.task} 已退回修改`,
    );
  },

  async unblock(ctx) {
    const r = await ctx.pm().unblock(taskNo(ctx.args.pos[1]), str(ctx.args.flags, 'note') ?? '');
    out(r, () => `#${r.task} 已解除阻塞（${STATE_ZH[r.state]}）`);
  },

  async revoke(ctx) {
    const r = await ctx.pm().revoke(taskNo(ctx.args.pos[1]), str(ctx.args.flags, 'note') ?? '');
    out(r, () => `已收回 #${r.task}（原來是 ${r.from} 第 ${r.attempt} 次領取）`);
  },

  async reconcile(ctx) {
    const r = await ctx.pm().reconcile({ dryRun: ctx.args.flags['dry-run'] === true, prs: ctx.args.flags.prs !== false });
    out(r, () => (r.changes.length ? r.changes.map((c) => `${c.task ? `#${c.task}` : `項目 #${c.project}`}：${c.change}`).join('\n') + (r.dry_run ? '\n（只是預覽，沒有改）' : '') : '標籤和鎖一致，沒有要改的'));
  },

  async locks(ctx) {
    const pm = ctx.pm();
    if (ctx.args.pos[1] === 'prune') {
      const r = await pm.prune({ dryRun: ctx.args.flags['dry-run'] === true });
      out(r, () => `${r.dry_run ? '會刪除' : '刪除了'} ${r.removed.length} 條已關閉任務的鎖${r.failed.length ? `；${r.failed.length} 條失敗：${r.failed[0].error}` : ''}`);
      return;
    }
    const r = await pm.locks();
    out(r, () =>
      r.length
        ? r.map((l) => `#${pad(String(l.task), 5)}${pad(l.status, 10)}${pad(l.worker, 18)}第 ${l.attempt} 次 ${l.status === 'held' ? (l.alive ? `剩 ${fmtLeft(l.expires_in_s)}` : '已過期') : ''}${l.task_open ? '' : '（任務已關閉）'}`).join('\n')
        : '沒有鎖',
    );
  },

  async invite(ctx) {
    const login = ctx.args.pos[1];
    if (!login) throw new UsageError('用法：apm invite <GitHub 帳號> [--permission push]');
    const r = await ctx.pm().invite(login, (str(ctx.args.flags, 'permission') ?? 'push') as 'push');
    out(r, () => (r.state === 'invited' ? `已邀請 ${r.user}。${r.hint}` : `${r.user} 已經是協作者，權限設為 ${r.permission}`));
  },

  async uninvite(ctx) {
    const login = ctx.args.pos[1];
    if (!login) throw new UsageError('用法：apm uninvite <GitHub 帳號>');
    const r = await ctx.pm().uninvite(login);
    out(r, () => `已移除 ${r.user}`);
  },

  async members(ctx) {
    const r = await ctx.pm().collaborators();
    out(r, () => r.map((c) => `${pad(c.login, 20)}${c.role}`).join('\n'));
  },
};

function onPath(dir: string): boolean {
  const sep = process.platform === 'win32' ? ';' : ':';
  return (process.env.PATH ?? '').split(sep).some((p) => p && resolve(p) === resolve(dir));
}

function applyWorkerFlags(cfg: LocalConfig, f: Args['flags']) {
  cfg.worker ??= {};
  const id = str(f, 'id');
  if (id) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new UsageError('worker id 只能用小寫字母、數字和連字號，例如 home-pc');
    cfg.worker.id = id;
  }
  if (str(f, 'name')) cfg.worker.name = str(f, 'name');
  if (str(f, 'machine')) cfg.worker.machine = str(f, 'machine');
  if (f.labels !== undefined) cfg.worker.labels = list(f, 'labels') ?? [];
  if (f.projects !== undefined) {
    const p = list(f, 'projects') ?? [];
    cfg.worker.projects = p.length && !(p.length === 1 && p[0] === 'all') ? p : null;
  }
  for (const spec of list(f, 'repo') ?? []) {
    const i = spec.indexOf('=');
    if (i <= 0) throw new UsageError('--repo 寫成 owner/repo=/本機/路徑');
    cfg.worker.repos = { ...cfg.worker.repos, [spec.slice(0, i)]: resolve(spec.slice(i + 1)) };
  }
}

// ───────────────────────── 入口 ─────────────────────────

function exitCode(err: unknown): number {
  if (err instanceof LeaseLost) return 3;
  if (err instanceof NothingHeld) return 2;
  return 1;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  forceJson = args.flags.json === true;
  forceText = args.flags.text === true;
  const cmd = args.pos[0] ?? 'help';
  if (args.flags.help === true || cmd === '--help') {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  const h = commands[cmd === '-v' || cmd === '--version' ? 'version' : cmd];
  if (!h) {
    process.stderr.write(`不認識的命令「${cmd}」。apm help 看全部命令\n`);
    return 1;
  }
  const ctx = makeCtx(args);
  // 記下「agent 剛剛還在動」：apm keepalive 靠它判斷 agent 有沒有死掉
  if (cmd !== 'keepalive' && cmd !== 'doctor' && cmd !== 'status' && ctx.hubName) {
    try {
      new StateFile(ctx.hubName, str(args.flags, 'worker') || process.env.APM_WORKER_ID || ctx.cfg.worker?.id || defaultWorkerId()).touch();
    } catch {
      /* 本機狀態寫不了不影響命令本身 */
    }
  }
  try {
    return (await h(ctx)) ?? 0;
  } catch (err) {
    const e = err as Error & { code?: string; detail?: unknown };
    const code = e.code ?? (err instanceof UsageError ? 'usage' : 'error');
    const body: Record<string, unknown> = { ok: false, error: code, message: e.message };
    if (err instanceof LeaseLost) {
      body.detail = err.detail;
      body.what_to_do = '立刻停手：不要再 push，不要 submit。沒推上去的改動用 git stash push -u -m "apm lease_lost #任務" 收起來，然後 apm claim 領下一個';
    }
    if (tty() && !forceJson) process.stderr.write(`錯誤：${e.message}${body.what_to_do ? `\n${body.what_to_do}` : ''}\n`);
    else process.stdout.write(JSON.stringify(body, null, 2) + '\n');
    if (process.env.APM_DEBUG) process.stderr.write(`${e.stack}\n`);
    return exitCode(err);
  }
}

const isMain = (() => {
  try {
    const a = resolve(process.argv[1] ?? '');
    return /(?:^|[\\/])(cli\.ts|apm\.mjs|apm)$/.test(a);
  } catch {
    return false;
  }
})();
// 等輸出寫完再退出（macOS 上管道是非同步的，直接 exit 會截斷 JSON）
if (isMain) main().then((c) => process.stdout.write('', () => process.exit(c)));
