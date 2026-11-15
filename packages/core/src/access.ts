import { ROOT_USER, type Engine } from './engine.ts';
import {
  PmError,
  type InterruptReason,
  type Member,
  type PmEvent,
  type Project,
  type ProjectInput,
  type ProjectPatch,
  type ProjectRole,
  type Snapshot,
  type Task,
  type User,
  type UserInput,
  type Worker,
  type WorkerInput,
} from './types.ts';

export interface CheckpointInput {
  summary: string;
  next_steps?: string;
  progress?: number;
  commit?: string;
  artifacts?: string[];
  auto?: boolean;
}

/** 帶著「誰在操作」的 Engine。REST、MCP、瀏覽器示範模式都經過這一層，權限規則只寫在這裡：
 *
 *  | 操作                                   | 需要                         |
 *  | -------------------------------------- | ---------------------------- |
 *  | 看項目、任務、事件                     | 是項目成員（任何角色）       |
 *  | worker 領取、心跳、檢查點、交付        | 是這個 worker 的主人；且主人在項目裡是 manager 或 contributor |
 *  | review、解除阻塞、改優先級和配額、管成員、歸檔 | 項目的 manager        |
 *  | 建立用戶                               | 管理員                       |
 *
 *  管理員在所有項目裡都當作 manager。 */
export class Scoped {
  constructor(
    private engine: Engine,
    readonly actor: User,
  ) {}

  private get isRoot() {
    return this.actor.id === ROOT_USER.id;
  }

  /** 看不到的項目一律說「不存在」，不洩漏它存在 */
  private project(id: string, ...roles: ProjectRole[]): Project {
    let p: Project;
    try {
      p = this.engine.getProject(id);
    } catch {
      throw new PmError('not_found', `項目 ${id} 不存在`);
    }
    const role = this.engine.roleOf(this.actor, p.id);
    if (!role) throw new PmError('not_found', `項目 ${id} 不存在`);
    if (roles.length && !roles.includes(role)) {
      throw new PmError('forbidden', `${this.actor.name} 在項目「${p.title}」裡沒有這個權限（需要 ${roles.join(' 或 ')}）`);
    }
    return p;
  }

  private task(id: string, ...roles: ProjectRole[]): Task {
    let t: Task;
    try {
      t = this.engine.getTask(id);
    } catch {
      throw new PmError('not_found', `任務 ${id} 不存在`);
    }
    try {
      this.project(t.project_id, ...roles);
    } catch (err) {
      if (err instanceof PmError && err.code === 'not_found') throw new PmError('not_found', `任務 ${id} 不存在`);
      throw err;
    }
    return t;
  }

  private worker(id: string): Worker {
    const w = this.engine.getWorker(id);
    if (!this.actor.admin && w.owner !== this.actor.id) {
      throw new PmError('forbidden', `worker ${id} 不屬於 ${this.actor.name}`);
    }
    return w;
  }

  // ── 查詢 ──
  snapshot(): Snapshot {
    return this.engine.viewSnapshot(this.actor);
  }
  events(sinceId = 0, limit = 1000): PmEvent[] {
    return this.engine.viewEvents(this.actor, sinceId, limit);
  }
  getTask(id: string): Task {
    return this.task(id);
  }

  // ── 項目 ──
  createProject(input: ProjectInput): { project: Project; tasks: Task[] } {
    const members = [...(input?.members ?? [])];
    // 建項目的人自動成為負責人（管理員本來就能管所有項目，不用加）
    if (!this.actor.admin && !members.some((m) => m.user_id === this.actor.id)) {
      members.push({ user_id: this.actor.id, role: 'manager' });
    }
    return this.engine.createProject({ ...input, members });
  }
  updateProject(id: string, patch: ProjectPatch): Project {
    return this.engine.updateProject(this.project(id, 'manager').id, patch, this.isRoot ? 'PM' : this.actor.name);
  }
  archiveProject(id: string): Project {
    return this.engine.archiveProject(this.project(id, 'manager').id);
  }
  setMember(projectId: string, userId: string, role: ProjectRole | null): Member[] {
    return this.engine.setMember(this.project(projectId, 'manager').id, userId, role, this.isRoot ? 'PM' : this.actor.name);
  }

  // ── 用戶 ──
  upsertUser(input: UserInput, tokenHash?: string | null): User {
    if (!this.actor.admin) throw new PmError('forbidden', '只有管理員可以建立用戶');
    return this.engine.upsertUser(input, tokenHash);
  }

  // ── worker ──
  registerWorker(input: WorkerInput): Worker {
    let prev: Worker | undefined;
    try {
      prev = this.engine.getWorker(input?.id);
    } catch {
      prev = undefined;
    }
    if (prev && !this.actor.admin && prev.owner !== this.actor.id) {
      throw new PmError('forbidden', `worker ${input.id} 已經登記在別人名下`);
    }
    let owner: string | null;
    if (!this.actor.admin) owner = this.actor.id;
    else if (input.owner !== undefined) owner = input.owner;
    else owner = prev ? prev.owner : this.isRoot ? null : this.actor.id;
    if (owner && !this.engine.getUser(owner)) throw new PmError('not_found', `用戶 ${owner} 不存在`);
    return this.engine.registerWorker({ ...input, owner });
  }
  listClaimable(workerId: string): Task[] {
    return this.engine.listClaimable(this.worker(workerId).id);
  }
  claimTask(workerId: string, taskId?: string): Task | null {
    return this.engine.claimTask(this.worker(workerId).id, taskId);
  }
  heartbeat(workerId: string, taskId: string) {
    return this.engine.heartbeat(this.worker(workerId).id, taskId);
  }
  saveCheckpoint(workerId: string, taskId: string, cp: CheckpointInput) {
    return this.engine.saveCheckpoint(this.worker(workerId).id, taskId, cp);
  }
  submitResult(workerId: string, taskId: string, result: { summary: string; pr_url?: string }): Task {
    return this.engine.submitResult(this.worker(workerId).id, taskId, result);
  }
  reportBlocked(workerId: string, taskId: string, reason: string): Task {
    return this.engine.reportBlocked(this.worker(workerId).id, taskId, reason);
  }
  releaseTask(workerId: string, taskId: string, opts?: { reason?: InterruptReason; note?: string }): Task {
    return this.engine.releaseTask(this.worker(workerId).id, taskId, opts);
  }

  // ── review ──
  /** 啟用鑒權後，review 記錄上的名字一律是 token 對應的人，不能自己填 */
  review(taskId: string, r: { reviewer?: string; decision: 'approve' | 'reject'; comment?: string }): Task {
    this.task(taskId, 'manager');
    return this.engine.review(taskId, { ...r, reviewer: this.isRoot ? r?.reviewer : this.actor.name });
  }
  unblock(taskId: string, by?: string): Task {
    this.task(taskId, 'manager');
    return this.engine.unblock(taskId, this.isRoot ? by : this.actor.name);
  }
}

export const scoped = (engine: Engine, actor: User = ROOT_USER) => new Scoped(engine, actor);
