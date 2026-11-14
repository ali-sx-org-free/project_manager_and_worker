import type { Engine } from './engine.ts';
import {
  PmError,
  type PmEvent,
  type Project,
  type ProjectInput,
  type Snapshot,
  type Task,
  type Worker,
  type WorkerInput,
} from './types.ts';

/** 協調服務對外的操作集合。REST、MCP 工具、瀏覽器示範模式都是這同一組操作的不同傳輸方式。 */
export interface PmApi {
  snapshot(): Promise<Snapshot>;
  events(sinceId?: number): Promise<PmEvent[]>;
  createProject(input: ProjectInput): Promise<{ project: Project; tasks: Task[] }>;
  archiveProject(id: string): Promise<Project>;
  registerWorker(input: WorkerInput): Promise<Worker>;
  listClaimable(workerId: string): Promise<Task[]>;
  claimTask(workerId: string, taskId?: string): Promise<Task | null>;
  heartbeat(workerId: string, taskId: string): Promise<{ lease_expires_at: number }>;
  submitResult(workerId: string, taskId: string, result: { summary: string; pr_url?: string }): Promise<Task>;
  reportBlocked(workerId: string, taskId: string, reason: string): Promise<Task>;
  releaseTask(workerId: string, taskId: string): Promise<Task>;
  unblock(taskId: string, by?: string): Promise<Task>;
  review(
    taskId: string,
    r: { reviewer?: string; decision: 'approve' | 'reject'; comment?: string },
  ): Promise<Task>;
  getTask(id: string): Promise<Task>;
}

/** 直接調用同進程內的 Engine（瀏覽器示範模式、測試） */
export function localApi(engine: Engine): PmApi {
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    async (...a: A): Promise<R> =>
      fn(...a);
  return {
    snapshot: wrap(() => engine.snapshot()),
    events: wrap((since?: number) => engine.events(since)),
    createProject: wrap((i: ProjectInput) => engine.createProject(i)),
    archiveProject: wrap((id: string) => engine.archiveProject(id)),
    registerWorker: wrap((i: WorkerInput) => engine.registerWorker(i)),
    listClaimable: wrap((w: string) => engine.listClaimable(w)),
    claimTask: wrap((w: string, t?: string) => engine.claimTask(w, t)),
    heartbeat: wrap((w: string, t: string) => engine.heartbeat(w, t)),
    submitResult: wrap((w: string, t: string, r: { summary: string; pr_url?: string }) =>
      engine.submitResult(w, t, r),
    ),
    reportBlocked: wrap((w: string, t: string, reason: string) => engine.reportBlocked(w, t, reason)),
    releaseTask: wrap((w: string, t: string) => engine.releaseTask(w, t)),
    unblock: wrap((t: string, by?: string) => engine.unblock(t, by)),
    review: wrap((t: string, r: { reviewer?: string; decision: 'approve' | 'reject'; comment?: string }) =>
      engine.review(t, r),
    ),
    getTask: wrap((id: string) => engine.getTask(id)),
  };
}

/** 通過 REST 調用遠端協調服務（模擬器、runner、網頁都用它） */
export function httpApi(baseUrl: string, token?: string): PmApi {
  const base = baseUrl.replace(/\/$/, '');
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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
    archiveProject: (id) => call('POST', `/api/projects/${enc(id)}/archive`),
    registerWorker: (input) => call('POST', '/api/workers/register', input),
    listClaimable: (workerId) => call('GET', `/api/tasks/claimable?worker_id=${enc(workerId)}`),
    claimTask: (workerId, taskId) => call('POST', '/api/tasks/claim', { worker_id: workerId, task_id: taskId }),
    heartbeat: (workerId, taskId) => call('POST', `/api/tasks/${enc(taskId)}/heartbeat`, { worker_id: workerId }),
    submitResult: (workerId, taskId, result) =>
      call('POST', `/api/tasks/${enc(taskId)}/submit`, { worker_id: workerId, ...result }),
    reportBlocked: (workerId, taskId, reason) =>
      call('POST', `/api/tasks/${enc(taskId)}/block`, { worker_id: workerId, reason }),
    releaseTask: (workerId, taskId) => call('POST', `/api/tasks/${enc(taskId)}/release`, { worker_id: workerId }),
    unblock: (taskId, by) => call('POST', `/api/tasks/${enc(taskId)}/unblock`, { by }),
    review: (taskId, r) => call('POST', `/api/tasks/${enc(taskId)}/review`, r),
    getTask: (id) => call('GET', `/api/tasks/${enc(id)}`),
  };
}
