import type { Store } from './store.ts';
import {
  PmError,
  ROLE_LABEL,
  type EventType,
  type PmEvent,
  type InterruptReason,
  type Member,
  type Project,
  type ProjectInput,
  type ProjectPatch,
  type ProjectRole,
  type User,
  type UserInput,
  type ResumeContext,
  type Review,
  type Snapshot,
  type Task,
  type WorkLogEntry,
  type Worker,
  type WorkerInput,
} from './types.ts';

const MAX_WORKLOG = 40;
const ROLE_NAME = ROLE_LABEL;

export const INTERRUPT_LABEL: Record<InterruptReason | 'changes_requested', string> = {
  lease_expired: '斷線，租約超時',
  interrupted: '被人工打斷',
  usage_limit: '用量額度用完',
  released: '主動釋放',
  blocked: '受阻',
  error: 'agent 異常退出',
  changes_requested: 'review 退回',
};

/** 從工作日誌算出續作上下文。沒有任何檢查點時返回 null，表示這個任務要從頭做。 */
export function buildResume(task: Task): ResumeContext | null {
  const checkpoints = task.worklog.filter((e) => e.kind === 'checkpoint');
  const latest = checkpoints.at(-1);
  if (!latest) return null;
  // agent 自己寫的總結比 runner 自動存的輸出片段有用，優先用它
  const last = checkpoints.filter((e) => !e.auto).at(-1) ?? latest;
  const auto = checkpoints.filter((e) => e.auto).at(-1);
  const stop = task.worklog.at(-1)?.kind === 'interrupted' ? task.worklog.at(-1)! : null;
  const rejected = task.state === 'changes_requested' || task.reviews.at(-1)?.decision === 'reject';
  return {
    from_worker: task.last_assignee ?? last.worker_id,
    reason: stop?.reason ?? (rejected ? 'changes_requested' : null),
    handoff_note: stop?.summary ?? null,
    progress: task.progress,
    summary: last.summary,
    next_steps: last.next_steps ?? null,
    auto_note: auto && auto !== last ? auto.summary : null,
    branch: task.branch,
    commit: [...checkpoints].reverse().find((e) => e.commit)?.commit ?? null,
    artifacts: [...new Set(checkpoints.flatMap((e) => e.artifacts ?? []))],
    checkpoints: checkpoints.length,
  };
}

/** 沒有啟用鑒權時，所有請求都以這個內建管理員的身分執行 */
export const ROOT_USER: User = { id: 'root', name: '管理員', admin: true, created_at: 0 };

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ROLES: ProjectRole[] = ['manager', 'contributor', 'viewer'];
/** 任務 key 放進分支名之前，把 git 不接受的字元換掉 */
const refSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'task';

export interface EngineOptions {
  /** 租約時長：領取後超過這麼久沒有心跳，任務自動回到任務池 */
  leaseMs?: number;
  now?: () => number;
}

type Listener = (e: PmEvent) => void;

