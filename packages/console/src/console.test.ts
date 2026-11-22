import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { StateFile, WorkerOps, type HubSnapshot } from '@agent-pm/github';
import type { PmEvent } from '@agent-pm/core';
import { startFakeHub } from './fake.ts';
import { ConsoleServer } from './server.ts';

let fake: Awaited<ReturnType<typeof startFakeHub>>;
let server: ConsoleServer;
let url: string;

before(async () => {
  fake = await startFakeHub({ sim: false, log: () => undefined });
  server = new ConsoleServer({ hub: fake.hub, port: 0, intervalMs: 60_000, log: () => undefined });
  url = await server.start();
});
after(async () => {
  fake.stop();
  await server.close();
});

const raw = (method: string, path: string, headers: Record<string, string>, body?: string) =>
  new Promise<{ status: number; text: string }>((res, rej) => {
    const u = new URL(url);
    const req = http.request({ host: '127.0.0.1', port: u.port, path, method, headers }, (r) => {
      let text = '';
      r.on('data', (d) => (text += d));
      r.on('end', () => res({ status: r.statusCode ?? 0, text }));
    });
    req.on('error', rej);
    req.end(body);
  });

test('管理端：網頁收到快照和事件，按鈕的操作寫回 hub', async () => {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`);
  const msgs: { type: string; snapshot?: HubSnapshot; events?: PmEvent[]; event?: PmEvent; hub?: { name: string } }[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
  for (let i = 0; i < 50 && !msgs.some((m) => m.type === 'hello'); i++) await new Promise((r) => setTimeout(r, 100));
  const hello = msgs.find((m) => m.type === 'hello')!;
  assert.ok(hello, '沒收到 hello');
  assert.equal(hello.hub!.name, 'demo/agent-pm-hub');
  assert.ok(hello.snapshot!.projects.length >= 2);
  assert.ok(hello.events!.some((e) => e.type === 'project_created'));

  // 一個 worker 領取並交付
  const w = new WorkerOps(fake.hub, { id: 'test-w', name: 'test-w', machine: 't', labels: ['code', 'docs'], projects: null, owner: 'you' }, new StateFile('demo/agent-pm-hub', 'test-w'));
  const c = (await w.claim())!;
  await w.submit({ summary: '完成' });
  await fetch(`${url}/api/hub/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  for (let i = 0; i < 30 && !msgs.some((m) => m.event?.type === 'task_submitted'); i++) await new Promise((r) => setTimeout(r, 100));
  const types = msgs.filter((m) => m.type === 'event').map((m) => m.event!.type);
  assert.ok(types.includes('task_claimed'), types.join(','));
  assert.ok(types.includes('task_submitted'), types.join(','));

  // 網頁上按「批准」
  const r = await fetch(`${url}/api/tasks/${c.task.number}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', comment: '好' }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const t = (await r.json()) as { state: string };
  assert.equal(t.state, 'done');
  for (let i = 0; i < 30 && !msgs.some((m) => m.event?.type === 'review_approved'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(msgs.some((m) => m.event?.type === 'review_approved'));
  // 事件編號遞增
  const ids = msgs.filter((m) => m.type === 'event' && m.event!.id > 0).map((m) => m.event!.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));

  // 改優先級
  const pid = hello.snapshot!.projects[0].id;
  const p = await fetch(`${url}/api/projects/${pid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ priority: 5 }) });
  assert.equal(((await p.json()) as { priority: number }).priority, 5);
  ws.close();

  const hubInfo = (await (await fetch(`${url}/api/hub`)).json()) as { roster: unknown[]; locks: unknown[] };
  assert.ok(hubInfo.locks.length >= 1);
});

test('管理端只接受本機、同源、JSON 的寫入請求', async () => {
  const u = new URL(url);
  const evilHost = await raw('GET', '/api/state', { host: `evil.example:${u.port}` });
  assert.equal(evilHost.status, 403);
  const textPlain = await raw('POST', '/api/hub/reconcile', { host: `localhost:${u.port}`, 'content-type': 'text/plain' }, '{}');
  assert.equal(textPlain.status, 415);
  const crossOrigin = await raw('POST', '/api/hub/reconcile', { host: `localhost:${u.port}`, 'content-type': 'application/json', origin: 'https://evil.example' }, '{}');
  assert.equal(crossOrigin.status, 403);
  const ok = await raw('GET', '/api/me', { host: `localhost:${u.port}` });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.text).user.id, 'you');
});
