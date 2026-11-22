import { PmError, type ProjectRole, type TaskState } from '@agent-pm/core';
import {
  deriveSnapshot,
  deriveTask,
  depsDone,
  isManager,
  resumeOf,
  type ReviewMeta,
  type TaskView,
} from './derive.ts';
import { DEFAULT_CONFIG, LABELS, STATUS_LABEL, toProject, toTask, type Hub, type ProjectInfo, type TaskInfo } from './hub.ts';
import { isAlive, type Lock } from './locks.ts';
import { taskBody, writeBodyBlock, type Block } from './meta.ts';
import { loadModel } from './model.ts';
import { stripSha } from './worker.ts';

// ───────────────────────── 計劃（apm project create -f plan.json） ─────────────────────────

/** 和原來 create_project 的輸入一樣（docs/examples/*.json），多了代碼倉庫、合併和人工 review 幾個欄位 */
export interface PlanTask {
  key: string;
  title: string;
  description?: string;
  acceptance?: string;
  /** 需要的能力（原來叫 labels，兩個名字都認） */
  caps?: string[];
  labels?: string[];
  /** 依賴：同一個計劃裡的任務 key，或已有任務的 Issue 編號（例如 "#57"、57） */
  deps?: (string | number)[];
  /** 必須由人批准（PM agent 不能批） */
  human_review?: boolean;
  branch?: string;
}