const rid = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 4)}`;

/** 協調邏輯的唯一實現。所有寫操作都在 store.transaction 內完成，事件在提交後才廣播。 */
export class Engine {
  readonly leaseMs: number;
  private nowFn: () => number;
  private listeners = new Set<Listener>();
  private outbox: PmEvent[] = [];
  private depth = 0;

  constructor(
    private store: Store,
    opts: EngineOptions = {},
  ) {
    this.leaseMs = opts.leaseMs ?? 30 * 60 * 1000;
    this.nowFn = opts.now ?? Date.now;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ───────────────────────── 內部工具 ─────────────────────────

  private run<T>(fn: () => T): T {
    this.depth++;
    let result: T;
    try {
      result = this.depth === 1 ? this.store.transaction(fn) : fn();
    } catch (err) {
      if (this.depth === 1) this.outbox = [];
      throw err;
    } finally {
      this.depth--;
    }
    if (this.depth === 0) {
      const batch = this.outbox;
      this.outbox = [];
      for (const ev of batch) for (const l of this.listeners) l(ev);
    }
    return result;
  }

  private emit(type: EventType, message: string, fields: Partial<PmEvent> = {}, persist = true) {
    const base = { ts: this.nowFn(), type, message, ...fields };
    const ev = persist ? this.store.appendEvent(base) : ({ ...base, id: 0 } as PmEvent);
    this.outbox.push(ev);
  }

  private mustTask(id: string): Task {
    const t = this.store.getTask(id);
    if (!t) throw new PmError('not_found', `任務 ${id} 不存在`);
    return t;
  }

  private mustWorker(id: string): Worker {
    const w = this.store.getWorker(id);
    if (!w) throw new PmError('not_found', `worker ${id} 尚未註冊，請先調用 register_worker`);
    return w;
  }

  /** 任何來自 worker 的調用都順便刷新 last_seen */
  private touch(w: Worker): Worker {
    const wasOffline = w.status === 'offline';
    w.last_seen = this.nowFn();
    w.status = 'online';
    this.store.upsertWorker(w);
    if (wasOffline) {
      this.emit('worker_online', `${w.name} 重新上線`, { worker_id: w.id, worker: w });
    }
    return w;
  }

  private canDo(w: Worker, t: Task) {
    return t.labels.every((l) => w.labels.includes(l));
  }

  /** 往任務的工作日誌追加一條。日誌跟著任務走，租約回收、換人都不會丟。 */
  private log(t: Task, workerId: string, entry: Omit<WorkLogEntry, 'seq' | 'worker_id' | 'attempt' | 'at'>) {
    const prev = t.worklog.at(-1);
    const seq = (prev?.seq ?? 0) + 1;
    // runner 的自動檢查點很頻繁：連續的自動檢查點只留最新一條，免得把 agent 自己寫的總結擠出日誌
    const keep =
      entry.auto && prev?.auto && prev.kind === 'checkpoint' && prev.worker_id === workerId && prev.attempt === t.attempt
        ? t.worklog.slice(0, -1)
        : t.worklog;
    t.worklog = [...keep, { seq, worker_id: workerId, attempt: t.attempt, at: this.nowFn(), ...entry }].slice(
      -MAX_WORKLOG,
    );
  }

  private freeWorker(workerId: string | null, offline = false) {
    if (!workerId) return;
    const w = this.store.getWorker(workerId);
    if (!w) return;
    w.current_task = null;
    if (offline) w.status = 'offline';
    this.store.upsertWorker(w);
    return w;
  }

  // ───────────────────────── PM：拆解與交付 ─────────────────────────

  /** PM 把人類的請求拆解成任務 DAG。這裡校驗 key 唯一、依賴存在、無環。 */
  createProject(input: ProjectInput): { project: Project; tasks: Task[] } {
    if (!input.title?.trim()) throw new PmError('invalid', '項目需要標題');
    if (!input.tasks?.length) throw new PmError('invalid', '項目至少需要一個任務');

    const keys = new Set<string>();
    for (const t of input.tasks) {
      if (!t.key || !t.title) throw new PmError('invalid', '每個任務都需要 key 和 title');
      if (keys.has(t.key)) throw new PmError('invalid', `任務 key 重複：${t.key}`);
      keys.add(t.key);
    }
    for (const t of input.tasks) {
      for (const d of t.deps ?? []) {
        if (!keys.has(d)) throw new PmError('invalid', `任務 ${t.key} 依賴了不存在的 ${d}`);
        if (d === t.key) throw new PmError('invalid', `任務 ${t.key} 不能依賴自己`);
      }
    }
    // Kahn 拓撲排序檢查有向無環
    const indeg = new Map(input.tasks.map((t) => [t.key, (t.deps ?? []).length]));
    const queue = input.tasks.filter((t) => !(t.deps ?? []).length).map((t) => t.key);
    let seen = 0;
    while (queue.length) {
      const k = queue.shift()!;
      seen++;
      for (const t of input.tasks) {
        if ((t.deps ?? []).includes(k)) {
          const n = indeg.get(t.key)! - 1;
          indeg.set(t.key, n);
          if (n === 0) queue.push(t.key);
        }
      }
    }
    if (seen !== input.tasks.length) throw new PmError('invalid', '任務依賴存在環，必須是有向無環圖');
    if (input.key !== undefined && !KEY_RE.test(input.key)) {
      throw new PmError('invalid', '項目短名 key 只能用小寫字母、數字和連字號，最長 32 個字元，例如 site');
    }
    const priority = this.checkPriority(input.priority ?? 3);
    const maxParallel = this.checkQuota(input.max_parallel ?? null);
    for (const m of input.members ?? []) {
      if (!ROLES.includes(m.role)) throw new PmError('invalid', `角色只能是 ${ROLES.join(' / ')}`);
    }

    return this.run(() => {
      const now = this.nowFn();
      const id = rid('p');
      const key = input.key ?? `p-${id.slice(-4)}`;
      // 分支名靠短名區分項目，所以還在用的項目之間短名不能重複
      if (this.store.listProjects().some((p) => p.status !== 'archived' && p.key === key)) {
        throw new PmError('conflict', `項目短名 ${key} 已被另一個項目使用`);
      }
      for (const m of input.members ?? []) this.mustUser(m.user_id);
      const project: Project = {
        id,
        key,
        priority,
        max_parallel: maxParallel,
        title: input.title.trim(),
        description: input.description ?? '',
        kind: input.kind ?? 'dev',
        status: 'active',
        created_at: now,
        delivered_at: null,
      };
      this.store.insertProject(project);

      const idOf = new Map(input.tasks.map((t) => [t.key, rid('t')]));
      const tasks: Task[] = input.tasks.map((t) => ({
        id: idOf.get(t.key)!,
        project_id: project.id,
        project_key: project.key,
        key: t.key,
        title: t.title,
        description: t.description ?? '',
        acceptance: t.acceptance ?? '',
        labels: t.labels ?? [],
        deps: (t.deps ?? []).map((d) => idOf.get(d)!),
        state: (t.deps ?? []).length ? 'pending' : 'ready',
        assignee: null,
        last_assignee: null,
        lease_expires_at: null,
        attempt: 0,
        result: null,
        reviews: [],
        blocked_reason: null,
        worklog: [],
        progress: 0,
        branch: `project/${project.key}/${refSafe(t.key)}-${idOf.get(t.key)!.slice(-4)}`,
        created_at: now,
        updated_at: now,
      }));
      for (const t of tasks) this.store.insertTask(t);
      for (const m of input.members ?? []) {
        this.store.setMember({ project_id: project.id, user_id: m.user_id, role: m.role });
      }

      this.emit('project_created', `PM 建立項目「${project.title}」，拆解為 ${tasks.length} 個任務`, {
        project_id: project.id,
        project,
        tasks,
        members: this.store.listMembers(project.id),
      });
      return { project, tasks };
    });
  }

  private checkPriority(v: unknown): number {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new PmError('invalid', '優先級 priority 必須是 1 到 5 的整數');
    return n;
  }

  private checkQuota(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new PmError('invalid', '並行配額 max_parallel 必須是 0 以上的整數，或 null 表示不限');
    return n;
  }

  private mustProject(id: string): Project {
    // 接受 id，也接受短名（方便人手打命令）
    const p = this.store.getProject(id) ?? this.store.listProjects().find((x) => x.key === id && x.status !== 'archived');
    if (!p) throw new PmError('not_found', `項目 ${id} 不存在`);
    return p;
  }

  private mustUser(id: string): User {
    const u = this.store.getUser(id);
    if (!u) throw new PmError('not_found', `用戶 ${id} 不存在`);
    return u;
  }

  getProject(id: string): Project {
    return this.mustProject(id);
  }

  /** 調整項目的優先級和並行配額。立刻生效：下一次有人領任務就按新的規則排。 */
  updateProject(id: string, patch: ProjectPatch, by = 'PM'): Project {
    return this.run(() => {
      const p = this.mustProject(id);
      const changes: string[] = [];
      if (patch.priority !== undefined) {
        const v = this.checkPriority(patch.priority);
        if (v !== p.priority) changes.push(`優先級 ${p.priority} → ${v}`);
        p.priority = v;
      }
      if (patch.max_parallel !== undefined) {
        const v = this.checkQuota(patch.max_parallel);
        if (v !== p.max_parallel) changes.push(`並行配額 ${p.max_parallel ?? '不限'} → ${v ?? '不限'}`);
        p.max_parallel = v;
      }
      if (!changes.length) return p;
      this.store.updateProject(p);
      this.emit('project_updated', `${by} 調整項目「${p.title}」：${changes.join('，')}`, { project_id: p.id, project: p });
      return p;
    });
  }

  // ───────────────────────── 身分與權限 ─────────────────────────

  /** 建立或更新一個用戶。tokenHash 由服務端生成 token 後算好傳入。 */
  upsertUser(input: UserInput, tokenHash?: string | null): User {
    if (!input.name?.trim()) throw new PmError('invalid', '用戶需要 name');
    if (input.id !== undefined && !KEY_RE.test(input.id)) {
      throw new PmError('invalid', '用戶 id 只能用小寫字母、數字和連字號');
    }
    if (input.id === ROOT_USER.id) throw new PmError('invalid', `${ROOT_USER.id} 是保留的 id`);
    return this.run(() => {
      const prev = input.id ? this.store.getUser(input.id) : undefined;
      const u: User = {
        id: input.id ?? rid('u').replace('_', '-'),
        name: input.name.trim(),
        admin: input.admin ?? prev?.admin ?? false,
        created_at: prev?.created_at ?? this.nowFn(),
      };
      this.store.upsertUser(u, tokenHash);
      return u;
    });
  }

  userByTokenHash(hash: string): User | undefined {
    return this.store.findUserByTokenHash(hash);
  }

  getUser(id: string): User | undefined {
    return id === ROOT_USER.id ? ROOT_USER : this.store.getUser(id);
  }

  /** 設定或移除（role 為 null）項目成員 */
  setMember(projectId: string, userId: string, role: ProjectRole | null, by = 'PM'): Member[] {
    if (role !== null && !ROLES.includes(role)) throw new PmError('invalid', `角色只能是 ${ROLES.join(' / ')}`);
    return this.run(() => {
      const p = this.mustProject(projectId);
      const u = this.mustUser(userId);
      if (role) this.store.setMember({ project_id: p.id, user_id: u.id, role });
      else this.store.removeMember(p.id, u.id);
      const members = this.store.listMembers(p.id);
      this.emit(
        'member_changed',
        role ? `${by} 把 ${u.name} 設為「${p.title}」的${ROLE_NAME[role]}` : `${by} 把 ${u.name} 移出「${p.title}」`,
        { project_id: p.id, project: p, members },
      );
      return members;
    });
  }

  /** actor 在這個項目裡的角色；管理員一律是 manager；不是成員返回 null（看不到這個項目） */
  roleOf(actor: User, projectId: string): ProjectRole | null {
    if (actor.admin) return 'manager';
    return this.store.listMembers(projectId).find((m) => m.user_id === actor.id)?.role ?? null;
  }

  /** worker 能不能為這個項目幹活：看它的主人有沒有參與權，以及它自己有沒有限定項目 */
  private workerAllowed(w: Worker, p: Project, members: Member[]): boolean {
    if (w.projects && !w.projects.includes(p.key)) return false;
    if (!w.owner) return true;
    const owner = this.getUser(w.owner);
    if (!owner) return false;
    if (owner.admin) return true;
    const role = members.find((m) => m.project_id === p.id && m.user_id === owner.id)?.role;
    return role === 'manager' || role === 'contributor';
  }

  archiveProject(id: string): Project {
    return this.run(() => {
      const p = this.store.getProject(id);
      if (!p) throw new PmError('not_found', `項目 ${id} 不存在`);
      p.status = 'archived';
      this.store.updateProject(p);
      this.emit('project_archived', `項目「${p.title}」已歸檔`, { project_id: p.id, project: p });
      return p;
    });
  }

  // ───────────────────────── Worker：註冊、領取、心跳、交付 ─────────────────────────

  registerWorker(input: WorkerInput): Worker {
    if (!input.id) throw new PmError('invalid', 'worker 需要 id');
    return this.run(() => {
      const now = this.nowFn();
      const prev = this.store.getWorker(input.id);
      const w: Worker = {
        id: input.id,
        name: input.name ?? prev?.name ?? input.id,
        machine: input.machine ?? prev?.machine ?? '',
        labels: input.labels ?? prev?.labels ?? [],
        owner: input.owner !== undefined ? input.owner : (prev?.owner ?? null),
        projects: input.projects !== undefined ? (input.projects?.length ? input.projects : null) : (prev?.projects ?? null),
        status: 'online',
        current_task: prev?.current_task ?? null,
        last_seen: now,
        registered_at: prev?.registered_at ?? now,
      };
      this.store.upsertWorker(w);
      this.emit(
        prev ? 'worker_online' : 'worker_registered',
        prev ? `${w.name} 重新上線` : `${w.name} 加入（${w.labels.join('、') || '無標籤'}）`,
        { worker_id: w.id, worker: w },
      );
      return w;
    });
  }

  /** 每個項目現在有幾個任務正在執行（用來算並行配額） */
  private runningByProject(tasks: Task[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const t of tasks) if (t.state === 'claimed') m.set(t.project_id, (m.get(t.project_id) ?? 0) + 1);
    return m;
  }

  /** 這個 worker 目前可以領取的任務，按「應該先做哪個」排好。
   *  過濾：項目進行中、worker 的主人有權參與、能力標籤滿足、項目的並行配額還沒滿。
   *  排序：項目優先級高的在前；同優先級裡先還自己做到一半的；再讓正在執行的任務較少的項目先拿（避免一個項目吃光所有人）。 */
  listClaimable(workerId: string): Task[] {
    const w = this.mustWorker(workerId);
    const projects = new Map(
      this.store
        .listProjects()
        .filter((p) => p.status === 'active')
        .map((p) => [p.id, p]),
    );
    const members = this.store.listMembers();
    const all = this.store.listTasks();
    const running = this.runningByProject(all);
    const open = (p: Project) => p.max_parallel === null || (running.get(p.id) ?? 0) < p.max_parallel;
    const allowed = new Map([...projects.values()].map((p) => [p.id, this.workerAllowed(w, p, members) && open(p)]));
    // 自己做到一半的（被退回、斷線後回來）優先還給自己，上下文最完整；
    // 但自己剛因為額度用完或被人打斷而交出去的排到最後，留給別人接手
    const rank = (t: Task) => {
      if (t.last_assignee !== w.id) return 1;
      const stop = t.worklog.at(-1);
      const handedOff = stop?.kind === 'interrupted' && (stop.reason === 'usage_limit' || stop.reason === 'interrupted');
      return handedOff ? 2 : 0;
    };
    return all
      .filter(
        (t) => allowed.get(t.project_id) && (t.state === 'ready' || t.state === 'changes_requested') && this.canDo(w, t),
      )
      .sort((a, b) => {
        const pa = projects.get(a.project_id)!;
        const pb = projects.get(b.project_id)!;
        return (
          pb.priority - pa.priority ||
          rank(a) - rank(b) ||
          (running.get(pa.id) ?? 0) - (running.get(pb.id) ?? 0) ||
          a.created_at - b.created_at
        );
      });
  }

  /** 為什麼這個 worker 領不到這個任務（給指定任務領取時的錯誤訊息用） */
  private whyNot(w: Worker, t: Task): string {
    const p = this.store.getProject(t.project_id);
    if (!p || p.status !== 'active') return '項目不在進行中';
    if (t.state !== 'ready' && t.state !== 'changes_requested') return `狀態 ${t.state}`;
    if (!this.workerAllowed(w, p, this.store.listMembers(p.id))) return `${w.name} 沒有參與項目「${p.title}」的權限`;
    if (!this.canDo(w, t)) return '能力標籤不符';
    const running = this.runningByProject(this.store.listTasks(p.id)).get(p.id) ?? 0;
    if (p.max_parallel !== null && running >= p.max_parallel) return `項目「${p.title}」的並行配額 ${p.max_parallel} 已滿`;
    return '已被別人領走';
  }

  /** 原子領取。不傳 taskId 則自動挑一個適合的；沒有可領的返回 null。 */
  claimTask(workerId: string, taskId?: string): Task | null {
    return this.run(() => {
      const w = this.touch(this.mustWorker(workerId));
      if (w.current_task) {
        const cur = this.store.getTask(w.current_task);
        if (cur && cur.state === 'claimed' && cur.assignee === w.id) {
          throw new PmError('conflict', `${w.name} 還有未完成的任務「${cur.title}」，一次只能領一個`);
        }
      }
      const candidates = this.listClaimable(workerId).filter((t) => !taskId || t.id === taskId);
      if (taskId && !candidates.length) {
        const t = this.mustTask(taskId);
        throw new PmError('conflict', `任務「${t.title}」目前不可領取：${this.whyNot(w, t)}`);
      }
      const now = this.nowFn();
      for (const c of candidates) {
        const next: Task = {
          ...c,
          state: 'claimed',
          assignee: w.id,
          lease_expires_at: now + this.leaseMs,
          attempt: c.attempt + 1,
          blocked_reason: null,
          updated_at: now,
        };
        if (!this.store.casTask(next, ['ready', 'changes_requested'])) continue; // 被別人搶先
        w.current_task = next.id;
        this.store.upsertWorker(w);
        // 有檢查點就是「接手續作」，而不是從頭領取
        const resume = buildResume(c);
        const prev = resume?.from_worker ? (this.store.getWorker(resume.from_worker)?.name ?? resume.from_worker) : null;
        const message = !resume
          ? `${w.name} 領取「${next.title}」`
          : prev && resume.from_worker !== w.id
            ? `${w.name} 接手「${next.title}」，從 ${resume.progress}% 繼續（上一位 ${prev}：${resume.reason ? INTERRUPT_LABEL[resume.reason] : '已停下'}）`
            : `${w.name} 回來繼續「${next.title}」，從 ${resume.progress}% 接著做`;
        this.emit(resume ? 'task_resumed' : 'task_claimed', message, {
          project_id: next.project_id,
          task_id: next.id,
          worker_id: w.id,
          task: next,
          worker: w,
        });
        return next;
      }
      return null;
    });
  }

  /** 心跳續約。租約已丟失時拋出 lease_lost，worker 應立即停手。 */
  heartbeat(workerId: string, taskId: string): { lease_expires_at: number } {
    return this.run(() => {
      const w = this.touch(this.mustWorker(workerId));
      const t = this.mustTask(taskId);
      if (t.state !== 'claimed' || t.assignee !== w.id) {
        throw new PmError('lease_lost', `任務「${t.title}」的租約已不屬於 ${w.name}，請停止執行`);
      }
      t.lease_expires_at = this.nowFn() + this.leaseMs;
      this.store.updateTask(t);
      this.emit(
        'heartbeat',
        `${w.name} 心跳`,
        { project_id: t.project_id, task_id: t.id, worker_id: w.id, task: t, worker: w },
        false,
      );
      return { lease_expires_at: t.lease_expires_at };
    });
  }

  /** 保存檢查點：把「做到哪、接下來做什麼、中間成果在哪」記到任務上，同時續約。
   *  之後不管因為什麼原因換人，接手的 worker 領取時都會拿到最後一個檢查點。 */
  saveCheckpoint(
    workerId: string,
    taskId: string,
    cp: {
      summary: string;
      next_steps?: string;
      progress?: number;
      commit?: string;
      artifacts?: string[];
      auto?: boolean;
    },
  ): { seq: number; lease_expires_at: number } {
    if (!cp?.summary?.trim()) throw new PmError('invalid', '檢查點需要 summary：到目前為止完成了什麼');
    return this.run(() => {
      const { w, t } = this.mustHold(workerId, taskId);
      const progress =
        cp.progress === undefined || Number.isNaN(Number(cp.progress))
          ? t.progress
          : Math.max(0, Math.min(100, Math.round(Number(cp.progress))));
      this.log(t, w.id, {
        kind: 'checkpoint',
        summary: cp.summary.trim().slice(0, 4000),
        next_steps: cp.next_steps?.trim().slice(0, 2000) || undefined,
        progress,
        commit: cp.commit || undefined,
        artifacts: cp.artifacts?.length ? cp.artifacts.slice(0, 20) : undefined,
        auto: cp.auto || undefined,
      });
      t.progress = progress;
      t.lease_expires_at = this.nowFn() + this.leaseMs;
      t.updated_at = this.nowFn();
      this.store.updateTask(t);
      this.emit('task_checkpoint', `${w.name} 保存檢查點「${t.title}」${progress}%：${cp.summary.trim().slice(0, 60)}`, {
        project_id: t.project_id,
        task_id: t.id,
        worker_id: w.id,
        task: t,
        worker: w,
      });
      return { seq: t.worklog.at(-1)!.seq, lease_expires_at: t.lease_expires_at };
    });
  }

  private mustHold(workerId: string, taskId: string) {
    const w = this.touch(this.mustWorker(workerId));
    const t = this.mustTask(taskId);
    if (t.state !== 'claimed' || t.assignee !== w.id) {
      throw new PmError('lease_lost', `任務「${t.title}」目前不由 ${w.name} 持有（狀態 ${t.state}）`);
    }
    return { w, t };
  }

  submitResult(workerId: string, taskId: string, result: { summary: string; pr_url?: string }): Task {
    return this.run(() => {
      const { w, t } = this.mustHold(workerId, taskId);
      const now = this.nowFn();
      t.state = 'in_review';
      t.progress = 100;
      t.result = {
        summary: result.summary ?? '',
        pr_url: result.pr_url || undefined,
        submitted_by: w.id,
        submitted_at: now,
      };
      t.assignee = null;
      t.last_assignee = w.id;
      t.lease_expires_at = null;
      t.updated_at = now;
      this.store.updateTask(t);
      const freed = this.freeWorker(w.id);
      this.emit('task_submitted', `${w.name} 提交「${t.title}」，等待 PM review`, {
        project_id: t.project_id,
        task_id: t.id,
        worker_id: w.id,
        task: t,
        worker: freed,
      });
      return t;
    });
  }

  reportBlocked(workerId: string, taskId: string, reason: string): Task {
    return this.run(() => {
      const { w, t } = this.mustHold(workerId, taskId);
      t.state = 'blocked';
      t.blocked_reason = reason || '未說明原因';
      this.log(t, w.id, { kind: 'interrupted', reason: 'blocked', summary: t.blocked_reason });
      t.assignee = null;
      t.last_assignee = w.id;
      t.lease_expires_at = null;
      t.updated_at = this.nowFn();
      this.store.updateTask(t);
      const freed = this.freeWorker(w.id);
      this.emit('task_blocked', `${w.name} 回報「${t.title}」受阻：${t.blocked_reason}`, {
        project_id: t.project_id,
        task_id: t.id,
        worker_id: w.id,
        task: t,
        worker: freed,
      });
      return t;
    });
  }

  /** worker 交出任務（人工打斷、額度用完、主動放棄），任務立刻回到任務池，不用等租約超時。
   *  note 是寫給接手者的交接說明。 */
  releaseTask(workerId: string, taskId: string, opts: { reason?: InterruptReason; note?: string } = {}): Task {
    return this.run(() => {
      const { w, t } = this.mustHold(workerId, taskId);
      const reason = opts.reason ?? 'released';
      this.log(t, w.id, {
        kind: 'interrupted',
        reason,
        summary: opts.note?.trim().slice(0, 2000) || INTERRUPT_LABEL[reason],
      });
      t.state = 'ready';
      t.assignee = null;
      t.last_assignee = w.id;
      t.lease_expires_at = null;
      t.updated_at = this.nowFn();
      this.store.updateTask(t);
      const freed = this.freeWorker(w.id);
      this.emit('task_released', `${w.name} 交出「${t.title}」（${INTERRUPT_LABEL[reason]}），已完成 ${t.progress}%，等待接手`, {
        project_id: t.project_id,
        task_id: t.id,
        worker_id: w.id,
        task: t,
        worker: freed,
      });
      return t;
    });
  }

  // ───────────────────────── PM / 人類：review、解除阻塞 ─────────────────────────

  unblock(taskId: string, by = 'human'): Task {
    return this.run(() => {
      const t = this.mustTask(taskId);
      if (t.state !== 'blocked') throw new PmError('conflict', `任務「${t.title}」不在 blocked 狀態`);
      t.state = 'ready';
      t.blocked_reason = null;
      t.updated_at = this.nowFn();
      this.store.updateTask(t);
      this.emit('task_unblocked', `${by} 解除「${t.title}」的阻塞`, {
        project_id: t.project_id,
        task_id: t.id,
        task: t,
      });
      return t;
    });
  }

  review(taskId: string, r: { reviewer?: string; decision: 'approve' | 'reject'; comment?: string }): Task {
    if (r.decision !== 'approve' && r.decision !== 'reject') {
      throw new PmError('invalid', 'decision 只能是 approve 或 reject');
    }
    return this.run(() => {
      const t = this.mustTask(taskId);
      if (t.state !== 'in_review') throw new PmError('conflict', `任務「${t.title}」不在 in_review 狀態`);
      const now = this.nowFn();
      const review: Review = {
        reviewer: r.reviewer ?? 'pm',
        decision: r.decision,
        comment: r.comment ?? '',
        at: now,
      };
      t.reviews = [...t.reviews, review];
      t.updated_at = now;

      if (r.decision === 'reject') {
        t.state = 'changes_requested';
        t.progress = Math.min(t.progress, 80);
        this.store.updateTask(t);
        this.emit('review_rejected', `${review.reviewer} 退回「${t.title}」：${review.comment || '需要修改'}`, {
          project_id: t.project_id,
          task_id: t.id,
          task: t,
        });
        return t;
      }

      t.state = 'done';
      this.store.updateTask(t);
      this.emit('review_approved', `${review.reviewer} 通過「${t.title}」`, {
        project_id: t.project_id,
        task_id: t.id,
        task: t,
      });

      // 解鎖下游：所有依賴都 done 的 pending 任務變成 ready
      const siblings = this.store.listTasks(t.project_id);
      const done = new Set(siblings.filter((s) => s.state === 'done').map((s) => s.id));
      for (const s of siblings) {
        if (s.state === 'pending' && s.deps.every((d) => done.has(d))) {
          s.state = 'ready';
          s.updated_at = now;
          this.store.updateTask(s);
          this.emit('task_ready', `「${s.title}」的依賴已完成，可以領取`, {
            project_id: s.project_id,
            task_id: s.id,
            task: s,
          });
        }
      }

      // 全部完成則由 PM 交付
      if (siblings.every((s) => done.has(s.id))) {
        const p = this.store.getProject(t.project_id);
        if (p && p.status === 'active') {
          p.status = 'delivered';
          p.delivered_at = now;
          this.store.updateProject(p);
          this.emit('project_delivered', `PM 交付項目「${p.title}」`, { project_id: p.id, project: p });
        }
      }
      return t;
    });
  }

  // ───────────────────────── 定時維護 ─────────────────────────

  /** 每秒調用一次：回收租約過期的任務，標記失聯的 worker。 */
  tick(): void {
    this.run(() => {
      const now = this.nowFn();
      for (const t of this.store.listTasks()) {
        if (t.state !== 'claimed' || t.lease_expires_at === null || t.lease_expires_at > now) continue;
        const holder = t.assignee;
        if (holder) this.log(t, holder, { kind: 'interrupted', reason: 'lease_expired', summary: '心跳中斷，租約超時' });
        const next: Task = {
          ...t,
          state: 'ready',
          assignee: null,
          last_assignee: holder,
          lease_expires_at: null,
          updated_at: now,
        };
        if (!this.store.casTask(next, ['claimed'])) continue;
        const w = this.freeWorker(holder, true);
        this.emit(
          'lease_expired',
          `「${t.title}」租約超時（${w?.name ?? holder} 失聯），回到任務池${t.worklog.some((e) => e.kind === 'checkpoint') ? `，保留 ${t.progress}% 的進度` : ''}`,
          {
            project_id: t.project_id,
            task_id: t.id,
            worker_id: holder ?? undefined,
            task: next,
            worker: w,
          },
        );
      }
      for (const w of this.store.listWorkers()) {
        if (w.status === 'online' && !w.current_task && now - w.last_seen > this.leaseMs * 2) {
          w.status = 'offline';
          this.store.upsertWorker(w);
          this.emit('worker_offline', `${w.name} 離線`, { worker_id: w.id, worker: w });
        }
      }
    });
  }

  // ───────────────────────── 查詢 ─────────────────────────

  getTask(id: string): Task {
    return this.mustTask(id);
  }

  getWorker(id: string): Worker {
    return this.mustWorker(id);
  }

  snapshot(includeArchived = false): Snapshot {
    const projects = this.store.listProjects().filter((p) => includeArchived || p.status !== 'archived');
    const ids = new Set(projects.map((p) => p.id));
    return {
      server_time: this.nowFn(),
      lease_ms: this.leaseMs,
      projects,
      tasks: this.store.listTasks().filter((t) => ids.has(t.project_id)),
      workers: this.store.listWorkers(),
      users: this.store.listUsers(),
      members: this.store.listMembers().filter((m) => ids.has(m.project_id)),
      last_event_id: this.store.lastEventId(),
    };
  }

  // ───────────────────────── 按身分過濾的視圖 ─────────────────────────
  //
  // 規則只有一條：不是項目成員，就看不到這個項目的任何東西（項目、任務、事件）。
  // worker 會跨項目幹活，所以別人的 worker 你看得到（如果你們有共同的項目），
  // 但它在你看不到的項目裡做什麼會被抹掉，只留一個「忙於其他項目」。

  /** actor 看得到哪些項目 */
  visibleProjects(actor: User): Set<string> {
    const all = this.store.listProjects().filter((p) => p.status !== 'archived');
    if (actor.admin) return new Set(all.map((p) => p.id));
    const mine = new Set(this.store.listMembers().filter((m) => m.user_id === actor.id).map((m) => m.project_id));
    return new Set(all.filter((p) => mine.has(p.id)).map((p) => p.id));
  }

  /** 過濾用的上下文，算一次可以連著過濾很多事件 */
  viewOf(actor: User) {
    const visible = this.visibleProjects(actor);
    const members = this.store.listMembers();
    // 和我有共同項目的人
    const peers = new Set(members.filter((m) => visible.has(m.project_id)).map((m) => m.user_id));
    peers.add(actor.id);
    const admins = new Set(this.store.listUsers().filter((u) => u.admin).map((u) => u.id));
    const taskProject = new Map<string, string>();
    const seesWorker = (w: Worker) => actor.admin || !w.owner || admins.has(w.owner) || peers.has(w.owner);
    const projectOfTask = (id: string) => {
      if (!taskProject.has(id)) taskProject.set(id, this.store.getTask(id)?.project_id ?? '');
      return taskProject.get(id)!;
    };
    const redact = (w: Worker): Worker => {
      if (actor.admin || !w.current_task || visible.has(projectOfTask(w.current_task))) return w;
      return { ...w, current_task: null, busy_elsewhere: true };
    };
    return { actor, visible, peers, seesWorker, redact };
  }

  viewSnapshot(actor: User): Snapshot {
    const snap = this.snapshot();
    if (actor.admin) return snap;
    const v = this.viewOf(actor);
    return {
      ...snap,
      projects: snap.projects.filter((p) => v.visible.has(p.id)),
      tasks: snap.tasks.filter((t) => v.visible.has(t.project_id)),
      workers: snap.workers.filter(v.seesWorker).map(v.redact),
      // 看得到和自己有共同項目的人，以及管理員（他們的 worker 會出現在你的項目裡）
      users: snap.users.filter((u) => u.admin || v.peers.has(u.id)),
      members: snap.members.filter((m) => v.visible.has(m.project_id)),
    };
  }

  /** 把一個事件變成 actor 該看到的樣子；完全不該看到就返回 null */
  viewEvent(view: ReturnType<Engine['viewOf']>, ev: PmEvent): PmEvent | null {
    if (view.actor.admin) return ev;
    const worker = ev.worker && view.seesWorker(ev.worker) ? view.redact(ev.worker) : undefined;
    if (ev.project_id) {
      if (view.visible.has(ev.project_id)) return ev.worker ? { ...ev, worker } : ev;
      // 看不到的項目裡發生的事：只告訴你「你看得到的那個 worker 現在忙不忙」
      if (!worker || ev.type === 'heartbeat') return null;
      return { id: ev.id, ts: ev.ts, type: 'worker_updated', message: '', worker_id: worker.id, worker };
    }
    if (ev.worker) return worker ? { ...ev, worker } : null;
    return null;
  }

  viewEvents(actor: User, sinceId = 0, limit = 1000): PmEvent[] {
    const all = this.store.listEvents(sinceId, limit);
    if (actor.admin) return all;
    const view = this.viewOf(actor);
    return all.map((e) => this.viewEvent(view, e)).filter((e): e is PmEvent => e !== null);
  }

  events(sinceId = 0, limit = 1000): PmEvent[] {
    return this.store.listEvents(sinceId, limit);
  }
}
