import { Simulator, httpApi } from '@agent-pm/core';

const url = process.env.PM_URL ?? 'http://localhost:4000';
const api = httpApi(url, process.env.PM_TOKEN);
const speed = Number(process.env.SIM_SPEED ?? 1);

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      return await api.snapshot();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`連不上協調服務 ${url}`);
}

const snap = await waitForServer();
console.log(`[sim] 已連上 ${url}，租約 ${snap.lease_ms}ms，速度 x${speed}`);
if (snap.lease_ms > 60_000) {
  console.log('[sim] 提示：租約較長，模擬的「斷線」要等很久才會被回收。示範時建議 LEASE_MS=6000');
}

const sim = new Simulator(api, {
  leaseMs: snap.lease_ms,
  speed,
  seed: Number(process.env.SIM_SEED ?? 7),
  log: (m) => console.log(`[sim] ${m}`),
});
await sim.start();

process.on('SIGINT', () => {
  sim.stop();
  process.exit(0);
});
