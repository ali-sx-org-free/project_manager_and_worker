import { Engine, MemoryStore, Simulator, httpApi, localApi, type PmApi, type PmEvent, type Snapshot } from '@agent-pm/core';
import { useStore } from './store.ts';

declare const __FORCE_DEMO__: boolean;

/** 網頁的數據來源有兩種：
 *  - live：連真實協調服務，WebSocket 收事件，REST 發批准/退回
 *  - demo：整個協調邏輯（同一份 Engine）和模擬器都跑在瀏覽器裡，不需要任何服務 */
export const backend: { api: PmApi | null; sim: Simulator | null } = { api: null, sim: null };

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
  const api = localApi(engine);
  const sim = new Simulator(api, { leaseMs, speed: 1, seed: 7 });
  backend.api = api;
  backend.sim = sim;
  const store = useStore.getState();
  store.hello(engine.snapshot(), []);
  store.set({ mode: 'demo' });
  engine.on((e) => useStore.getState().apply(e));
  setInterval(() => engine.tick(), 1000);
  void sim.start();
}

function startLive() {
  const base = serverBase();
  backend.api = httpApi(base, params.get('token') ?? undefined);
  let everConnected = false;

  const open = () => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data) as
        | { type: 'hello'; snapshot: Snapshot; events: PmEvent[] }
        | { type: 'event'; event: PmEvent };
      const store = useStore.getState();
      if (data.type === 'hello') {
        everConnected = true;
        store.hello(data.snapshot, data.events);
        store.set({ mode: 'live' });
      } else store.apply(data.event);
    };
    ws.onclose = () => {
      if (!everConnected) {
        // 沒有協調服務可連（例如直接打開靜態頁面），退回瀏覽器內模擬
        startDemo();
        return;
      }
      useStore.getState().set({ mode: 'connecting' });
      setTimeout(open, 1500);
    };
  };
  open();
}

export function connect() {
  if (__FORCE_DEMO__ || params.has('demo')) startDemo();
  else startLive();
}
