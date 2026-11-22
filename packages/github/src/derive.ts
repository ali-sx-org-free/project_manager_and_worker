import {
  buildResume,
  INTERRUPT_LABEL,
  type InterruptReason,
  type Member,
  type PmEvent,
  type Project,
  type ResumeContext,
  type Review,
  type Snapshot,
  type Task,
  type TaskResult,
  type TaskState,
  type User,
  type WorkLogEntry,
  type Worker,
} from '@agent-pm/core';
import type { CommentInfo, HubConfig, ProjectInfo, TaskInfo } from './hub.ts';
import { isAlive, type Lock } from './locks.ts';

/** 純函數：把 hub 上的 Issue、留言和鎖算成原來協調服務的那套數據（Project / Task / Worker / 事件）。
 *  apm 命令和管理端都用這一份，算出來的狀態永遠一致。
 *
 *  狀態以哪個為準：
 *  - Issue 關閉 = 完成
 *  - 鎖是 held 且沒過期 = 執行中（不管標籤寫什麼）
 *  - 其餘看 status 標籤（PM 的 review、解除阻塞只改標籤）；標籤還停在 claimed 但鎖已經交出時，以鎖為準 */

// ───────────────────────── 留言的格式 ─────────────────────────

export interface CheckpointMeta {
  at: number;
  summary: string;
  next_steps?: string;
  progress?: number;
  commit?: string;
  artifacts?: string[];
  auto?: boolean;
}
export interface AttemptMeta {
  kind: 'attempt';
  attempt: number;
  worker: string;
  owner: string;
  at: number;
  resumed?: { from_worker: string | null; progress: number; reason: string | null } | null;
  checkpoints: CheckpointMeta[];
}
export interface InterruptedMeta {
  kind: 'interrupted';
  attempt: number;
  worker: string;
  reason: InterruptReason;
  note: string;
  at: number;
  progress?: number;
  /** lease_expired 時是接手的人代記的 */
  by?: string;
}
export interface SubmittedMeta {
  kind: 'submitted';
  attempt: number;
  worker: string;
  summary: string;
  pr_url?: string;
  at: number;
}
export interface BlockedMeta {
  kind: 'blocked';
  attempt: number;
  worker: string;
  reason: string;
  at: number;
}
export interface UnblockedMeta {
  kind: 'unblocked';
  by: string;
  note?: string;
  at: number;
}
export interface ReviewMeta {
  kind: 'review';
  reviewer: string;
  decision: 'approve' | 'reject';
  comment: string;
  at: number;
  merged?: boolean;
}
export interface RevokedMeta {
  kind: 'revoked';
  by: string;
  attempt: number;
  worker: string;
  note?: string;
  at: number;
}
export interface WorkerMeta {
  kind: 'worker';
  id: string;
  name: string;
  machine: string;
  owner: string;
  labels: string[];
  projects: string[] | null;
  status: 'online' | 'left';
  current_task: number | null;
  seen: number;
  registered_at: number;
}
export type TaskMeta = AttemptMeta | InterruptedMeta | SubmittedMeta | BlockedMeta | UnblockedMeta | ReviewMeta | RevokedMeta;

// ───────────────────────── 一個任務的時間線 ─────────────────────────

export type Entry =
  | { at: number; key: string; kind: 'attempt'; meta: AttemptMeta; comment: CommentInfo }
  | { at: number; key: string; kind: 'checkpoint'; meta: AttemptMeta; cp: CheckpointMeta; index: number; comment: CommentInfo }
  | { at: number; key: string; kind: Exclude<TaskMeta['kind'], 'attempt'>; meta: TaskMeta; comment: CommentInfo };

