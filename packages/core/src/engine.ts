import type { Store } from './store.ts';
import {
  PmError,
  type EventType,
  type PmEvent,
  type Project,
  type ProjectInput,
  type Review,
  type Snapshot,
  type Task,
  type Worker,
  type WorkerInput,
} from './types.ts';

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

    return this.run(() => {
      const now = this.nowFn();
      const project: Project = {
        id: rid('p'),
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
        created_at: now,
        updated_at: now,
      }));
      for (const t of tasks) this.store.insertTask(t);

      this.emit('project_created', `PM 建立項目「${project.title}」，拆解為 ${tasks.length} 個任務`, {
        project_id: project.id,
        project,
        tasks,
      });
      return { project, tasks };
    });
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

  /** 這個 worker 目前可以領取的任務：ready 或 changes_requested，且能力標籤滿足。 */
  listClaimable(workerId: string): Task[] {
    const w = this.mustWorker(workerId);
    const active = new Set(
      this.store
        .listProjects()
        .filter((p) => p.status === 'active')
        .map((p) => p.id),
    );
    return this.store
      .listTasks()
      .filter(
        (t) =>
          active.has(t.project_id) &&
          (t.state === 'ready' || t.state === 'changes_requested') &&
          this.canDo(w, t),
      )
      .sort((a, b) => {
        // 被退回的任務優先還給原來的人
        const mine = (t: Task) => (t.state === 'changes_requested' && t.last_assignee === w.id ? 0 : 1);
        return mine(a) - mine(b) || a.created_at - b.created_at;
      });
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
        throw new PmError('conflict', `任務「${t.title}」目前不可領取（狀態 ${t.state}，或能力標籤不符）`);
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
        this.emit('task_claimed', `${w.name} 領取「${next.title}」`, {
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

  /** worker 主動放棄，任務回到任務池 */
  releaseTask(workerId: string, taskId: string): Task {
    return this.run(() => {
      const { w, t } = this.mustHold(workerId, taskId);
      t.state = 'ready';
      t.assignee = null;
      t.last_assignee = w.id;
      t.lease_expires_at = null;
      t.updated_at = this.nowFn();
      this.store.updateTask(t);
      const freed = this.freeWorker(w.id);
      this.emit('task_released', `${w.name} 釋放「${t.title}」`, {
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
        this.emit('lease_expired', `「${t.title}」租約超時（${w?.name ?? holder} 失聯），回到任務池`, {
          project_id: t.project_id,
          task_id: t.id,
          worker_id: holder ?? undefined,
          task: next,
          worker: w,
        });
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

  snapshot(includeArchived = false): Snapshot {
    const projects = this.store.listProjects().filter((p) => includeArchived || p.status !== 'archived');
    const ids = new Set(projects.map((p) => p.id));
    return {
      server_time: this.nowFn(),
      lease_ms: this.leaseMs,
      projects,
      tasks: this.store.listTasks().filter((t) => ids.has(t.project_id)),
      workers: this.store.listWorkers(),
      last_event_id: this.store.lastEventId(),
    };
  }

  events(sinceId = 0, limit = 1000): PmEvent[] {
    return this.store.listEvents(sinceId, limit);
  }
}
