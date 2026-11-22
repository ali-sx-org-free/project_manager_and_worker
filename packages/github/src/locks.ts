import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 任務的鎖。hub 倉庫裡每個任務一條分支 `apm-lock/<Issue 編號>`，指向一個空 commit，commit 標題是這段 JSON。
 *
 *  所有寫入都是 `git push --force-with-lease=<分支>:<預期的舊值>`：GitHub 在服務器端比對分支現值，
 *  不一致就拒絕（"cannot lock ref … is at X but expected Y"）。兩個 worker 同時從同一個舊值出發，只有一個成功。
 *  這就是原來 SQLite 事務裡 `UPDATE … WHERE state IN (…)` 的作用。 */
export type LockStatus = 'held' | 'released' | 'submitted' | 'blocked' | 'revoked';

export interface LockPayload {
  v: 1;
  task: number;
  /** 項目短名，方便人看 */
  project?: string;
  worker: string;
  /** worker 的主人（GitHub 帳號） */
  owner: string;
  /** 第幾次領取 */
  attempt: number;
  status: LockStatus;
  /** 寫入時 GitHub 的時間（毫秒） */
  at: number;
  /** held 時的租約到期時間（GitHub 時間）；其他狀態為 null */
  expires_at: number | null;
  /** released 時的原因：interrupted / usage_limit / released / error */
  reason?: string;
}

export interface Lock extends LockPayload {
  sha: string;
}

export const LOCK_PREFIX = 'apm-lock/';
export const lockBranch = (task: number | string) => `${LOCK_PREFIX}${task}`;

export const isAlive = (l: Lock | undefined | null, now: number): boolean =>
  !!l && l.status === 'held' && l.expires_at !== null && l.expires_at > now;

export interface LockStore {
  /** 從遠端讀出全部的鎖（任務編號 → 鎖） */
  list(): Promise<Map<number, Lock>>;
  /** 讀一個任務的鎖（以遠端為準） */
  get(task: number): Promise<Lock | null>;
  /** 第一次領取：分支還不存在時建立。被別人搶先返回 null */
  create(payload: LockPayload): Promise<Lock | null>;
  /** 從 prevSha 往前走一步。分支已經不在 prevSha（被別人改過）返回 null */
  advance(prevSha: string, payload: LockPayload): Promise<Lock | null>;
  /** 管理員強制改寫（不比較舊值） */
  force(payload: LockPayload): Promise<Lock>;
  /** 刪掉鎖（分支仍在 expectSha 時） */
  remove(task: number, expectSha: string): Promise<boolean>;
}

export function parseLock(sha: string, subject: string): Lock | null {
  try {
    const p = JSON.parse(subject) as LockPayload;
    if (p && typeof p.task === 'number' && typeof p.worker === 'string') return { ...p, sha };
  } catch {
    /* 不是我們的格式，忽略 */
  }
  return null;
}

// ───────────────────────── 記憶體版（測試用） ─────────────────────────

export class MemoryLockStore implements LockStore {
  private refs = new Map<number, Lock>();
  private seq = 0;
  /** 測試用：每次操作前讓出事件循環，模擬網路延遲造成的交錯 */
  constructor(private jitter = 0) {}

  private async tick() {
    if (this.jitter) await new Promise((r) => setTimeout(r, Math.random() * this.jitter));
  }
  private mk(p: LockPayload): Lock {
    return { ...p, sha: `m${(++this.seq).toString(16).padStart(8, '0')}` };
  }
  async list() {
    await this.tick();
    return new Map(this.refs);
  }
  async get(task: number) {
    await this.tick();
    return this.refs.get(task) ?? null;
  }
  async create(p: LockPayload) {
    await this.tick();
    if (this.refs.has(p.task)) return null;
    const l = this.mk(p);
    this.refs.set(p.task, l);
    return l;
  }
  async advance(prevSha: string, p: LockPayload) {
    await this.tick();
    if (this.refs.get(p.task)?.sha !== prevSha) return null;
    const l = this.mk(p);
    this.refs.set(p.task, l);
    return l;
  }
  async force(p: LockPayload) {
    await this.tick();
    const l = this.mk(p);
    this.refs.set(p.task, l);
    return l;
  }
  async remove(task: number, expectSha: string) {
    await this.tick();
    if (this.refs.get(task)?.sha !== expectSha) return false;
    this.refs.delete(task);
    return true;
  }
}