export interface Plan {
  key?: string;
  title: string;
  description?: string;
  kind?: 'dev' | 'chore';
  priority?: number;
  max_parallel?: number | null;
  /** 代碼倉庫 owner/repo；不填就是 hub 自己 */
  repo?: string | null;
  base?: string | null;
  merge_on_approve?: boolean;
  merge_method?: 'squash' | 'merge' | 'rebase';
  managers?: string[];
  contributors?: string[];
  viewers?: string[];
  /** 原來的寫法：[{user_id, role}] */
  members?: { user_id: string; role: ProjectRole }[];
  tasks: PlanTask[];
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ROLES: ProjectRole[] = ['manager', 'contributor', 'viewer'];
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const invalid = (m: string) => new PmError('invalid', m);
const forbidden = (m: string) => new PmError('forbidden', m);
const conflict = (m: string) => new PmError('conflict', m);

function checkPriority(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw invalid('優先級 priority 必須是 1 到 5 的整數');
  return n;
}
function checkQuota(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === 'none') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw invalid('並行配額 max_parallel 必須是 0 以上的整數，或 none 表示不限');
  return n;
}
function checkRepo(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(s)) throw invalid(`代碼倉庫要寫成 owner/repo（收到「${s}」）`);
  return s;
}
function checkLogins(list: unknown, what: string): string[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw invalid(`${what} 要是 GitHub 帳號的列表`);
  const out = list.map((x) => String(x).replace(/^@/, '').trim()).filter(Boolean);
  for (const l of out) if (!LOGIN_RE.test(l)) throw invalid(`${what} 裡的「${l}」不像 GitHub 帳號`);
  return [...new Set(out)];
}
const capsOf = (t: PlanTask) => [...new Set((t.caps ?? t.labels ?? []).map((c) => String(c).trim()).filter(Boolean))];
const issueRef = (d: string | number): number | null => {
  const m = String(d).trim().match(/^#?(\d+)$/);
  return m ? Number(m[1]) : null;
};

/** 校驗計劃：欄位、key 唯一、依賴存在、有向無環。返回拓撲排序後的任務（依賴在前） */
export function validatePlan(plan: Plan): { tasks: PlanTask[]; order: PlanTask[] } {
  if (!plan || typeof plan !== 'object') throw invalid('計劃要是一個 JSON 物件');
  if (!plan.title?.trim()) throw invalid('項目需要標題 title');
  if (!Array.isArray(plan.tasks) || !plan.tasks.length) throw invalid('項目至少需要一個任務 tasks');
  if (plan.key !== undefined && !KEY_RE.test(plan.key)) {
    throw invalid('項目短名 key 只能用小寫字母、數字和連字號，最長 32 個字元，例如 site');
  }
  if (plan.kind !== undefined && plan.kind !== 'dev' && plan.kind !== 'chore') throw invalid('kind 只能是 dev 或 chore');
  checkPriority(plan.priority ?? 3);
  checkQuota(plan.max_parallel ?? null);
  checkRepo(plan.repo);
  for (const m of plan.members ?? []) {
    if (!ROLES.includes(m.role)) throw invalid(`角色只能是 ${ROLES.join(' / ')}`);
  }
  const keys = new Set<string>();
  for (const t of plan.tasks) {
    if (!t?.key || !t?.title) throw invalid('每個任務都需要 key 和 title');
    if (keys.has(t.key)) throw invalid(`任務 key 重複：${t.key}`);
    keys.add(t.key);
  }
  for (const t of plan.tasks) {
    for (const d of t.deps ?? []) {
      if (String(d) === t.key) throw invalid(`任務 ${t.key} 不能依賴自己`);
      if (!keys.has(String(d)) && issueRef(d) === null) throw invalid(`任務 ${t.key} 依賴了不存在的 ${d}`);
    }
  }
  // Kahn 拓撲排序：只看計劃內部的依賴（外部的 #編號 已經存在，不會成環）
  const inner = (t: PlanTask) => (t.deps ?? []).map(String).filter((d) => keys.has(d));
  const indeg = new Map(plan.tasks.map((t) => [t.key, inner(t).length]));
  const queue = plan.tasks.filter((t) => !inner(t).length);
  const order: PlanTask[] = [];
  while (queue.length) {
    const t = queue.shift()!;
    order.push(t);
    for (const u of plan.tasks) {
      if (inner(u).includes(t.key)) {
        const n = indeg.get(u.key)! - 1;
        indeg.set(u.key, n);
        if (n === 0) queue.push(u);
      }
    }
  }
  if (order.length !== plan.tasks.length) throw invalid('任務依賴存在環，必須是有向無環圖');
  return { tasks: plan.tasks, order };
}

// ───────────────────────── 項目設定寫回 Issue ─────────────────────────

function projectBlock(p: {
  key: string;
  priority: number;
  max_parallel: number | null;
  repo: string | null;
  base: string | null;
  merge_on_approve: boolean;
  merge_method?: string;
  kind: string;
  managers: string[];
  contributors: string[];
  viewers: string[];
}): Block {
  const b: Block = {
    key: p.key,
    priority: p.priority,
    max_parallel: p.max_parallel === null ? 'none' : p.max_parallel,
    repo: p.repo,
    base: p.base,
    merge_on_approve: p.merge_on_approve,
    kind: p.kind,
    managers: p.managers,
    contributors: p.contributors,
    viewers: p.viewers,
  };
  if (p.merge_method) b.merge_method = p.merge_method;
  return b;
}

function taskBlock(t: { key: string; project: number; deps: number[]; caps: string[]; branch?: string | null }): Block {
  const b: Block = { key: t.key, project: t.project, deps: t.deps, caps: t.caps };
  if (t.branch) b.branch = t.branch;
  return b;
}

const taskLabels = (key: string, caps: string[], human: boolean, state: TaskState) => [
  LABELS.task,
  `project:${key}`,
  STATUS_LABEL[state]!,
  ...caps.map((c) => `cap:${c}`),
  ...(human ? [LABELS.human] : []),
];

/** 把 changes 拼成一條項目 Issue 上的記錄 */
const changeNote = (by: string, changes: string[]) => `**項目設定更新** · ${by}\n\n${changes.map((c) => `- ${c}`).join('\n')}`;

// ───────────────────────── PM 的操作 ─────────────────────────

export interface InitResult {
  hub: string;
  url: string;
  private: boolean;
  created_repo: boolean;
  config: 'created' | 'exists' | 'default';
  roster: number;
  labels: number;
  notes: string[];
}

export interface ReviewResult {
  task: number;
  decision: 'approve' | 'reject';
  merged: boolean;
  pr_url: string | null;
  unlocked: number[];
  delivered: boolean;
}

export class PmOps {
  constructor(public hub: Hub) {}

  private async who() {
    const [me, admin] = await Promise.all([this.hub.me(), this.hub.isAdmin()]);
    return { me, admin };
  }

  private async mustManage(p: ProjectInfo, what: string) {
    const { me, admin } = await this.who();
    if (!isManager(p, me, admin)) {
      throw forbidden(`${me} 不是項目「${p.title}」的 manager，不能${what}。請項目負責人在項目設定裡把你加進 managers`);
    }
    return me;
  }

  // ───────────── 建 hub ─────────────

  async init(opts: { create?: boolean; description?: string } = {}): Promise<InitResult> {
    const notes: string[] = [];
    const me = await this.hub.me();
    let info = await this.hub.gh.getOrNull<{ private: boolean; html_url: string; default_branch: string; permissions?: Record<string, boolean> }>(
      `/repos/${this.hub.name}`,
    );
    let created = false;
    if (!info) {
      if (!opts.create) throw new PmError('not_found', `找不到 ${this.hub.name}。先在 GitHub 建一個私有倉庫，或加 --create 讓 apm 建`);
      const body = { name: this.hub.repo.name, private: true, has_wiki: false, description: opts.description ?? 'agent-pm hub：項目和任務都在 Issues 裡' };
      info = await this.hub.gh.post(this.hub.repo.owner === me ? '/user/repos' : `/orgs/${this.hub.repo.owner}/repos`, body);
      created = true;
    }
    if (!info!.private) {
      throw forbidden(
        `${this.hub.name} 是公開倉庫。hub 必須是私有的：任務正文會被 agent 當作指令執行，公開等於任何人都能下指令。到倉庫 Settings → General → Danger Zone 改成 Private`,
      );
    }
    if (info!.permissions && !info!.permissions.push) throw forbidden(`${me} 沒有 ${this.hub.name} 的寫入權限`);

    const base = [LABELS.project, LABELS.task, LABELS.roster, LABELS.human, ...Object.values(STATUS_LABEL).filter((l): l is string => !!l)];
    await this.hub.ensureLabels(base);

    const configText = [
      '# agent-pm hub 設定（改完 commit 就生效）',
      `# 租約時長：持有者超過這麼久沒續約，別人就可以接手`,
      `lease_minutes: ${DEFAULT_CONFIG.lease_minutes}`,
      `# apm keepalive 的續約間隔`,
      `heartbeat_minutes: ${DEFAULT_CONFIG.heartbeat_minutes}`,
      `# agent 這麼久沒調用任何 apm 命令，keepalive 就停止續約（防止死掉的 agent 一直佔著任務）`,
      `idle_minutes: ${DEFAULT_CONFIG.idle_minutes}`,
      `# 除了倉庫 admin 之外的 hub 管理員`,
      `admins: [${me}]`,
      '',
    ].join('\n');
    let config: InitResult['config'] = 'exists';
    const existing = await this.hub.gh.getOrNull(`/repos/${this.hub.name}/contents/.agent-pm/config.yml`);
    if (!existing) {
      const branches = await this.hub.gh.get<unknown[]>(`/repos/${this.hub.name}/branches?per_page=1`);
      const readme = hubReadme(this.hub.name);
      if (!branches.length) {
        // 空倉庫：用 git 推一個初始 commit（和鎖走同一條路）
        const store = this.hub.locks as { initBranch?: (b: string, f: Record<string, string>, m: string) => Promise<string> };
        if (store.initBranch) {
          await store.initBranch(info!.default_branch || 'main', { '.agent-pm/config.yml': configText, 'README.md': readme }, 'agent-pm: 初始化 hub');
          config = 'created';
        } else config = 'default';
      } else {
        try {
          await this.hub.gh.put(`/repos/${this.hub.name}/contents/.agent-pm/config.yml`, {
            message: 'agent-pm: 加上 hub 設定',
            content: Buffer.from(configText).toString('base64'),
          });
          config = 'created';
        } catch {
          config = 'default';
          notes.push('沒能寫入 .agent-pm/config.yml，先用預設設定（租約 10 分鐘）。要改的話手動在倉庫加這個檔案');
        }
      }
    }
    const roster = await this.hub.rosterIssue();
    if (!(await this.hub.isAdmin(me))) notes.push(`${me} 不是 hub 的 admin：邀請成員、強制收回要由 admin 做`);
    return { hub: this.hub.name, url: info!.html_url, private: true, created_repo: created, config, roster, labels: base.length, notes };
  }

  // ───────────── 項目 ─────────────

  async createProject(plan: Plan, opts: { resume?: boolean } = {}) {
    const { order } = validatePlan(plan);
    const me = await this.hub.me();
    const key = plan.key ?? `p-${Math.random().toString(36).slice(2, 6)}`;
    const allProjects = await this.hub.projects('all');
    let project = allProjects.find((p) => p.key === key && p.open) ?? null;
    if (project && !opts.resume) {
      throw conflict(`項目短名 ${key} 已被 #${project.number}「${project.title}」使用。是上次建到一半的話，加 --resume 補齊缺的任務`);
    }
    const members = plan.members ?? [];
    const pick = (role: ProjectRole, extra: string[] | undefined) =>
      checkLogins([...(extra ?? []), ...members.filter((m) => m.role === role).map((m) => m.user_id)], role);
    const settings = {
      key,
      priority: checkPriority(plan.priority ?? 3),
      max_parallel: checkQuota(plan.max_parallel ?? null),
      repo: checkRepo(plan.repo),
      base: plan.base?.trim() || null,
      merge_on_approve: plan.merge_on_approve !== false,
      merge_method: plan.merge_method,
      kind: plan.kind ?? 'dev',
      managers: pick('manager', plan.managers),
      contributors: pick('contributor', plan.contributors),
      viewers: pick('viewer', plan.viewers),
    };
    if (settings.repo && settings.repo !== this.hub.name) {
      const r = await this.hub.gh.getOrNull<{ permissions?: Record<string, boolean> }>(`/repos/${settings.repo}`);
      if (!r) throw invalid(`找不到代碼倉庫 ${settings.repo}，或 ${me} 沒有權限`);
    }

    const caps = new Set(plan.tasks.flatMap(capsOf));
    await this.hub.ensureLabels([
      LABELS.project,
      LABELS.task,
      `project:${key}`,
      STATUS_LABEL.ready!,
      STATUS_LABEL.pending!,
      ...[...caps].map((c) => `cap:${c}`),
      ...(plan.tasks.some((t) => t.human_review) ? [LABELS.human] : []),
    ]);

    if (!project) {
      const issue = await this.hub.createIssue({
        title: plan.title.trim(),
        body: writeBodyBlock(plan.description ?? '', 'apm:project', projectBlock(settings)),
        labels: [LABELS.project, `project:${key}`],
      });
      project = toProject(issue)!;
    }

    // 已有的任務（--resume 時跳過）
    const existing = opts.resume ? (await this.hub.tasks('all')).filter((t) => t.project === project!.number) : [];
    const numberOf = new Map(existing.map((t) => [t.key, t.number]));
    const openNow = new Set((await this.hub.tasks('open')).map((t) => t.number));
    const created: { key: string; number: number; url: string; state: TaskState }[] = [];
    for (const t of order) {
      if (numberOf.has(t.key)) continue;
      const deps = (t.deps ?? []).map((d) => numberOf.get(String(d)) ?? issueRef(d)!);
      for (const d of deps) {
        if (!numberOf.has(String(d)) && ![...numberOf.values()].includes(d)) {
          // 外部依賴：要是已有的任務
          const ext = await this.hub.issue(d).catch(() => null);
          if (!ext || !toTask(ext)) throw invalid(`任務 ${t.key} 依賴的 #${d} 不是 agent-pm 的任務`);
          if (ext.state === 'open') openNow.add(d);
        }
      }
      const state: TaskState = deps.some((d) => openNow.has(d)) ? 'pending' : 'ready';
      const tc = capsOf(t);
      const issue = await this.hub.createIssue({
        title: t.title.trim(),
        body: writeBodyBlock(taskBody(t.description ?? '', t.acceptance ?? ''), 'apm:task', taskBlock({ key: t.key, project: project.number, deps, caps: tc, branch: t.branch })),
        labels: taskLabels(key, tc, !!t.human_review, state),
      });
      numberOf.set(t.key, issue.number);
      openNow.add(issue.number);
      created.push({ key: t.key, number: issue.number, url: issue.html_url, state });
      await this.hub.addSubIssue(project.number, issue.id);
    }
    return {
      project: { number: project.number, key, title: project.title, url: project.url },
      tasks: created,
      skipped: existing.map((t) => ({ key: t.key, number: t.number })),
    };
  }

  async updateProject(
    ref: string | number,
    patch: Partial<{
      priority: number;
      max_parallel: number | null | 'none';
      repo: string | null;
      base: string | null;
      merge_on_approve: boolean;
      merge_method: string;
      title: string;
    }>,
  ) {
    const p = await this.hub.project(ref);
    const me = await this.mustManage(p, '改項目設定');
    const next = {
      key: p.key,
      priority: p.priority,
      max_parallel: p.max_parallel,
      repo: p.repo,
      base: p.base,
      merge_on_approve: p.merge_on_approve,
      merge_method: p.block.merge_method ? String(p.block.merge_method) : undefined,
      kind: p.kind,
      managers: p.managers,
      contributors: p.contributors,
      viewers: p.viewers,
    };
    const changes: string[] = [];
    if (patch.priority !== undefined) {
      const v = checkPriority(patch.priority);
      if (v !== p.priority) changes.push(`優先級 ${p.priority} → ${v}`);
      next.priority = v;
    }
    if (patch.max_parallel !== undefined) {
      const v = checkQuota(patch.max_parallel);
      if (v !== p.max_parallel) changes.push(`並行配額 ${p.max_parallel ?? '不限'} → ${v ?? '不限'}`);
      next.max_parallel = v;
    }
    if (patch.repo !== undefined) {
      const v = checkRepo(patch.repo);
      if (v !== p.repo) changes.push(`代碼倉庫 ${p.repo ?? '（hub）'} → ${v ?? '（hub）'}`);
      next.repo = v;
    }
    if (patch.base !== undefined) {
      const v = patch.base?.trim() || null;
      if (v !== p.base) changes.push(`基礎分支 ${p.base ?? '（預設）'} → ${v ?? '（預設）'}`);
      next.base = v;
    }
    if (patch.merge_on_approve !== undefined && patch.merge_on_approve !== p.merge_on_approve) {
      changes.push(`批准時合併 PR：${p.merge_on_approve ? '是' : '否'} → ${patch.merge_on_approve ? '是' : '否'}`);
      next.merge_on_approve = patch.merge_on_approve;
    }
    if (patch.merge_method !== undefined) {
      if (!['squash', 'merge', 'rebase'].includes(patch.merge_method)) throw invalid('merge_method 只能是 squash / merge / rebase');
      if (patch.merge_method !== next.merge_method) changes.push(`合併方式 ${next.merge_method ?? 'squash'} → ${patch.merge_method}`);
      next.merge_method = patch.merge_method;
    }
    const title = patch.title?.trim();
    if (title && title !== p.title) changes.push(`標題「${p.title}」→「${title}」`);
    if (!changes.length) return { project: p.number, changes };
    await this.hub.updateIssue(p.number, {
      ...(title ? { title } : {}),
      body: writeBodyBlock(p.rest, 'apm:project', projectBlock(next)),
    });
    await this.hub.comment(p.number, { kind: 'project_updated', by: me, changes, at: this.hub.now() }, changeNote(me, changes));
    return { project: p.number, changes };
  }

  async setMember(ref: string | number, login: string, role: ProjectRole | 'none') {
    const p = await this.hub.project(ref);
    const me = await this.mustManage(p, '改成員');
    const user = checkLogins([login], '帳號')[0];
    if (!user) throw invalid('需要 GitHub 帳號');
    if (role !== 'none' && !ROLES.includes(role)) throw invalid(`角色只能是 ${ROLES.join(' / ')} 或 none（移除）`);
    const lists = {
      managers: p.managers.filter((u) => u !== user),
      contributors: p.contributors.filter((u) => u !== user),
      viewers: p.viewers.filter((u) => u !== user),
    };
    if (role === 'manager') lists.managers.push(user);
    if (role === 'contributor') lists.contributors.push(user);
    if (role === 'viewer') lists.viewers.push(user);
    if (role === 'none' && p.author === user) throw invalid(`${user} 是項目建立者，一直是 manager`);
    await this.hub.updateIssue(p.number, {
      body: writeBodyBlock(
        p.rest,
        'apm:project',
        projectBlock({
          key: p.key,
          priority: p.priority,
          max_parallel: p.max_parallel,
          repo: p.repo,
          base: p.base,
          merge_on_approve: p.merge_on_approve,
          merge_method: p.block.merge_method ? String(p.block.merge_method) : undefined,
          kind: p.kind,
          ...lists,
        }),
      ),
    });
    const change = role === 'none' ? `移除成員 ${user}` : `${user} 的角色設為 ${role}`;
    await this.hub.comment(p.number, { kind: 'project_updated', by: me, changes: [change], at: this.hub.now() }, changeNote(me, [change]));
    let collaborator: boolean | null = null;
    try {
      await this.hub.gh.get(`/repos/${this.hub.name}/collaborators/${user}`);
      collaborator = true;
    } catch {
      collaborator = role === 'none' ? null : false;
    }
    return {
      project: p.number,
      user,
      role,
      hint: collaborator === false ? `${user} 還不是 hub 的協作者，請管理員邀請：apm invite ${user}` : undefined,
    };
  }

  /** 交付（所有任務都關了）或取消（--cancel：剩下的任務一起以 not planned 關閉） */
  async closeProject(ref: string | number, opts: { cancel?: boolean; note?: string } = {}) {
    const p = await this.hub.project(ref);
    const me = await this.mustManage(p, '關閉項目');
    const open = (await this.hub.tasks('open')).filter((t) => t.project === p.number);
    if (open.length && !opts.cancel) {
      throw conflict(`項目還有 ${open.length} 個任務沒完成（${open.map((t) => `#${t.number}`).join('、')}）。要放棄它們就加 --cancel`);
    }
    for (const t of open) await this.hub.updateIssue(t.number, { state: 'closed', state_reason: 'not_planned' });
    await this.deliver(p, me, opts.cancel ? 'not_planned' : 'completed', opts.note);
    return { project: p.number, cancelled_tasks: open.map((t) => t.number), state: opts.cancel ? 'cancelled' : 'delivered' };
  }

  private async deliver(p: ProjectInfo, by: string, reason: 'completed' | 'not_planned', note?: string) {
    await this.hub.comment(
      p.number,
      { kind: reason === 'completed' ? 'delivered' : 'cancelled', by, at: this.hub.now() },
      reason === 'completed' ? `**項目交付** · ${by}${note ? `\n\n${note}` : '\n\n所有任務都已完成。'}` : `**項目取消** · ${by}${note ? `\n\n${note}` : ''}`,
    );
    await this.hub.updateIssue(p.number, { state: 'closed', state_reason: reason });
  }

  // ───────────── 看狀態 ─────────────

  async status(ref?: string | number) {
    const model = await loadModel(this.hub);
    const now = this.hub.now();
    const snap = deriveSnapshot(model, now);
    let projects = snap.projects;
    if (ref !== undefined) {
      const p = await this.hub.project(ref);
      projects = projects.filter((x) => x.number === p.number);
    } else projects = projects.filter((p) => p.status === 'active');
    const ids = new Set(projects.map((p) => p.id));
    const tasks = snap.tasks.filter((t) => ids.has(t.project_id));
    return {
      hub: this.hub.name,
      now,
      projects: projects.map((p) => {
        const mine = tasks.filter((t) => t.project_id === p.id);
        const counts: Partial<Record<TaskState, number>> = {};
        for (const t of mine) counts[t.state] = (counts[t.state] ?? 0) + 1;
        const info = model.projects.find((x) => x.number === p.number)!;
        return {
          number: p.number,
          key: p.key,
          title: p.title,
          url: p.url,
          status: p.status,
          priority: p.priority,
          max_parallel: p.max_parallel,
          repo: p.repo ?? this.hub.name,
          merge_on_approve: p.merge_on_approve,
          managers: [...new Set([info.author, ...info.managers])],
          contributors: info.contributors,
          counts,
          tasks: mine.map((t) => taskRow(t, now)),
        };
      }),
      workers: snap.workers.map((w) => ({ id: w.id, owner: w.owner, status: w.status, current_task: w.current_task ? Number(w.current_task) : null, labels: w.labels, last_seen: w.last_seen })),
    };
  }

  async showTask(n: number) {
    const t = await this.hub.task(n);
    const p = await this.hub.project(t.project);
    const [comments, lock, open] = await Promise.all([this.hub.comments(n), this.hub.locks.get(n), this.hub.tasks('open')]);
    const now = this.hub.now();
    const view = deriveTask(t, p.key, comments, lock, now, depsDone(t, new Set(open.map((x) => x.number))));
    return {
      ...taskRow(view, now),
      project: { number: p.number, key: p.key, title: p.title },
      description: view.description,
      acceptance: view.acceptance,
      deps: t.deps,
      caps: t.caps,
      branch: view.branch,
      repo: p.repo ?? this.hub.name,
      result: view.result,
      reviews: view.reviews,
      blocked_reason: view.blocked_reason,
      resume: resumeOf({ ...view, state: view.state === 'claimed' ? 'ready' : view.state }),
      lock: lock ? { ...stripSha(lock), alive: isAlive(lock, now) } : null,
      worklog: view.worklog,
    };
  }

  // ───────────── 重新拆解 ─────────────

  async addTask(ref: string | number, t: PlanTask) {
    const p = await this.hub.project(ref);
    if (!p.open) throw conflict(`項目「${p.title}」已經關閉`);
    await this.mustManage(p, '加任務');
    if (!t?.key || !t?.title) throw invalid('任務需要 key 和 title');
    const all = await this.hub.tasks('all');
    const siblings = all.filter((x) => x.project === p.number);
    if (siblings.some((x) => x.key === t.key && !(x.state_reason === 'not_planned' && !x.open))) {
      throw conflict(`項目裡已經有 key 為 ${t.key} 的任務`);
    }
    const deps = this.resolveDeps(t.deps ?? [], siblings, all, t.key);
    const open = new Set(all.filter((x) => x.open).map((x) => x.number));
    const state: TaskState = deps.some((d) => open.has(d)) ? 'pending' : 'ready';
    const caps = capsOf(t);
    const labels = taskLabels(p.key, caps, !!t.human_review, state);
    await this.hub.ensureLabels(labels);
    const issue = await this.hub.createIssue({
      title: t.title.trim(),
      body: writeBodyBlock(taskBody(t.description ?? '', t.acceptance ?? ''), 'apm:task', taskBlock({ key: t.key, project: p.number, deps, caps, branch: t.branch })),
      labels,
    });
    await this.hub.addSubIssue(p.number, issue.id);
    return { number: issue.number, key: t.key, url: issue.html_url, state, deps };
  }

  private resolveDeps(deps: (string | number)[], siblings: TaskInfo[], all: TaskInfo[], self: string): number[] {
    const out: number[] = [];
    for (const d of deps) {
      const byKey = siblings.find((x) => x.key === String(d));
      const n = byKey?.number ?? issueRef(d);
      if (n === null || n === undefined || !all.some((x) => x.number === n)) throw invalid(`依賴「${d}」找不到：寫同項目任務的 key，或任務的 Issue 編號`);
      if (String(d) === self) throw invalid('任務不能依賴自己');
      out.push(n);
    }
    return [...new Set(out)];
  }

  async editTask(
    n: number,
    patch: Partial<{ title: string; description: string; acceptance: string; caps: string[]; deps: (string | number)[]; human_review: boolean; branch: string | null }>,
  ) {
    const t = await this.hub.task(n);
    const p = await this.hub.project(t.project);
    await this.mustManage(p, '改任務');
    if (!t.open) throw conflict(`任務 #${n} 已經關閉`);
    const all = await this.hub.tasks('all');
    const changes: string[] = [];
    let deps = t.deps;
    if (patch.deps !== undefined) {
      deps = this.resolveDeps(patch.deps, all.filter((x) => x.project === p.number), all, t.key);
      if (deps.includes(n)) throw invalid('任務不能依賴自己');
      // 加了這些依賴以後會不會成環：從新依賴往上走，走回自己就是環
      const graph = new Map(all.map((x) => [x.number, x.number === n ? deps : x.deps]));
      const seen = new Set<number>();
      const stack = [...deps];
      while (stack.length) {
        const k = stack.pop()!;
        if (k === n) throw invalid('這樣改會讓任務依賴成環');
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push(...(graph.get(k) ?? []));
      }
      changes.push(`依賴 ${t.deps.map((d) => `#${d}`).join('、') || '（無）'} → ${deps.map((d) => `#${d}`).join('、') || '（無）'}`);
    }
    const caps = patch.caps !== undefined ? [...new Set(patch.caps.map((c) => c.trim()).filter(Boolean))] : t.caps;
    if (patch.caps !== undefined) changes.push(`能力 ${t.caps.join('、') || '（無）'} → ${caps.join('、') || '（無）'}`);
    const human = patch.human_review ?? t.human_review;
    if (patch.human_review !== undefined && patch.human_review !== t.human_review) changes.push(human ? '改成必須由人批准' : '不再要求由人批准');
    const description = patch.description ?? t.description;
    const acceptance = patch.acceptance ?? t.acceptance;
    if (patch.description !== undefined) changes.push('改了說明');
    if (patch.acceptance !== undefined) changes.push('改了驗收標準');
    if (patch.title !== undefined) changes.push(`標題 → ${patch.title}`);
    const branch = patch.branch === undefined ? t.branch : patch.branch;
    if (patch.branch !== undefined) changes.push(`分支 → ${branch ?? '（按規則生成）'}`);
    if (!changes.length) return { task: n, changes };

    const open = new Set(all.filter((x) => x.open).map((x) => x.number));
    let labels = t.labels.filter((l) => !l.startsWith('cap:') && l !== LABELS.human);
    labels.push(...caps.map((c) => `cap:${c}`));
    if (human) labels.push(LABELS.human);
    if (t.status === 'pending' || t.status === 'ready') {
      const st = deps.some((d) => open.has(d)) ? 'pending' : 'ready';
      labels = [...labels.filter((l) => !l.startsWith('status:')), STATUS_LABEL[st]!];
    }
    await this.hub.ensureLabels(labels);
    await this.hub.updateIssue(n, {
      ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
      body: writeBodyBlock(taskBody(description, acceptance), 'apm:task', taskBlock({ key: t.key, project: p.number, deps, caps, branch })),
      labels,
    });
    return { task: n, changes };
  }

  /** 取消一個任務（以 not planned 關閉）。依賴它的任務會被當作依賴已滿足 */
  async cancelTask(n: number, note = '') {
    const t = await this.hub.task(n);
    const p = await this.hub.project(t.project);
    const me = await this.mustManage(p, '取消任務');
    const lock = await this.hub.locks.get(n);
    if (lock && isAlive(lock, this.hub.now())) {
      await this.hub.locks.force({ ...stripSha(lock), status: 'revoked', at: this.hub.now(), expires_at: null, reason: 'cancelled' });
    }
    await this.hub.comment(n, { kind: 'cancelled', by: me, note, at: this.hub.now() }, `**任務取消** · ${me}${note ? `\n\n${note}` : ''}`);
    await this.hub.setStatus(t, 'done', { state: 'closed', state_reason: 'not_planned' });
    const unlocked = await this.unlockDependents(n);
    return { task: n, unlocked };
  }

  // ───────────── review、解除阻塞、收回 ─────────────

  private async viewOf(n: number) {
    const t = await this.hub.task(n);
    const p = await this.hub.project(t.project);
    const [comments, lock] = await Promise.all([this.hub.comments(n), this.hub.locks.get(n)]);
    const view = deriveTask(t, p.key, comments, lock, this.hub.now(), true);
    return { t, p, view, lock };
  }

  async review(
    n: number,
    decision: 'approve' | 'reject',
    comment = '',
    opts: { human?: boolean; merge?: boolean; reviewer?: string; viaGitHub?: boolean } = {},
  ): Promise<ReviewResult> {
    const { t, p, view } = await this.viewOf(n);
    const me = opts.reviewer ?? (await this.mustManage(p, 'review'));
    if (view.state !== 'in_review') throw conflict(`任務 #${n} 現在是 ${view.state}，只有 in_review（已交付）的任務能 review`);
    if (decision === 'reject' && !comment.trim()) throw invalid('退回要寫意見（--comment）：哪條驗收標準沒達到、要怎麼改');
    if (decision === 'approve' && t.human_review && !opts.human && !opts.viaGitHub) {
      throw forbidden(`任務 #${n} 帶 review:human 標籤，必須由人批准。PM agent 請把意見整理給人看；人確認過了再加 --human`);
    }
    const pr = view.result?.pr_url ?? null;
    let merged = false;
    if (decision === 'approve' && pr && p.merge_on_approve && opts.merge !== false) {
      merged = await this.mergePr(pr, p);
    }
    const meta: ReviewMeta = { kind: 'review', reviewer: me, decision, comment: comment.trim(), at: this.hub.now(), merged: merged || undefined };
    await this.hub.comment(
      n,
      meta as unknown as ReviewMeta & Record<string, unknown>,
      decision === 'approve'
        ? `**通過** · ${me}${merged ? '，PR 已合併' : ''}${comment.trim() ? `\n\n${comment.trim()}` : ''}`
        : `**退回修改** · ${me}\n\n${comment.trim()}`,
    );
    if (decision === 'reject') {
      await this.hub.setStatus(t, 'changes_requested');
      if (pr && !opts.viaGitHub) {
        const m = pr.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
        if (m) await this.hub.plainComment(m[1], Number(m[2]), `**退回修改**（agent-pm，${me}）\n\n${comment.trim()}\n\n任務：${this.hub.name}#${n}`).catch(() => undefined);
      }
      return { task: n, decision, merged: false, pr_url: pr, unlocked: [], delivered: false };
    }
    await this.hub.setStatus(t, 'done', { state: 'closed', state_reason: 'completed' });
    const unlocked = await this.unlockDependents(n);
    let delivered = false;
    const left = (await this.hub.tasks('open')).filter((x) => x.project === p.number && x.number !== n);
    if (!left.length) {
      await this.deliver(p, me, 'completed');
      delivered = true;
    }
    return { task: n, decision, merged, pr_url: pr, unlocked, delivered };
  }

  /** 上游完成後，依賴都齊了的下游從 pending 改成 ready（狀態推導本來就會這樣算，這裡是讓標籤跟上） */
  private async unlockDependents(done: number): Promise<number[]> {
    const open = await this.hub.tasks('open');
    const openSet = new Set(open.map((x) => x.number));
    openSet.delete(done);
    const out: number[] = [];
    for (const d of open) {
      if (!d.deps.includes(done) || !depsDone(d, openSet)) continue;
      if (d.status === 'pending' || d.status === null) {
        await this.hub.setStatus(d, 'ready');
        out.push(d.number);
      }
    }
    return out;
  }

  private async mergePr(url: string, p: ProjectInfo): Promise<boolean> {
    const m = url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
    if (!m) return false;
    const [, repo, num] = m;
    const pr = await this.hub.gh.get<{ merged: boolean; state: string; mergeable: boolean | null; title: string; head: { sha: string } }>(`/repos/${repo}/pulls/${num}`);
    if (pr.merged) return true;
    if (pr.state === 'closed') throw conflict(`PR ${url} 已經關閉但沒有合併。重新打開它，或加 --no-merge 只關閉任務`);
    const preferred = String(p.block.merge_method ?? 'squash');
    const methods = [preferred, ...['squash', 'merge', 'rebase'].filter((x) => x !== preferred)];
    let last = '';
    for (const merge_method of methods) {
      try {
        await this.hub.gh.put(`/repos/${repo}/pulls/${num}/merge`, { merge_method, sha: pr.head.sha, commit_title: `${pr.title} (#${num})` });
        return true;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
        if (!/not allowed|merge method/i.test(last)) break;
      }
    }
    throw conflict(`PR ${url} 合併失敗：${last}。有衝突或檢查沒過的話，先 reject 讓 worker 處理；只想關閉任務就加 --no-merge`);
  }

  async unblock(n: number, note = '') {
    const { t, p, view } = await this.viewOf(n);
    const me = await this.mustManage(p, '解除阻塞');
    if (view.state !== 'blocked') throw conflict(`任務 #${n} 現在是 ${view.state}，不是 blocked`);
    await this.hub.comment(n, { kind: 'unblocked', by: me, note: note.trim(), at: this.hub.now() }, `**解除阻塞** · ${me}${note.trim() ? `\n\n${note.trim()}` : ''}`);
    const open = new Set((await this.hub.tasks('open')).map((x) => x.number));
    await this.hub.setStatus(t, depsDone(t, open) ? 'ready' : 'pending');
    return { task: n, state: depsDone(t, open) ? 'ready' : 'pending' };
  }

  /** 管理員或 manager 強制收回一個正在執行的任務。持有者下一次續約會收到 lease_lost */
  async revoke(n: number, note = '') {
    const { t, p, lock } = await this.viewOf(n);
    const me = await this.mustManage(p, '收回任務');
    if (!lock || lock.status !== 'held') throw conflict(`任務 #${n} 沒有人在做`);
    const now = this.hub.now();
    await this.hub.locks.force({ ...stripSha(lock), status: 'revoked', at: now, expires_at: null, reason: 'revoked' });
    await this.hub.comment(
      n,
      { kind: 'revoked', by: me, attempt: lock.attempt, worker: lock.worker, note: note.trim(), at: now },
      `**收回任務** · ${me} 收回了 ${lock.worker}（第 ${lock.attempt} 次領取）手上的任務${note.trim() ? `\n\n${note.trim()}` : ''}`,
    );
    await this.hub.setStatus(t, 'ready');
    return { task: n, from: lock.worker, attempt: lock.attempt };
  }

  // ───────────── 對齊、鎖、成員 ─────────────

  /** 讓標籤跟上鎖和 Issue 開關；讀 PR 的狀態補上在 GitHub 網頁上做的 review；全部完成的項目交付 */
  async reconcile(opts: { dryRun?: boolean; prs?: boolean } = {}) {
    const model = await loadModel(this.hub);
    const now = this.hub.now();
    const snap = deriveSnapshot(model, now);
    const byNumber = new Map(model.tasks.map((t) => [t.number, t]));
    const changes: { task?: number; project?: number; change: string }[] = [];
    for (const v of snap.tasks) {
      const t = byNumber.get(v.number)!;
      if (!t.open) continue;
      const want = STATUS_LABEL[v.state];
      const has = t.labels.filter((l) => l.startsWith('status:'));
      if (want && !(has.length === 1 && has[0] === want)) {
        changes.push({ task: t.number, change: `標籤 ${has.join(',') || '（無）'} → ${want}` });
        if (!opts.dryRun) await this.hub.setStatus(t, v.state);
      }
    }
    // 在 GitHub 網頁上合併或 Request changes 的 PR
    if (opts.prs !== false) {
      for (const v of snap.tasks) {
        if (v.state !== 'in_review' || !v.result?.pr_url) continue;
        const p = model.projects.find((x) => x.number === Number(v.project_id));
        if (!p) continue;
        const outcome = await this.prOutcome(v, p, model.admins);
        if (!outcome) continue;
        changes.push({ task: v.number, change: `PR 上的 review：${outcome.decision === 'approve' ? '已批准/合併' : '要求修改'}（${outcome.by}）` });
        if (!opts.dryRun) {
          await this.review(v.number, outcome.decision, outcome.comment, { reviewer: outcome.by, viaGitHub: true, merge: outcome.merged ? false : undefined }).catch(
            (err) => changes.push({ task: v.number, change: `沒能套用：${err instanceof Error ? err.message : err}` }),
          );
        }
      }
    }
    // 所有任務都關了但項目還開著
    if (!opts.dryRun) {
      const open = await this.hub.tasks('open');
      for (const p of await this.hub.projects('open')) {
        const has = model.tasks.some((t) => t.project === p.number);
        if (has && !open.some((t) => t.project === p.number)) {
          changes.push({ project: p.number, change: '所有任務都完成了，交付項目' });
          await this.deliver(p, await this.hub.me(), 'completed');
        }
      }
    }
    // 名冊裡過期的「正在做」不用改：推導時以鎖為準
    return { changes, dry_run: !!opts.dryRun };
  }

  private async prOutcome(v: TaskView, p: ProjectInfo, admins: string[]): Promise<{ decision: 'approve' | 'reject'; by: string; comment: string; merged: boolean } | null> {
    const m = v.result!.pr_url!.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
    if (!m) return null;
    const [, repo, num] = m;
    const pr = await this.hub.gh.getOrNull<{ merged: boolean; merged_by?: { login: string } | null }>(`/repos/${repo}/pulls/${num}`);
    if (!pr) return null;
    if (pr.merged) return { decision: 'approve', by: pr.merged_by?.login ?? 'github', comment: 'PR 已在 GitHub 上合併', merged: true };
    const reviews = await this.hub.gh.get<{ user: { login: string } | null; state: string; body: string; submitted_at: string }[]>(
      `/repos/${repo}/pulls/${num}/reviews?per_page=100`,
    );
    const since = v.result!.submitted_at;
    const relevant = reviews
      .filter((r) => r.user && Date.parse(r.submitted_at) > since && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED'))
      .filter((r) => isManager(p, r.user!.login, admins.includes(r.user!.login)));
    const last = relevant.at(-1);
    if (!last) return null;
    return {
      decision: last.state === 'APPROVED' ? 'approve' : 'reject',
      by: last.user!.login,
      comment: last.body?.trim() || (last.state === 'APPROVED' ? '在 GitHub 上批准' : '在 GitHub 上要求修改，見 PR'),
      merged: false,
    };
  }

  async locks() {
    const [locks, tasks] = await Promise.all([this.hub.locks.list(), this.hub.tasks('all')]);
    const now = this.hub.now();
    const byNumber = new Map(tasks.map((t) => [t.number, t]));
    return [...locks.values()]
      .sort((a, b) => a.task - b.task)
      .map((l) => {
        const t = byNumber.get(l.task);
        return {
          task: l.task,
          title: t?.title ?? null,
          task_open: t?.open ?? false,
          worker: l.worker,
          owner: l.owner,
          attempt: l.attempt,
          status: l.status,
          alive: isAlive(l, now),
          expires_in_s: l.status === 'held' && l.expires_at ? Math.round((l.expires_at - now) / 1000) : null,
          at: l.at,
          sha: l.sha,
        };
      });
  }

  /** 刪掉已關閉任務的鎖分支 */
  async prune(opts: { dryRun?: boolean } = {}) {
    const { me, admin } = await this.who();
    if (!admin) throw forbidden(`${me} 不是 hub 管理員，不能清理鎖`);
    const [locks, open] = await Promise.all([this.hub.locks.list(), this.hub.tasks('open')]);
    const openSet = new Set(open.map((t) => t.number));
    const removed: number[] = [];
    const failed: { task: number; error: string }[] = [];
    for (const l of locks.values()) {
      if (openSet.has(l.task)) continue;
      if (opts.dryRun) {
        removed.push(l.task);
        continue;
      }
      try {
        if (await this.hub.locks.remove(l.task, l.sha)) removed.push(l.task);
      } catch (err) {
        failed.push({ task: l.task, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { removed, failed, dry_run: !!opts.dryRun };
  }

  async invite(login: string, permission: 'push' | 'triage' | 'maintain' | 'admin' | 'pull' = 'push') {
    const user = checkLogins([login], '帳號')[0];
    const { me, admin } = await this.who();
    if (!admin) throw forbidden(`${me} 不是 hub 管理員，不能邀請成員`);
    const r = await this.hub.gh.request('PUT', `/repos/${this.hub.name}/collaborators/${user}`, { permission });
    return { user, permission, state: r.status === 201 ? 'invited' : 'already_member', hint: r.status === 201 ? `請 ${user} 到 https://github.com/${this.hub.name}/invitations 接受邀請` : undefined };
  }

  async uninvite(login: string) {
    const user = checkLogins([login], '帳號')[0];
    const { me, admin } = await this.who();
    if (!admin) throw forbidden(`${me} 不是 hub 管理員`);
    await this.hub.gh.del(`/repos/${this.hub.name}/collaborators/${user}`);
    return { user, removed: true };
  }

  async collaborators() {
    const list = await this.hub.gh.paginate<{ login: string; role_name?: string; permissions?: Record<string, boolean> }>(
      `/repos/${this.hub.name}/collaborators?affiliation=all`,
    );
    return list.map((c) => ({ login: c.login, role: c.role_name ?? (c.permissions?.admin ? 'admin' : c.permissions?.push ? 'write' : 'read') }));
  }
}

function taskRow(t: TaskView, now: number) {
  return {
    number: t.number,
    key: t.key,
    title: t.title,
    url: t.url,
    state: t.state,
    expired: t.expired,
    assignee: t.assignee,
    last_assignee: t.last_assignee,
    attempt: t.attempt,
    progress: t.progress,
    lease_left_s: t.lease_expires_at ? Math.round((t.lease_expires_at - now) / 1000) : null,
    human_review: t.human_review,
    pr_url: t.result?.pr_url ?? null,
  };
}

export function hubReadme(hub: string): string {
  return `# agent-pm hub

這個私有倉庫是 agent-pm 的「中間層」：項目和任務都是這裡的 Issue，任務的領取鎖是 \`apm-lock/*\` 分支。
不需要任何服務器。

- 項目：帶 \`apm:project\` 標籤的 Issue，任務是它的 sub-issue
- 任務：帶 \`apm:task\` 標籤的 Issue；狀態看 \`status:*\` 標籤，關閉 = 完成
- 接力記錄：任務 Issue 的留言
- Worker 名冊：帶 \`apm:roster\` 標籤的 Issue
- 設定：\`.agent-pm/config.yml\`

## 怎麼加入

1. 請 hub 管理員邀請你成為協作者（Write），到 https://github.com/${hub}/invitations 接受
2. 安裝 GitHub CLI 並登入：\`gh auth login\`
3. 在 Claude Code 裡安裝插件：
   \`\`\`
   /plugin marketplace add ali-sx-org-free/project_manager_and_worker
   /plugin install agent-pm@agent-pm
   \`\`\`
4. 告訴 agent：「用 agent-pm 加入 ${hub}」，或自己跑 \`apm setup --hub ${hub}\`

請不要手動改 Issue 正文末尾的隱藏區塊（\`<!-- apm:… -->\`），也不要刪 \`apm-lock/*\` 分支。
`;
}

