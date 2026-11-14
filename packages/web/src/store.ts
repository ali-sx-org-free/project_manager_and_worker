import { useMemo } from 'react';
import { create } from 'zustand';
import type { PmEvent, Project, Snapshot, Task, Worker } from '@agent-pm/core';

/** 只給動畫用的瞬時狀態，放在 React 之外，由 useFrame 每幀讀取 */
export const fx = {
  /** `${from}->${to}` → 光流開始時間（performance.now） */
  pulses: new Map<string, number>(),
  /** worker id → 最近一次心跳時間 */
  heartbeats: new Map<string, number>(),
};

export type Mode = 'connecting' | 'live' | 'demo';

export interface World {
  projects: Record<string, Project>;
  tasks: Record<string, Task>;
  workers: Record<string, Worker>;
}

interface State extends World {
  mode: Mode;
  events: PmEvent[];
  selected: string | null;
  view: '3d' | 'list';
  /** 'all' 或某個項目 id */
  focus: string;
  /** 回放：只看前 N 個事件時的世界；null 表示實時 */
  replayIdx: number | null;
  hello(snapshot: Snapshot, events: PmEvent[]): void;
  apply(event: PmEvent): void;
  set(patch: Partial<State>): void;
}

function applyTo(world: World, e: PmEvent) {
  if (e.project) {
    if (e.project.status === 'archived') {
      delete world.projects[e.project.id];
      for (const t of Object.values(world.tasks)) if (t.project_id === e.project.id) delete world.tasks[t.id];
    } else world.projects[e.project.id] = e.project;
  }
  for (const t of e.tasks ?? []) world.tasks[t.id] = t;
  if (e.task && world.projects[e.task.project_id]) world.tasks[e.task.id] = e.task;
  if (e.worker) world.workers[e.worker.id] = e.worker;
}

const MAX_EVENTS = 3000;

export const useStore = create<State>((set, get) => ({
  mode: 'connecting',
  projects: {},
  tasks: {},
  workers: {},
  events: [],
  selected: null,
  view: '3d',
  focus: 'all',
  replayIdx: null,

  hello(snapshot, events) {
    const by = <T extends { id: string }>(arr: T[]) => Object.fromEntries(arr.map((x) => [x.id, x]));
    set({
      projects: by(snapshot.projects),
      tasks: by(snapshot.tasks),
      workers: by(snapshot.workers),
      events: events.filter((e) => e.id > 0),
      replayIdx: null,
    });
  },

  apply(e) {
    if (e.type === 'heartbeat') {
      if (e.worker_id) fx.heartbeats.set(e.worker_id, performance.now());
      // 心跳只續約：更新租約到期時間，讓側欄的倒數跳回去
      const cur = e.task && get().tasks[e.task.id];
      if (cur && e.task) set({ tasks: { ...get().tasks, [cur.id]: { ...cur, lease_expires_at: e.task.lease_expires_at } } });
      return;
    }
    const s = get();
    const world: World = { projects: { ...s.projects }, tasks: { ...s.tasks }, workers: { ...s.workers } };
    applyTo(world, e);

    if (e.type === 'review_approved' && e.task_id) {
      // 完成時沿連線向下游放一道光
      const now = performance.now();
      for (const t of Object.values(world.tasks)) {
        if (t.deps.includes(e.task_id)) fx.pulses.set(`${e.task_id}->${t.id}`, now);
      }
    }
    let events = s.events;
    let replayIdx = s.replayIdx;
    if (e.id > 0) {
      events = [...events, e];
      if (events.length > MAX_EVENTS) {
        const drop = events.length - MAX_EVENTS;
        events = events.slice(drop);
        if (replayIdx !== null) replayIdx = Math.max(0, replayIdx - drop);
      }
    }
    const focus = s.focus !== 'all' && !world.projects[s.focus] ? 'all' : s.focus;
    set({ ...world, events, replayIdx, focus });
  },

  set: (patch) => set(patch),
}));

/** 目前應該顯示的世界：實時狀態，或回放到某個事件時的狀態 */
export function useWorld(): World {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const workers = useStore((s) => s.workers);
  const events = useStore((s) => s.events);
  const replayIdx = useStore((s) => s.replayIdx);
  return useMemo(() => {
    if (replayIdx === null) return { projects, tasks, workers };
    const world: World = { projects: {}, tasks: {}, workers: {} };
    for (let i = 0; i < replayIdx && i < events.length; i++) applyTo(world, events[i]);
    // 回放窗口之前就註冊的 worker 補上，當作閒置
    for (const w of Object.values(workers)) {
      if (!world.workers[w.id]) world.workers[w.id] = { ...w, current_task: null };
    }
    return world;
  }, [projects, tasks, workers, events, replayIdx]);
}

export const sortedProjects = (w: World) =>
  Object.values(w.projects).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