// ───────────────────────── git 版 ─────────────────────────

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitLockStoreOptions {
  /** 例如 https://github.com/owner/hub.git；測試時可以是本機的裸倉庫路徑 */
  remoteUrl: string;
  /** 本機的小型裸倉庫，只存鎖的 commit */
  dir: string;
  token?: string;
}

/** 推送被拒絕是「比較並交換失敗」，不是錯誤 */
const CONFLICT_RE = /stale info|cannot lock ref|fetch first|non-fast-forward|already exists|\[rejected\]|\[remote rejected\]/i;
const AUTH_RE = /HTTP 40[13]|Permission to .* denied|Authentication failed|could not read Username|terminal prompts disabled|Repository not found/i;
const LOCAL_LOCK_RE = /Unable to create .*\.lock|cannot lock ref '?refs\/apm|could not lock config file|shallow.*lock|shallow file has changed/i;

export class GitLockStore implements LockStore {
  private ready: Promise<void> | null = null;

  constructor(private opts: GitLockStoreOptions) {}

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      GIT_AUTHOR_NAME: 'agent-pm',
      GIT_AUTHOR_EMAIL: 'agent-pm@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'agent-pm',
      GIT_COMMITTER_EMAIL: 'agent-pm@users.noreply.github.com',
    };
    // token 放在環境變量裡傳給 git（不出現在命令行參數裡，別的用戶用 ps 看不到）
    if (this.opts.token && this.opts.remoteUrl.startsWith('https://github.com/') && process.env.APM_GIT_AUTH !== 'none') {
      const basic = Buffer.from(`x-access-token:${this.opts.token}`).toString('base64');
      const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
      env.GIT_CONFIG_COUNT = String(n + 1);
      env[`GIT_CONFIG_KEY_${n}`] = 'http.https://github.com/.extraheader';
      env[`GIT_CONFIG_VALUE_${n}`] = `AUTHORIZATION: basic ${basic}`;
    }
    return env;
  }

  private git(args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const p = spawn('git', ['--git-dir', this.opts.dir, ...args], {
        env: { ...this.env(), ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('error', (err) =>
        reject(new Error(`找不到 git（${err.message}）。請先安裝 git：https://git-scm.com/downloads`)),
      );
      p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      p.stdin.on('error', () => undefined); // git 沒讀 stdin 就退出時會 EPIPE，不要緊
      if (input) p.stdin.end(input);
      else p.stdin.end();
    });
  }

  /** 本機並行的 apm 進程（例如 keepalive 和 checkpoint）可能同時改本機的 ref，碰到檔案鎖就稍等重試 */
  private async gitRetry(args: string[], input?: string, extraEnv?: NodeJS.ProcessEnv): Promise<GitResult> {
    let r: GitResult = { code: 1, stdout: '', stderr: '' };
    for (let i = 0; i < 12; i++) {
      r = await this.git(args, input, extraEnv);
      if (r.code === 0 || !LOCAL_LOCK_RE.test(r.stderr)) return r;
      await new Promise((res) => setTimeout(res, 100 + Math.random() * (200 + i * 150)));
    }
    return r;
  }

  private ensure(): Promise<void> {
    this.ready ??= (async () => {
      if (!existsSync(`${this.opts.dir}/HEAD`)) {
        mkdirSync(dirname(this.opts.dir), { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const p = spawn('git', ['init', '--bare', '-q', this.opts.dir], { stdio: 'ignore' });
          p.on('error', (err) => reject(new Error(`找不到 git（${err.message}）`)));
          p.on('close', () => resolve());
        });
      }
      await this.gitRetry(['config', 'remote.origin.url', this.opts.remoteUrl]);
      await this.git(['hash-object', '-w', '-t', 'tree', '--stdin'], '');
    })();
    return this.ready;
  }

  private fail(what: string, r: GitResult): Error {
    const text = (r.stderr || r.stdout).trim().split('\n').slice(-4).join(' / ');
    if (AUTH_RE.test(text)) {
      return new Error(`${what}失敗：沒有 hub 倉庫的推送權限，或 git 沒有登入（${text}）`);
    }
    return new Error(`${what}失敗：${text}`);
  }

  private async readLocal(): Promise<Map<number, Lock>> {
    const r = await this.git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(contents:subject)', 'refs/apm/lock/']);
    const out = new Map<number, Lock>();
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      const [ref, sha, ...rest] = line.split('\t');
      const n = Number(ref.slice('refs/apm/lock/'.length));
      if (!Number.isInteger(n)) continue;
      const l = parseLock(sha, rest.join('\t'));
      if (l) out.set(n, l);
    }
    return out;
  }

  async list(): Promise<Map<number, Lock>> {
    await this.ensure();
    const r = await this.gitRetry([
      'fetch',
      '-q',
      '--prune',
      '--no-tags',
      '--depth=1',
      'origin',
      `+refs/heads/${LOCK_PREFIX}*:refs/apm/lock/*`,
    ]);
    if (r.code !== 0) {
      // 遠端一條鎖都沒有時，帶 --depth 的 fetch 會無聲失敗：用 ls-remote 確認一下
      const ls = await this.git(['ls-remote', '--heads', 'origin', `${LOCK_PREFIX}*`]);
      if (ls.code !== 0) throw this.fail('讀取 hub 的鎖', ls.stderr ? ls : r);
      if (ls.stdout.trim()) throw this.fail('讀取 hub 的鎖', r);
      for (const n of (await this.readLocal()).keys()) await this.git(['update-ref', '-d', `refs/apm/lock/${n}`]);
      return new Map();
    }
    return this.readLocal();
  }

  async get(task: number): Promise<Lock | null> {
    await this.ensure();
    const r = await this.gitRetry([
      'fetch',
      '-q',
      '--no-tags',
      '--depth=1',
      'origin',
      `+refs/heads/${lockBranch(task)}:refs/apm/lock/${task}`,
    ]);
    if (r.code !== 0) {
      if (/couldn't find remote ref|no such ref/i.test(r.stderr)) {
        await this.git(['update-ref', '-d', `refs/apm/lock/${task}`]);
        return null;
      }
      throw this.fail('讀取鎖', r);
    }
    return (await this.readLocal()).get(task) ?? null;
  }

  private async commit(payload: LockPayload, parent?: string): Promise<string> {
    const date = `${Math.floor(payload.at / 1000)} +0000`;
    const args = ['commit-tree', EMPTY_TREE, '-m', JSON.stringify(payload)];
    if (parent) args.push('-p', parent);
    const r = await this.git(args, undefined, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    if (r.code !== 0) throw this.fail('建立鎖的 commit', r);
    return r.stdout.trim();
  }

  /** 帶「預期舊值」推送。expect 為空字串表示「分支必須還不存在」 */
  private async push(task: number, sha: string, expect: string): Promise<'ok' | 'conflict'> {
    const ref = `refs/heads/${lockBranch(task)}`;
    const r = await this.git(['push', '-q', '--porcelain', `--force-with-lease=${ref}:${expect}`, 'origin', `${sha}:${ref}`]);
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0) {
      await this.gitRetry(['update-ref', `refs/apm/lock/${task}`, sha]);
      return 'ok';
    }
    if (CONFLICT_RE.test(out) && !AUTH_RE.test(out)) return 'conflict';
    throw this.fail('寫入鎖', r);
  }

  async create(payload: LockPayload): Promise<Lock | null> {
    await this.ensure();
    const sha = await this.commit(payload);
    return (await this.push(payload.task, sha, '')) === 'ok' ? { ...payload, sha } : null;
  }

  async advance(prevSha: string, payload: LockPayload): Promise<Lock | null> {
    await this.ensure();
    const has = async () => (await this.git(['cat-file', '-e', `${prevSha}^{commit}`])).code === 0;
    if (!(await has())) {
      const cur = await this.get(payload.task);
      if (!cur || cur.sha !== prevSha || !(await has())) return null;
    }
    const sha = await this.commit(payload, prevSha);
    return (await this.push(payload.task, sha, prevSha)) === 'ok' ? { ...payload, sha } : null;
  }

  async force(payload: LockPayload): Promise<Lock> {
    await this.ensure();
    for (let i = 0; i < 4; i++) {
      const cur = await this.get(payload.task);
      const sha = await this.commit(payload, cur?.sha);
      if ((await this.push(payload.task, sha, cur?.sha ?? '')) === 'ok') return { ...payload, sha };
    }
    throw new Error(`強制改寫任務 #${payload.task} 的鎖失敗：一直有人在改它`);
  }

  async remove(task: number, expectSha: string): Promise<boolean> {
    await this.ensure();
    const ref = `refs/heads/${lockBranch(task)}`;
    const r = await this.git(['push', '-q', '--porcelain', `--force-with-lease=${ref}:${expectSha}`, 'origin', `:${ref}`]);
    if (r.code === 0) {
      await this.git(['update-ref', '-d', `refs/apm/lock/${task}`]);
      return true;
    }
    if (CONFLICT_RE.test(`${r.stdout}\n${r.stderr}`) && !AUTH_RE.test(r.stderr)) return false;
    throw this.fail('刪除鎖', r);
  }

  /** hub 還是空倉庫時，推一個初始 commit 到預設分支（設定檔和說明）。已有該分支就不動。 */
  async initBranch(branch: string, files: Record<string, string>, message: string): Promise<'created' | 'exists'> {
    await this.ensure();
    const ls = await this.git(['ls-remote', '--heads', 'origin', branch]);
    if (ls.code !== 0) throw this.fail('讀取 hub', ls);
    if (ls.stdout.trim()) return 'exists';
    // 用 mktree 從檔案建樹（只支持一層子目錄，足夠放 .agent-pm/config.yml 和 README.md）
    const dirs = new Map<string, string[]>();
    const top: string[] = [];
    for (const [path, content] of Object.entries(files)) {
      const blob = (await this.git(['hash-object', '-w', '--stdin'], content)).stdout.trim();
      const parts = path.split('/');
      if (parts.length === 1) top.push(`100644 blob ${blob}\t${path}`);
      else {
        const list = dirs.get(parts[0]) ?? [];
        list.push(`100644 blob ${blob}\t${parts.slice(1).join('/')}`);
        dirs.set(parts[0], list);
      }
    }
    for (const [d, entries] of dirs) {
      const tree = (await this.git(['mktree'], entries.join('\n') + '\n')).stdout.trim();
      top.push(`040000 tree ${tree}\t${d}`);
    }
    const tree = (await this.git(['mktree'], top.join('\n') + '\n')).stdout.trim();
    const sha = (await this.git(['commit-tree', tree, '-m', message])).stdout.trim();
    const ref = `refs/heads/${branch}`;
    const r = await this.git(['push', '-q', '--porcelain', `--force-with-lease=${ref}:`, 'origin', `${sha}:${ref}`]);
    if (r.code === 0) return 'created';
    if (CONFLICT_RE.test(`${r.stdout}\n${r.stderr}`)) return 'exists';
    throw this.fail('初始化 hub', r);
  }
}
