import {
  Engine,
  MemoryStore,
  ROOT_USER,
  Simulator,
  httpApi,
  localApi,
  scoped,
  type Me,
  type PmApi,
  type PmEvent,
  type Snapshot,
} from '@agent-pm/core';
import { useStore } from './store.ts';

declare const __FORCE_DEMO__: boolean;

/** 網頁的數據來源有兩種：
 *  - live：連真實協調服務，WebSocket 收事件，REST 發批准/退回
 *  - demo：整個協調邏輯（同一份 Engine）和模擬器都跑在瀏覽器裡，不需要任何服務
 *
 *  兩種模式都支持「切換檢視身分」：以某個人的視角看，只看得到他參與的項目。
 *  live 模式下只有管理員（或服務沒有啟用鑒權時）能切換，過濾在服務端做。 */
export const backend: {
  api: PmApi | null;
  sim: Simulator | null;
  /** 換一個人的視角；null 回到自己 */
  viewAs: (userId: string | null) => void;
} = { api: null, sim: null, viewAs: () => {} };

const params = new URLSearchParams(location.search);

function serverBase(): string {
  const fromEnv = import.meta.env.VITE_PM_URL as string | undefined;
  if (fromEnv) return fromEnv;
  // vite 開發服務器跑在 5173，協調服務預設在 4000
  if (location.port === '5173') return `${location.protocol}//${location.hostname}:4000`;
  return location.origin;
}

function startDemo() {
  if (backend.sim) return;
  const leaseMs = 6000;
  const engine = new Engine(new MemoryStore(), { leaseMs });
  // 模擬器始終以管理員身分驅動；「檢視身分」只影響畫面上看得到什麼、你能按什麼
  const sim = new Simulator(localApi(engine), { leaseMs, speed: 1, seed: 7 });
  backend.sim = sim;

  let actor = ROOT_USER;
  let view: ReturnType<Engine['viewOf']> | null = null;
  let key = '';
  const visKey = () => [...engine.visibleProjects(actor)].sort().join(',');
  const hello = () => {
    const s = scoped(engine, actor);
    key = visKey();
    view = null;
    backend.api = localApi(engine, actor);
    const me: Me = actor === ROOT_USER ? { user: actor, auth: false } : { user: actor, auth: false, acting_for: ROOT_USER };
    useStore.getState().set({ me, mode: 'demo' });
    const snap = s.snapshot();
    if (actor === ROOT_USER) useStore.getState().set({ roster: snap.users });
    useStore.getState().hello(snap, s.events(0, 3000));
  };
  backend.viewAs = (userId) => {
    actor = (userId && engine.getUser(userId)) || ROOT_USER;
    hello();
  };
  hello();
  const RESCOPE = new Set(['project_created', 'project_archived', 'member_changed', 'worker_registered']);
  engine.on((e) => {
    if (actor.admin) return useStore.getState().apply(e);
    if (RESCOPE.has(e.type)) {
      if (visKey() !== key) return hello();
      view = null;
    }
    view ??= engine.viewOf(actor);
    const ev = engine.viewEvent(view, e);
    if (ev) useStore.getState().apply(ev);
  });
  setInterval(() => engine.tick(), 1000);
  void sim.start();
}

function startLive() {
  const base = serverBase();
  const token = params.get('token') ?? undefined;
  let actAs: string | undefined = params.get('as') ?? undefined;
  let everConnected = false;
  let ws: WebSocket | null = null;
  let gen = 0;

  const open = () => {
    const mine = ++gen;
    const api = httpApi(base, token, actAs);
    backend.api = api;
    const q = new URLSearchParams();
    if (token) q.set('token', token);
    if (actAs) q.set('as', actAs);
    ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws${q.size ? `?${q}` : ''}`);
    ws.onmessage = (msg) => {
      if (mine !== gen) return;
      const data = JSON.parse(msg.data) as
        | { type: 'hello'; snapshot: Snapshot; events: PmEvent[] }
        | { type: 'event'; event: PmEvent }
        | { type: 'error'; message: string };
      const store = useStore.getState();
      if (data.type === 'hello') {
        everConnected = true;
        store.hello(data.snapshot, data.events);
        store.set(actAs ? { mode: 'live' } : { mode: 'live', roster: data.snapshot.users ?? [] });
        void api.me().then((me) => mine === gen && useStore.getState().set({ me }));
      } else if (data.type === 'event') store.apply(data.event);
    };
    ws.onclose = (ev) => {
      if (mine !== gen) return;
      if (ev.code === 4401) {
        // token 不對：不要退回示範模式，免得讓人以為看到的是真實數據
        useStore.getState().set({ mode: 'denied' });
        return;
      }
      if (!everConnected) {
        // 沒有協調服務可連（例如直接打開靜態頁面），退回瀏覽器內模擬
        startDemo();
        return;
      }
      useStore.getState().set({ mode: 'connecting' });
      setTimeout(() => mine === gen && open(), 1500);
    };
  };
  backend.viewAs = (userId) => {
    actAs = userId ?? undefined;
    const old = ws;
    open();
    old?.close();
  };
  open();
}

export function connect() {
  if (__FORCE_DEMO__ || params.has('demo')) startDemo();
  else startLive();
}
