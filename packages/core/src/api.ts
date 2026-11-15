import type { Engine } from './engine.ts';
import { scoped, type CheckpointInput } from './access.ts';
import {
  PmError,
  type InterruptReason,
  type Me,
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

export type { CheckpointInput };

/** 協調服務對外的操作集合。REST、MCP 工具、瀏覽器示範模式都是這同一組操作的不同傳輸方式。 */
export interface PmApi {
  snapshot(): Promise<Snapshot>;
  events(sinceId?: number): Promise<PmEvent[]>;
  createProject(input: ProjectInput): Promise<{ project: Project; tasks: Task[] }>;
  updateProject(id: string, patch: ProjectPatch): Promise<Project>;
  archiveProject(id: string): Promise<Project>;
  setMember(projectId: string, userId: string, role: ProjectRole | null): Promise<Member[]>;
  /** 建立用戶。走 HTTP 時返回一次性顯示的 token；本地模式沒有 token */
  createUser(input: UserInput): Promise<{ user: User; token?: string }>;
  registerWorker(input: WorkerInput): Promise<Worker>;
  listClaimable(workerId: string): Promise<Task[]>;
  claimTask(workerId: string, taskId?: string): Promise<Task | null>;
  heartbeat(workerId: string, taskId: string): Promise<{ lease_expires_at: number }>;
  submitResult(workerId: string, taskId: string, result: { summary: string; pr_url?: string }): Promise<Task>;
  saveCheckpoint(workerId: string, taskId: string, cp: CheckpointInput): Promise<{ seq: number; lease_expires_at: number }>;
  reportBlocked(workerId: string, taskId: string, reason: string): Promise<Task>;
  releaseTask(workerId: string, taskId: string, opts?: { reason?: InterruptReason; note?: string }): Promise<Task>;
  unblock(taskId: string, by?: string): Promise<Task>;
  review(
    taskId: string,
    r: { reviewer?: string; decision: 'approve' | 'reject'; comment?: string },
  ): Promise<Task>;
  getTask(id: string): Promise<Task>;
}

/** 直接調用同進程內的 Engine（瀏覽器示範模式、測試）。actor 是「以誰的身分」，預設是內建管理員 */
export function localApi(engine: Engine, actor?: User): PmApi {
  const s = scoped(engine, actor);
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    async (...a: A): Promise<R> =>
      fn(...a);
  return {
    snapshot: wrap(() => s.snapshot()),
    events: wrap((since?: number) => s.events(since)),
    createProject: wrap((i: ProjectInput) => s.createProject(i)),
    updateProject: wrap((id: string, patch: ProjectPatch) => s.updateProject(id, patch)),
    archiveProject: wrap((id: string) => s.archiveProject(id)),
    setMember: wrap((p: string, u: string, role: ProjectRole | null) => s.setMember(p, u, role)),
    createUser: wrap((i: UserInput) => ({ user: s.upsertUser(i) })),
    registerWorker: wrap((i: WorkerInput) => s.registerWorker(i)),
    listClaimable: wrap((w: string) => s.listClaimable(w)),
    claimTask: wrap((w: string, t?: string) => s.claimTask(w, t)),
    heartbeat: wrap((w: string, t: string) => s.heartbeat(w, t)),
    submitResult: wrap((w: string, t: string, r: { summary: string; pr_url?: string }) => s.submitResult(w, t, r)),
    reportBlocked: wrap((w: string, t: string, reason: string) => s.reportBlocked(w, t, reason)),
    saveCheckpoint: wrap((w: string, t: string, cp: CheckpointInput) => s.saveCheckpoint(w, t, cp)),
    releaseTask: wrap((w: string, t: string, opts?: { reason?: InterruptReason; note?: string }) =>
      s.releaseTask(w, t, opts),
    ),
    unblock: wrap((t: string, by?: string) => s.unblock(t, by)),
    review: wrap((t: string, r: { reviewer?: string; decision: 'approve' | 'reject'; comment?: string }) =>
      s.review(t, r),
    ),
    getTask: wrap((id: string) => s.getTask(id)),
  };
}

/** 通過 REST 調用遠端協調服務（模擬器、runner、網頁都用它） */
export function httpApi(baseUrl: string, token?: string, actAs?: string): PmApi & { me(): Promise<Me> } {
  const base = baseUrl.replace(/\/$/, '');
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(actAs ? { 'x-act-as': actAs } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new PmError(data?.error?.code ?? 'invalid', data?.error?.message ?? `HTTP ${res.status}`);
    }
    return data as T;
  }
  const enc = encodeURIComponent;
  return {
    snapshot: () => call('GET', '/api/state'),
    events: (since = 0) => call('GET', `/api/events?since=${since}`),
    createProject: (input) => call('POST', '/api/projects', input),
    updateProject: (id, patch) => call('PATCH', `/api/projects/${enc(id)}`, patch),
    archiveProject: (id) => call('POST', `/api/projects/${enc(id)}/archive`),
    setMember: (projectId, userId, role) =>
      role
        ? call('PUT', `/api/projects/${enc(projectId)}/members/${enc(userId)}`, { role })
        : call('DELETE', `/api/projects/${enc(projectId)}/members/${enc(userId)}`),
    createUser: (input) => call('POST', '/api/users', input),
    me: () => call('GET', '/api/me'),
    registerWorker: (input) => call('POST', '/api/workers/register', input),
    listClaimable: (workerId) => call('GET', `/api/tasks/claimable?worker_id=${enc(workerId)}`),
    claimTask: (workerId, taskId) => call('POST', '/api/tasks/claim', { worker_id: workerId, task_id: taskId }),
    heartbeat: (workerId, taskId) => call('POST', `/api/tasks/${enc(taskId)}/heartbeat`, { worker_id: workerId }),
    submitResult: (workerId, taskId, result) =>
      call('POST', `/api/tasks/${enc(taskId)}/submit`, { worker_id: workerId, ...result }),
    reportBlocked: (workerId, taskId, reason) =>
      call('POST', `/api/tasks/${enc(taskId)}/block`, { worker_id: workerId, reason }),
    saveCheckpoint: (workerId, taskId, cp) =>
      call('POST', `/api/tasks/${enc(taskId)}/checkpoint`, { worker_id: workerId, ...cp }),
    releaseTask: (workerId, taskId, opts) =>
      call('POST', `/api/tasks/${enc(taskId)}/release`, { worker_id: workerId, ...opts }),
    unblock: (taskId, by) => call('POST', `/api/tasks/${enc(taskId)}/unblock`, { by }),
    review: (taskId, r) => call('POST', `/api/tasks/${enc(taskId)}/review`, r),
    getTask: (id) => call('GET', `/api/tasks/${enc(id)}`),
  };
}