export function entriesOf(comments: CommentInfo[]): Entry[] {
  const out: Entry[] = [];
  for (const c of comments) {
    const m = c.meta as unknown as TaskMeta;
    const at = typeof m.at === 'number' ? m.at : c.created_at;
    if (m.kind === 'attempt') {
      out.push({ at, key: `c${c.id}`, kind: 'attempt', meta: m, comment: c });
      (m.checkpoints ?? []).forEach((cp, index) =>
        out.push({ at: cp.at ?? at, key: `c${c.id}.${index}`, kind: 'checkpoint', meta: m, cp, index, comment: c }),
      );
    } else if (['interrupted', 'submitted', 'blocked', 'unblocked', 'review', 'revoked'].includes(m.kind)) {
      out.push({ at, key: `c${c.id}`, kind: m.kind as Exclude<TaskMeta['kind'], 'attempt'>, meta: m, comment: c });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.comment.id - b.comment.id || a.key.localeCompare(b.key));
}

interface Replayed {
  state: TaskState | null;
  assignee: string | null;
  last_assignee: string | null;
  attempt: number;
  progress: number;
  worklog: WorkLogEntry[];
  reviews: Review[];
  result: TaskResult | null;
  blocked_reason: string | null;
  updated_at: number;
}

/** 按時間順序重放留言，得到「留言說的」狀態。lock 和標籤的修正在 deriveTask 裡做 */
export function replay(entries: Entry[]): Replayed {
  const r: Replayed = {
    state: null,
    assignee: null,
    last_assignee: null,
    attempt: 0,
    progress: 0,
    worklog: [],
    reviews: [],
    result: null,
    blocked_reason: null,
    updated_at: 0,
  };
  const log = (e: Omit<WorkLogEntry, 'seq'>) => r.worklog.push({ seq: r.worklog.length + 1, ...e });
  for (const e of entries) {
    r.updated_at = Math.max(r.updated_at, e.at);
    switch (e.kind) {
      case 'attempt':
        r.state = 'claimed';
        r.assignee = e.meta.worker;
        r.last_assignee = e.meta.worker;
        r.attempt = Math.max(r.attempt, e.meta.attempt);
        r.blocked_reason = null;
        break;
      case 'checkpoint': {
        const cp = e.cp;
        if (typeof cp.progress === 'number') r.progress = Math.max(0, Math.min(100, Math.round(cp.progress)));
        log({
          kind: 'checkpoint',
          worker_id: e.meta.worker,
          attempt: e.meta.attempt,
          at: e.at,
          summary: cp.summary,
          next_steps: cp.next_steps,
          progress: r.progress,
          commit: cp.commit,
          artifacts: cp.artifacts,
          auto: cp.auto,
        });
        break;
      }
      case 'interrupted': {
        const m = e.meta as InterruptedMeta;
        r.state = 'ready';
        r.assignee = null;
        r.last_assignee = m.worker;
        log({
          kind: 'interrupted',
          worker_id: m.worker,
          attempt: m.attempt,
          at: e.at,
          summary: m.note || INTERRUPT_LABEL[m.reason] || m.reason,
          reason: m.reason,
        });
        break;
      }
      case 'submitted': {
        const m = e.meta as SubmittedMeta;
        r.state = 'in_review';
        r.assignee = null;
        r.last_assignee = m.worker;
        r.progress = 100;
        r.result = { summary: m.summary, pr_url: m.pr_url || undefined, submitted_by: m.worker, submitted_at: e.at };
        // 交付說明也記進接力記錄：被退回時，接手的人看到的「做到哪了」是這次交付，而不是更早的交接
        log({ kind: 'checkpoint', worker_id: m.worker, attempt: m.attempt, at: e.at, summary: `交付：${m.summary}`, progress: 100 });
        break;
      }
      case 'blocked': {
        const m = e.meta as BlockedMeta;
        r.state = 'blocked';
        r.assignee = null;
        r.last_assignee = m.worker;
        r.blocked_reason = m.reason;
        log({ kind: 'interrupted', worker_id: m.worker, attempt: m.attempt, at: e.at, summary: m.reason, reason: 'blocked' });
        break;
      }
      case 'unblocked':
        r.state = 'ready';
        r.blocked_reason = null;
        break;
      case 'review': {
        const m = e.meta as ReviewMeta;
        r.reviews.push({ reviewer: m.reviewer, decision: m.decision, comment: m.comment, at: e.at });
        if (m.decision === 'approve') r.state = 'done';
        else {
          r.state = 'changes_requested';
          r.progress = Math.min(r.progress, 80);
        }
        break;
      }
      case 'revoked': {
        const m = e.meta as RevokedMeta;
        r.state = 'ready';
        r.assignee = null;
        r.last_assignee = m.worker;
        log({
          kind: 'interrupted',
          worker_id: m.worker,
          attempt: m.attempt,
          at: e.at,
          summary: m.note || `管理員 ${m.by} 收回了任務`,
          reason: 'released',
        });
        break;
      }
    }
  }
  return r;
}

// ───────────────────────── 現在的狀態 ─────────────────────────

const refSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'task';

export const branchOf = (t: TaskInfo, projectKey: string) => t.branch ?? `project/${projectKey}/${refSafe(t.key)}-${t.number}`;

/** 依賴是否都完成（依賴的任務 Issue 都關閉了）。openNumbers：還開著的任務編號 */
export const depsDone = (t: TaskInfo, openNumbers: Set<number>) => t.deps.every((d) => !openNumbers.has(d));

export interface Effective {
  state: TaskState;
  /** 鎖是 held 但已過期：等人接手 */
  expired: boolean;
}

export function effectiveState(t: TaskInfo, lock: Lock | undefined | null, now: number, depsOk: boolean): Effective {
  if (!t.open) return { state: 'done', expired: false };
  if (lock?.status === 'held') {
    if (isAlive(lock, now)) return { state: 'claimed', expired: false };
    return { state: t.status === 'changes_requested' ? 'changes_requested' : 'ready', expired: true };
  }
  let s: TaskState = t.status ?? (depsOk ? 'ready' : 'pending');
  if (s === 'claimed') {
    // 標籤落後於鎖（寫完鎖、改標籤之前進程斷了）
    if (!lock || lock.status === 'released' || lock.status === 'revoked') s = 'ready';
    else if (lock.status === 'submitted') s = 'in_review';
    else if (lock.status === 'blocked') s = 'blocked';
  }
  if (s === 'done') s = 'ready'; // Issue 還開著就不算完成
  if (s === 'pending' || s === 'ready') s = depsOk ? 'ready' : 'pending';
  return { state: s, expired: false };
}

export interface TaskView extends Task {
  number: number;
  url: string;
  human_review: boolean;
  expired: boolean;
}

export function deriveTask(
  t: TaskInfo,
  projectKey: string,
  comments: CommentInfo[],
  lock: Lock | undefined | null,
  now: number,
  depsOk: boolean,
): TaskView {
  const r = replay(entriesOf(comments));
  const eff = effectiveState(t, lock, now, depsOk);
  const worklog = [...r.worklog];
  let assignee: string | null = null;
  let lease: number | null = null;
  let last = lock?.worker ?? r.last_assignee;
  const attempt = Math.max(r.attempt, lock?.attempt ?? 0);
  if (eff.state === 'claimed' && lock) {
    assignee = lock.worker;
    lease = lock.expires_at;
  }
  if (eff.expired && lock) {
    // 斷線：還沒人接手，補一條「租約超時」，讓接手的人和畫面都看得到
    const already = worklog.some((e) => e.kind === 'interrupted' && e.attempt === lock.attempt && e.worker_id === lock.worker);
    if (!already) {
      worklog.push({
        seq: worklog.length + 1,
        kind: 'interrupted',
        worker_id: lock.worker,
        attempt: lock.attempt,
        at: lock.expires_at ?? now,
        summary: '心跳中斷，租約超時',
        reason: 'lease_expired',
      });
    }
    last = lock.worker;
  }
  let progress = r.progress;
  if (eff.state === 'done' || eff.state === 'in_review') progress = 100;
  return {
    id: String(t.number),
    number: t.number,
    url: t.url,
    human_review: t.human_review,
    expired: eff.expired,
    project_id: String(t.project),
    project_key: projectKey,
    key: t.key,
    title: t.title,
    description: t.description,
    acceptance: t.acceptance,
    labels: t.caps,
    deps: t.deps.map(String),
    state: eff.state,
    assignee,
    last_assignee: last ?? null,
    lease_expires_at: lease,
    attempt,
    result: r.result,
    reviews: r.reviews,
    blocked_reason: eff.state === 'blocked' ? (r.blocked_reason ?? '受阻') : null,
    worklog,
    progress,
    branch: branchOf(t, projectKey),
    created_at: t.created_at,
    updated_at: Math.max(t.updated_at, r.updated_at),
  };
}

export function resumeOf(task: Task): ResumeContext | null {
  return buildResume(task);
}

// ───────────────────────── 可領的任務和排序 ─────────────────────────

export interface WorkerLike {
  id: string;
  owner: string;
  labels: string[];
  projects: string[] | null;
}

export function canParticipate(p: ProjectInfo, login: string, admin: boolean): boolean {
  if (admin) return true;
  return p.managers.includes(login) || p.contributors.includes(login) || p.author === login;
}

export function isManager(p: ProjectInfo, login: string, admin: boolean): boolean {
  return admin || p.managers.includes(login) || p.author === login;
}

export interface Candidate {
  task: TaskInfo;
  project: ProjectInfo;
  state: TaskState;
  lock: Lock | undefined;
  expired: boolean;
}

export interface ClaimableResult {
  candidates: Candidate[];
  /** 每個項目正在執行的任務數 */
  running: Map<number, number>;
  /** 不可領的原因（指定任務時用來報錯） */
  why: Map<number, string>;
}

/** 這個 worker 現在能領哪些任務，按「應該先做哪個」排好。規則和原來的 Engine.listClaimable 一樣：
 *  優先級高的先 → 自己做到一半的先（但自己剛交出去的排最後）→ 正在執行少的項目先 → 建立早的先 */
export function listClaimable(
  w: WorkerLike,
  admin: boolean,
  projects: ProjectInfo[],
  tasks: TaskInfo[],
  locks: Map<number, Lock>,
  now: number,
): ClaimableResult {
  const byNumber = new Map(projects.map((p) => [p.number, p]));
  const open = new Set(tasks.filter((t) => t.open).map((t) => t.number));
  const running = new Map<number, number>();
  for (const t of tasks) {
    if (t.open && isAlive(locks.get(t.number), now)) running.set(t.project, (running.get(t.project) ?? 0) + 1);
  }
  const why = new Map<number, string>();
  const candidates: Candidate[] = [];
  for (const t of tasks) {
    const p = byNumber.get(t.project);
    if (!p || !p.open) {
      why.set(t.number, '項目不在進行中');
      continue;
    }
    const lock = locks.get(t.number);
    const eff = effectiveState(t, lock, now, depsDone(t, open));
    if (eff.state !== 'ready' && eff.state !== 'changes_requested') {
      why.set(t.number, eff.state === 'claimed' ? `已被 ${lock?.worker} 領走` : `狀態是 ${eff.state}`);
      continue;
    }
    if (!canParticipate(p, w.owner, admin)) {
      why.set(t.number, `${w.owner} 不是項目「${p.title}」的成員（contributor 或 manager）`);
      continue;
    }
    if (w.projects && !w.projects.includes(p.key)) {
      why.set(t.number, `這個 worker 只做 ${w.projects.join('、')}`);
      continue;
    }
    if (!t.caps.every((c) => w.labels.includes(c))) {
      why.set(t.number, `能力不符：任務要 ${t.caps.join('、')}，worker 有 ${w.labels.join('、') || '（無）'}`);
      continue;
    }
    if (p.max_parallel !== null && (running.get(p.number) ?? 0) >= p.max_parallel) {
      why.set(t.number, p.max_parallel === 0 ? `項目「${p.title}」暫停派工` : `項目「${p.title}」的並行配額 ${p.max_parallel} 已滿`);
      continue;
    }
    candidates.push({ task: t, project: p, state: eff.state, lock, expired: eff.expired });
  }
  const rank = (c: Candidate) => {
    if (c.lock?.worker !== w.id) return 1;
    const handedOff = c.lock.status === 'released' && (c.lock.reason === 'usage_limit' || c.lock.reason === 'interrupted');
    return handedOff ? 2 : 0;
  };
  candidates.sort(
    (a, b) =>
      b.project.priority - a.project.priority ||
      rank(a) - rank(b) ||
      (running.get(a.project.number) ?? 0) - (running.get(b.project.number) ?? 0) ||
      a.task.created_at - b.task.created_at ||
      a.task.number - b.task.number,
  );
  return { candidates, running, why };
}

// ───────────────────────── 整體快照（管理端、apm status） ─────────────────────────

export interface HubModel {
  config: HubConfig;
  projects: ProjectInfo[];
  tasks: TaskInfo[];
  /** 任務編號 → 這個任務的 apm 留言 */
  comments: Map<number, CommentInfo[]>;
  roster: CommentInfo[];
  locks: Map<number, Lock>;
  admins: string[];
}

export interface ProjectView extends Project {
  number: number;
  url: string;
  repo: string | null;
  merge_on_approve: boolean;
}

export function deriveProject(p: ProjectInfo): ProjectView {
  return {
    id: String(p.number),
    number: p.number,
    url: p.url,
    repo: p.repo,
    merge_on_approve: p.merge_on_approve,
    key: p.key,
    priority: p.priority,
    max_parallel: p.max_parallel,
    title: p.title,
    description: p.description,
    kind: p.kind,
    status: p.open ? 'active' : 'delivered',
    created_at: p.created_at,
    delivered_at: p.closed_at,
  };
}

export function deriveWorkers(model: HubModel, now: number): Worker[] {
  const leaseMs = model.config.lease_minutes * 60_000;
  const out = new Map<string, Worker>();
  for (const c of model.roster) {
    const m = c.meta as unknown as WorkerMeta;
    if (m.kind !== 'worker' || !m.id) continue;
    out.set(m.id, {
      id: m.id,
      name: m.name || m.id,
      machine: m.machine ?? '',
      labels: m.labels ?? [],
      owner: m.owner ?? c.author,
      projects: m.projects ?? null,
      status: m.status === 'left' ? 'offline' : 'online',
      current_task: null,
      last_seen: Math.max(m.seen ?? 0, c.updated_at),
      registered_at: m.registered_at ?? c.created_at,
    });
  }
  const openTasks = new Set(model.tasks.filter((t) => t.open).map((t) => t.number));
  for (const [n, l] of model.locks) {
    let w = out.get(l.worker);
    if (!w) {
      w = {
        id: l.worker,
        name: l.worker,
        machine: '',
        labels: [],
        owner: l.owner,
        projects: null,
        status: 'offline',
        current_task: null,
        last_seen: 0,
        registered_at: l.at,
      };
      out.set(l.worker, w);
    }
    w.last_seen = Math.max(w.last_seen, l.at);
    if (openTasks.has(n) && isAlive(l, now)) w.current_task = String(n);
  }
  for (const w of out.values()) {
    if (w.current_task) w.status = 'online';
    else if (w.status === 'online' && now - w.last_seen > leaseMs * 2) w.status = 'offline';
  }
  return [...out.values()].sort((a, b) => a.registered_at - b.registered_at);
}

export type HubSnapshot = Omit<Snapshot, 'tasks' | 'projects'> & { tasks: TaskView[]; projects: ProjectView[] };

export function deriveSnapshot(model: HubModel, now: number): HubSnapshot {
  const projects = model.projects.map(deriveProject);
  const keyOf = new Map(model.projects.map((p) => [p.number, p.key]));
  const open = new Set(model.tasks.filter((t) => t.open).map((t) => t.number));
  const known = new Set(model.projects.map((p) => p.number));
  const tasks = model.tasks
    .filter((t) => known.has(t.project) && !(t.state_reason === 'not_planned' && !t.open))
    .map((t) =>
      deriveTask(t, keyOf.get(t.project) ?? '?', model.comments.get(t.number) ?? [], model.locks.get(t.number), now, depsDone(t, open)),
    );
  const members: Member[] = [];
  const logins = new Set<string>(model.admins);
  for (const p of model.projects) {
    const seen = new Set<string>();
    const add = (user_id: string, role: Member['role']) => {
      if (seen.has(user_id)) return;
      seen.add(user_id);
      logins.add(user_id);
      members.push({ project_id: String(p.number), user_id, role });
    };
    if (p.author) add(p.author, 'manager');
    p.managers.forEach((u) => add(u, 'manager'));
    p.contributors.forEach((u) => add(u, 'contributor'));
    p.viewers.forEach((u) => add(u, 'viewer'));
  }
  const workers = deriveWorkers(model, now);
  for (const w of workers) if (w.owner) logins.add(w.owner);
  const users: User[] = [...logins].sort().map((id) => ({ id, name: id, admin: model.admins.includes(id), created_at: 0 }));
  return {
    server_time: now,
    lease_ms: model.config.lease_minutes * 60_000,
    projects,
    tasks,
    workers,
    users,
    members,
    last_event_id: 0,
  };
}

// ───────────────────────── 事件（管理端的動態和回放） ─────────────────────────

export interface KeyedEvent extends PmEvent {
  /** 穩定的事件鍵，管理端靠它判斷哪些事件已經送過 */
  key: string;
}

const EVENT_OF: Record<Entry['kind'], PmEvent['type']> = {
  attempt: 'task_claimed',
  checkpoint: 'task_checkpoint',
  interrupted: 'task_released',
  submitted: 'task_submitted',
  blocked: 'task_blocked',
  unblocked: 'task_unblocked',
  review: 'review_approved',
  revoked: 'task_released',
};

/** 從留言重建事件流。每個事件帶著「那一刻」的任務快照，網頁的回放就是依次套用這些快照 */
export function deriveEvents(model: HubModel, snapshot: HubSnapshot, workerNames: Map<string, string>): KeyedEvent[] {
  const out: Omit<KeyedEvent, 'id'>[] = [];
  const name = (id: string | null | undefined) => (id ? (workerNames.get(id) ?? id) : '');
  const final = new Map(snapshot.tasks.map((t) => [t.number, t]));
  const projOf = new Map(snapshot.projects.map((p) => [p.number, p]));
  const initial = (t: TaskView): TaskView => ({
    ...t,
    state: t.deps.length ? 'pending' : 'ready',
    assignee: null,
    last_assignee: null,
    lease_expires_at: null,
    attempt: 0,
    result: null,
    reviews: [],
    blocked_reason: null,
    worklog: [],
    progress: 0,
    expired: false,
  });
  const approvedAt = new Map<number, number>();

  for (const p of model.projects) {
    const pv = projOf.get(p.number);
    if (!pv) continue;
    const tasks = snapshot.tasks.filter((t) => t.project_id === pv.id).map(initial);
    out.push({
      key: `p${p.number}`,
      ts: p.created_at,
      type: 'project_created',
      message: `建立項目「${p.title}」（${tasks.length} 個任務）`,
      project_id: pv.id,
      project: { ...pv, status: 'active', delivered_at: null },
      tasks,
    });
  }

  for (const t of model.tasks) {
    const fin = final.get(t.number);
    if (!fin) continue;
    const entries = entriesOf(model.comments.get(t.number) ?? []);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const r = replay(entries.slice(0, i + 1));
      const task: TaskView = {
        ...fin,
        state: r.state ?? fin.state,
        assignee: r.assignee,
        last_assignee: r.last_assignee,
        lease_expires_at: r.state === 'claimed' ? e.at + model.config.lease_minutes * 60_000 : null,
        attempt: r.attempt,
        result: r.result,
        reviews: r.reviews,
        blocked_reason: r.blocked_reason,
        worklog: r.worklog,
        progress: r.state === 'in_review' || r.state === 'done' ? 100 : r.progress,
        expired: false,
      };
      let type = EVENT_OF[e.kind];
      let message = '';
      const m = e.meta as unknown as Record<string, unknown>;
      const who = name(m.worker as string);
      switch (e.kind) {
        case 'attempt': {
          const resumed = (e.meta as AttemptMeta).resumed;
          if (resumed && resumed.progress > 0) {
            type = 'task_resumed';
            message =
              resumed.from_worker && resumed.from_worker !== (m.worker as string)
                ? `${who} 接手「${t.title}」，從 ${resumed.progress}% 繼續（上一位 ${name(resumed.from_worker)}）`
                : `${who} 回來繼續「${t.title}」，從 ${resumed.progress}% 接著做`;
          } else message = `${who} 領取「${t.title}」`;
          break;
        }
        case 'checkpoint':
          message = `${who} 保存檢查點「${t.title}」${task.progress}%：${(e as { cp: CheckpointMeta }).cp.summary.slice(0, 60)}`;
          break;
        case 'interrupted': {
          const im = e.meta as InterruptedMeta;
          if (im.reason === 'lease_expired') {
            type = 'lease_expired';
            message = `「${t.title}」租約超時（${who} 失聯），回到任務池`;
          } else message = `${who} 交出「${t.title}」（${INTERRUPT_LABEL[im.reason] ?? im.reason}），已完成 ${task.progress}%`;
          break;
        }
        case 'submitted':
          message = `${who} 提交「${t.title}」，等待 PM review`;
          break;
        case 'blocked':
          message = `${who} 回報「${t.title}」受阻：${(e.meta as BlockedMeta).reason}`;
          break;
        case 'unblocked':
          message = `${(e.meta as UnblockedMeta).by} 解除「${t.title}」的阻塞`;
          break;
        case 'review': {
          const rm = e.meta as ReviewMeta;
          if (rm.decision === 'approve') {
            approvedAt.set(t.number, e.at);
            message = `${rm.reviewer} 通過「${t.title}」${rm.merged ? '，PR 已合併' : ''}`;
          } else {
            type = 'review_rejected';
            message = `${rm.reviewer} 退回「${t.title}」：${rm.comment || '需要修改'}`;
          }
          break;
        }
        case 'revoked':
          message = `管理員 ${(e.meta as RevokedMeta).by} 收回「${t.title}」`;
          break;
      }
      out.push({
        key: e.key,
        ts: e.at,
        type,
        message,
        project_id: task.project_id,
        task_id: task.id,
        worker_id: (m.worker as string) ?? undefined,
        task,
      });
    }
  }

  // 上游全部通過的時刻，下游變成可領
  for (const t of model.tasks) {
    if (!t.deps.length) continue;
    const times = t.deps.map((d) => approvedAt.get(d));
    if (times.some((x) => x === undefined)) continue;
    const fin = final.get(t.number);
    if (!fin) continue;
    const at = Math.max(...(times as number[]));
    out.push({
      key: `r${t.number}`,
      ts: at + 1,
      type: 'task_ready',
      message: `「${t.title}」的依賴已完成，可以領取`,
      project_id: fin.project_id,
      task_id: fin.id,
      task: { ...initial(fin), state: 'ready' },
    });
  }

  for (const p of model.projects) {
    if (p.open || !p.closed_at) continue;
    const pv = projOf.get(p.number);
    if (pv) out.push({ key: `d${p.number}`, ts: p.closed_at, type: 'project_delivered', message: `PM 交付項目「${p.title}」`, project_id: pv.id, project: pv });
  }

  out.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
  return out.map((e, i) => ({ ...e, id: i + 1 }));
}
