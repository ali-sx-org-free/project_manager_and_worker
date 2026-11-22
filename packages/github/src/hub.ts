import type { TaskState } from '@agent-pm/core';
import { GitHub, type GitHubOptions } from './client.ts';
import { GitLockStore, type LockStore } from './locks.ts';
import { asList, asNum, parseYamlish, readBodyBlock, readCommentMeta, splitTaskBody, writeComment, type Block } from './meta.ts';

export interface RepoRef {
  owner: string;
  name: string;
}

export function parseRepo(s: string | undefined | null): RepoRef {
  const m = (s ?? '').trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`hub 倉庫要寫成 owner/repo，例如 ali-sx-org-free/agent-pm-hub（收到「${s ?? ''}」）`);
  return { owner: m[1], name: m[2] };
}
export const repoName = (r: RepoRef) => `${r.owner}/${r.name}`;

export interface HubConfig {
  /** 租約時長（分鐘）：持有者超過這麼久沒續約，別人就可以接手 */
  lease_minutes: number;
  /** 建議的續約間隔（分鐘） */
  heartbeat_minutes: number;
  /** apm keepalive 在 agent 這麼久沒有調用任何 apm 命令後停止續約（分鐘） */
  idle_minutes: number;
  /** hub 管理員（除了倉庫的 admin 之外） */
  admins: string[];
}

export const DEFAULT_CONFIG: HubConfig = { lease_minutes: 10, heartbeat_minutes: 2, idle_minutes: 30, admins: [] };

export const LABELS = {
  project: 'apm:project',
  task: 'apm:task',
  roster: 'apm:roster',
  human: 'review:human',
} as const;

/** 任務狀態對應的標籤。done 沒有標籤：任務 Issue 關閉就是完成 */
export const STATUS_LABEL: Record<TaskState, string | null> = {
  pending: 'status:pending',
  ready: 'status:ready',
  claimed: 'status:claimed',
  in_review: 'status:in-review',
  changes_requested: 'status:changes-requested',
  blocked: 'status:blocked',
  done: null,
};
const LABEL_STATE = new Map(
  Object.entries(STATUS_LABEL)
    .filter(([, l]) => l)
    .map(([s, l]) => [l as string, s as TaskState]),
);

export const LABEL_COLORS: Record<string, string> = {
  'apm:project': '5319e7',
  'apm:task': '8a63d2',
  'apm:roster': 'c5def5',
  'review:human': 'd93f0b',
  'status:pending': 'bfbfbf',
  'status:ready': '0e8a16',
  'status:claimed': 'fbca04',
  'status:in-review': '6f42c1',
  'status:changes-requested': 'e99695',
  'status:blocked': 'b60205',
};
export const labelColor = (name: string) =>
  LABEL_COLORS[name] ?? (name.startsWith('project:') ? '1d76db' : name.startsWith('cap:') ? 'ededed' : 'cccccc');

export interface ProjectInfo {
  number: number;
  /** Issue 的內部 id（加 sub-issue 要用） */
  issue_id: number;
  key: string;
  title: string;
  description: string;
  priority: number;
  max_parallel: number | null;
  /** 代碼倉庫 owner/repo；null 表示就是 hub 自己 */
  repo: string | null;
  base: string | null;
  merge_on_approve: boolean;
  kind: 'dev' | 'chore';
  managers: string[];
  contributors: string[];
  viewers: string[];
  open: boolean;
  author: string;
  created_at: number;
  closed_at: number | null;
  url: string;
  block: Block;
  rest: string;
}

export interface TaskInfo {
  number: number;
  issue_id: number;
  key: string;
  /** 所屬項目 Issue 的編號 */
  project: number;
  title: string;
  description: string;
  acceptance: string;
  caps: string[];
  /** 依賴的任務 Issue 編號 */
  deps: number[];
  /** 自訂分支；沒有就按規則生成 */
  branch: string | null;
  status: TaskState | null;
  labels: string[];
  open: boolean;
  state_reason: string | null;
  human_review: boolean;
  assignees: string[];
  author: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  url: string;
  block: Block;
  rest: string;
}

export interface CommentInfo<M = Record<string, unknown>> {
  id: number;
  issue: number;
  meta: M & { kind: string };
  text: string;
  author: string;
  created_at: number;
  updated_at: number;
  url: string;
}

interface GhIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason?: string | null;
  labels: ({ name: string } | string)[];
  assignees?: { login: string }[];
  user?: { login: string } | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  pull_request?: unknown;
}
interface GhComment {
  id: number;
  body: string | null;
  user?: { login: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  issue_url: string;
}

const ts = (s: string | null | undefined) => (s ? Date.parse(s) : 0);
const labelNames = (i: GhIssue) => i.labels.map((l) => (typeof l === 'string' ? l : l.name));

export function toProject(i: GhIssue): ProjectInfo | null {
  const { data, rest } = readBodyBlock(i.body, 'apm:project');
  const key = data?.key ? String(data.key) : labelNames(i).find((l) => l.startsWith('project:'))?.slice(8);
  if (!key) return null;
  const b = data ?? {};
  return {
    number: i.number,
    issue_id: i.id,
    key,
    title: i.title,
    description: rest,
    priority: Math.max(1, Math.min(5, asNum(b.priority, 3) ?? 3)),
    max_parallel: b.max_parallel === null || b.max_parallel === 'none' ? null : asNum(b.max_parallel, null),
    repo: b.repo ? String(b.repo) : null,
    base: b.base ? String(b.base) : null,
    merge_on_approve: b.merge_on_approve !== false,
    kind: b.kind === 'chore' ? 'chore' : 'dev',
    managers: asList(b.managers),
    contributors: asList(b.contributors),
    viewers: asList(b.viewers),
    open: i.state === 'open',
    author: i.user?.login ?? '',
    created_at: ts(i.created_at),
    closed_at: i.closed_at ? ts(i.closed_at) : null,
    url: i.html_url,
    block: b,
    rest,
  };
}

export function toTask(i: GhIssue): TaskInfo | null {
  const { data, rest } = readBodyBlock(i.body, 'apm:task');
  if (!data) return null;
  const project = asNum(data.project, null);
  if (project === null) return null;
  const labels = labelNames(i);
  const { description, acceptance } = splitTaskBody(rest);
  return {
    number: i.number,
    issue_id: i.id,
    key: String(data.key ?? `t${i.number}`),
    project,
    title: i.title,
    description,
    acceptance,
    caps: asList(data.caps),
    deps: asList(data.deps)
      .map((d) => Number(d.replace(/^#/, '')))
      .filter((n) => Number.isInteger(n)),
    branch: data.branch ? String(data.branch) : null,
    status: labels.map((l) => LABEL_STATE.get(l)).find(Boolean) ?? null,
    labels,
    open: i.state === 'open',
    state_reason: i.state_reason ?? null,
    human_review: labels.includes(LABELS.human),
    assignees: (i.assignees ?? []).map((a) => a.login),
    author: i.user?.login ?? '',
    created_at: ts(i.created_at),
    updated_at: ts(i.updated_at),
    closed_at: i.closed_at ? ts(i.closed_at) : null,
    url: i.html_url,
    block: data,
    rest,
  };
}

export function toComment(c: GhComment): CommentInfo | null {
  const parsed = readCommentMeta<{ kind: string }>(c.body);
  if (!parsed || typeof parsed.meta?.kind !== 'string') return null;
  return {
    id: c.id,
    issue: Number(c.issue_url.split('/').pop()),
    meta: parsed.meta,
    text: parsed.text,
    author: c.user?.login ?? '',
    created_at: ts(c.created_at),
    updated_at: ts(c.updated_at),
    url: c.html_url,
  };
}

export interface HubOptions extends GitHubOptions {
  repo: RepoRef | string;
  locks?: LockStore;
  /** 本機存放鎖倉庫的目錄（預設 ~/.agent-pm/git） */
  gitDir?: string;
  /** 鎖用的 git 遠端（預設 https://github.com/<hub>.git；測試時可以是本機的裸倉庫） */
  gitRemote?: string;
}

/** 一個 hub 倉庫：所有讀寫 GitHub 的地方都經過它 */
export class Hub {
  readonly gh: GitHub;
  readonly repo: RepoRef;
  readonly locks: LockStore;
  private cfg: HubConfig | null = null;
  private login: string | null = null;
  private info: { private: boolean; default_branch: string; permissions?: Record<string, boolean> } | null = null;
  private labelCache: Set<string> | null = null;

  constructor(opts: HubOptions) {
    this.repo = typeof opts.repo === 'string' ? parseRepo(opts.repo) : opts.repo;
    this.gh = new GitHub(opts);
    this.locks =
      opts.locks ??
      new GitLockStore({
        remoteUrl: opts.gitRemote ?? `https://github.com/${this.name}.git`,
        dir: `${opts.gitDir ?? `${process.env.HOME ?? process.env.USERPROFILE ?? '.'}/.agent-pm/git`}/${this.repo.owner}/${this.repo.name}.git`,
        token: opts.token,
      });
  }

  get name() {
    return repoName(this.repo);
  }
  private get base() {
    return `/repos/${this.repo.owner}/${this.repo.name}`;
  }
  now() {
    return this.gh.now();
  }

  async me(): Promise<string> {
    this.login ??= (await this.gh.get<{ login: string }>('/user')).login;
    return this.login;
  }

  async repoInfo() {
    this.info ??= await this.gh.get(`${this.base}`);
    return this.info!;
  }

  async config(): Promise<HubConfig> {
    if (this.cfg) return this.cfg;
    const f = await this.gh.getOrNull<{ content?: string; encoding?: string }>(`${this.base}/contents/.agent-pm/config.yml`);
    let b: Block = {};
    if (f?.content) {
      b = parseYamlish(Buffer.from(f.content, (f.encoding as BufferEncoding) ?? 'base64').toString('utf8'));
    }
    this.cfg = {
      lease_minutes: asNum(b.lease_minutes, DEFAULT_CONFIG.lease_minutes) ?? DEFAULT_CONFIG.lease_minutes,
      heartbeat_minutes: asNum(b.heartbeat_minutes, DEFAULT_CONFIG.heartbeat_minutes) ?? DEFAULT_CONFIG.heartbeat_minutes,
      idle_minutes: asNum(b.idle_minutes, DEFAULT_CONFIG.idle_minutes) ?? DEFAULT_CONFIG.idle_minutes,
      admins: asList(b.admins),
    };
    return this.cfg;
  }

  async leaseMs() {
    return (await this.config()).lease_minutes * 60_000;
  }

  /** 是不是 hub 管理員：倉庫的 admin，或寫在 config.yml 的 admins 裡 */
  async isAdmin(login?: string): Promise<boolean> {
    const who = login ?? (await this.me());
    if ((await this.config()).admins.includes(who)) return true;
    if (who !== (await this.me())) return false;
    return !!(await this.repoInfo()).permissions?.admin;
  }

  // ───────────── Issue ─────────────

  private async listIssues(label: string, state: 'open' | 'closed' | 'all', since?: number): Promise<GhIssue[]> {
    const q = `labels=${encodeURIComponent(label)}&state=${state}&sort=created&direction=asc${since ? `&since=${new Date(since).toISOString()}` : ''}`;
    return (await this.gh.paginate<GhIssue>(`${this.base}/issues?${q}`)).filter((i) => !i.pull_request);
  }

  async projects(state: 'open' | 'all' = 'open'): Promise<ProjectInfo[]> {
    return (await this.listIssues(LABELS.project, state)).map(toProject).filter((p): p is ProjectInfo => !!p);
  }

  async tasks(state: 'open' | 'all' = 'open', since?: number): Promise<TaskInfo[]> {
    return (await this.listIssues(LABELS.task, state, since)).map(toTask).filter((t): t is TaskInfo => !!t);
  }

  async rawIssues(label: string, state: 'open' | 'closed' | 'all', since?: number) {
    return this.listIssues(label, state, since);
  }

  async issue(n: number): Promise<GhIssue> {
    return this.gh.get<GhIssue>(`${this.base}/issues/${n}`);
  }

  async task(n: number): Promise<TaskInfo> {
    const t = toTask(await this.issue(n));
    if (!t) throw new Error(`#${n} 不是 agent-pm 的任務`);
    return t;
  }

  async project(ref: string | number): Promise<ProjectInfo> {
    const s = String(ref).replace(/^#/, '');
    if (/^\d+$/.test(s)) {
      const p = toProject(await this.issue(Number(s)));
      if (!p) throw new Error(`#${s} 不是 agent-pm 的項目`);
      return p;
    }
    const all = await this.projects('all');
    const p = all.find((x) => x.key === s && x.open) ?? all.find((x) => x.key === s);
    if (!p) throw new Error(`找不到項目「${s}」`);
    return p;
  }

  createIssue(body: { title: string; body: string; labels?: string[]; assignees?: string[] }): Promise<GhIssue> {
    return this.gh.post<GhIssue>(`${this.base}/issues`, body);
  }

  updateIssue(
    n: number,
    patch: Partial<{ title: string; body: string; labels: string[]; assignees: string[]; state: 'open' | 'closed'; state_reason: string }>,
  ): Promise<GhIssue> {
    return this.gh.patch<GhIssue>(`${this.base}/issues/${n}`, patch);
  }

  /** 換掉 status:* 標籤（只改這一個，其他標籤保留） */
  async setStatus(t: { number: number; labels: string[] }, state: TaskState, extra: Parameters<Hub['updateIssue']>[1] = {}) {
    const label = STATUS_LABEL[state];
    const labels = [...t.labels.filter((l) => !l.startsWith('status:')), ...(label ? [label] : [])];
    if (label) await this.ensureLabels([label]);
    const same = labels.length === t.labels.length && labels.every((l) => t.labels.includes(l));
    if (same && !Object.keys(extra).length) return;
    const issue = await this.updateIssue(t.number, { labels, ...extra });
    t.labels = labelNames(issue);
  }

  async addSubIssue(parent: number, childIssueId: number): Promise<boolean> {
    try {
      await this.gh.post(`${this.base}/issues/${parent}/sub_issues`, { sub_issue_id: childIssueId });
      return true;
    } catch {
      return false; // 沒有開 sub-issue 功能時只是少了進度條，不影響使用
    }
  }

  /** 名冊 Issue（每個 worker 一條留言）。還沒有就建一個 */
  async rosterIssue(): Promise<number> {
    const open = await this.rawIssues(LABELS.roster, 'open');
    if (open.length) return open[0].number;
    await this.ensureLabels([LABELS.roster]);
    const i = await this.createIssue({
      title: 'Worker 名冊',
      body: '每個 worker 在這裡有一條自己的留言（由 apm 自動維護），記錄它的能力、在做什麼、最後出現的時間。請不要手動編輯。',
      labels: [LABELS.roster],
    });
    return i.number;
  }

  // ───────────── 留言 ─────────────

  async comments(n: number): Promise<CommentInfo[]> {
    return (await this.gh.paginate<GhComment>(`${this.base}/issues/${n}/comments`))
      .map(toComment)
      .filter((c): c is CommentInfo => !!c);
  }

  /** 整個 hub 的留言（since 之後新增或編輯過的），管理端用它一次拿到所有變化 */
  async allComments(since?: number): Promise<CommentInfo[]> {
    // 按建立時間排序：分頁穩定（按更新時間排的話，翻頁途中有人編輯留言會漏掉或重複）
    const q = `sort=created&direction=asc${since ? `&since=${new Date(since).toISOString()}` : ''}`;
    return (await this.gh.paginate<GhComment>(`${this.base}/issues/comments?${q}`, 200))
      .map(toComment)
      .filter((c): c is CommentInfo => !!c);
  }

  async comment(n: number, meta: { kind: string } & Record<string, unknown>, text: string): Promise<CommentInfo> {
    const c = await this.gh.post<GhComment>(`${this.base}/issues/${n}/comments`, { body: writeComment(meta, text) });
    return toComment(c)!;
  }

  async editComment(id: number, meta: { kind: string } & Record<string, unknown>, text: string): Promise<void> {
    await this.gh.patch(`${this.base}/issues/comments/${id}`, { body: writeComment(meta, text) });
  }

  async deleteComment(id: number): Promise<void> {
    await this.gh.del(`${this.base}/issues/comments/${id}`);
  }

  /** 普通留言（不帶 apm 區塊），例如在 PR 上留退回意見 */
  async plainComment(repo: string, n: number, body: string) {
    await this.gh.post(`/repos/${repo}/issues/${n}/comments`, { body });
  }

  // ───────────── 標籤 ─────────────

  async ensureLabels(names: string[]): Promise<void> {
    if (!this.labelCache) {
      const all = await this.gh.paginate<{ name: string }>(`${this.base}/labels`);
      this.labelCache = new Set(all.map((l) => l.name));
    }
    for (const name of new Set(names)) {
      if (this.labelCache.has(name)) continue;
      try {
        await this.gh.post(`${this.base}/labels`, { name, color: labelColor(name) });
      } catch (err) {
        // 422 = 已經存在（別人剛建的），沒關係
        if (!(err instanceof Error && /already_exists|422/.test(err.message))) throw err;
      }
      this.labelCache.add(name);
    }
  }
}
