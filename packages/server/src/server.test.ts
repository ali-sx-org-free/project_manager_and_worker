import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import { httpApi, type PmEvent } from '@agent-pm/core';
import { createServer } from './app.ts';

let base = '';
let srv: ReturnType<typeof createServer>;

before(async () => {
  srv = createServer({ dbFile: ':memory:', leaseMs: 60_000 });
  await new Promise<void>((r) => srv.server.listen(0, r));
  base = `http://localhost:${(srv.server.address() as AddressInfo).port}`;
});
after(() => srv.close());

test('REST：20 個 worker 同時搶 5 個任務，每個任務只被領一次', async () => {
  const api = httpApi(base);
  await api.createProject({
    title: '搶任務',
    tasks: Array.from({ length: 5 }, (_, i) => ({ key: `t${i}`, title: `任務 ${i}` })),
  });
  const workers = Array.from({ length: 20 }, (_, i) => `racer-${i}`);
  await Promise.all(workers.map((id) => api.registerWorker({ id })));
  const claimed = (await Promise.all(workers.map((id) => api.claimTask(id)))).filter(Boolean);
  assert.equal(claimed.length, 5);
  assert.equal(new Set(claimed.map((t) => t!.id)).size, 5);
});

test('REST：錯誤會帶上 code，例如拆解出有環的圖', async () => {
  const api = httpApi(base);
  await assert.rejects(
    api.createProject({
      title: '環',
      tasks: [
        { key: 'a', title: 'A', deps: ['b'] },
        { key: 'b', title: 'B', deps: ['a'] },
      ],
    }),
    /有向無環圖/,
  );
});

test('MCP + WebSocket：PM 拆解、worker 領取交付、PM review，事件實時推送', async () => {
  const events: PmEvent[] = [];
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  await new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'hello') resolve();
      if (msg.type === 'event') events.push(msg.event);
    });
  });

  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    const text = res.content[0].text;
    if (res.isError) throw new Error(text);
    return JSON.parse(text);
  };

  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const name of ['claim_task', 'heartbeat', 'submit_result', 'review_task', 'create_project']) {
    assert.ok(tools.includes(name), `缺少 MCP 工具 ${name}`);
  }

  const { project, tasks } = await call('create_project', {
    title: 'MCP 項目',
    tasks: [
      { key: 'a', title: '第一步', labels: ['mcp-test'] },
      { key: 'b', title: '第二步', labels: ['mcp-test'], deps: ['a'] },
    ],
  });
  await call('register_worker', { worker_id: 'mcp-w', name: 'MCP worker', labels: ['mcp-test'] });

  const claimed = await call('claim_task', { worker_id: 'mcp-w' });
  assert.equal(claimed.task.id, tasks[0].id);
  await call('heartbeat', { worker_id: 'mcp-w', task_id: claimed.task.id });
  await call('submit_result', {
    worker_id: 'mcp-w',
    task_id: claimed.task.id,
    summary: '完成',
    pr_url: 'https://github.com/example/repo/pull/1',
  });
  await assert.rejects(call('heartbeat', { worker_id: 'mcp-w', task_id: claimed.task.id }), /lease_lost/);

  const reviewed = await call('review_task', { task_id: claimed.task.id, decision: 'approve', comment: '可以' });
  assert.equal(reviewed.state, 'done');
  const next = await call('list_ready_tasks', { worker_id: 'mcp-w' });
  assert.deepEqual(
    next.map((t: { key: string }) => t.key),
    ['b'],
  );

  await new Promise((r) => setTimeout(r, 50));
  const types = events.filter((e) => e.project_id === project.id || e.worker_id === 'mcp-w').map((e) => e.type);
  for (const t of ['project_created', 'task_claimed', 'heartbeat', 'task_submitted', 'review_approved', 'task_ready']) {
    assert.ok(types.includes(t as PmEvent['type']), `WebSocket 沒收到 ${t}`);
  }
  await client.close();
  ws.close();
});

test('續作：檢查點經 MCP 保存，交接後另一個 worker 領取時拿到 resume；協調服務重啟也不丟', async () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pm-')), 'pm.db');
  const start = async () => {
    const s = createServer({ dbFile, leaseMs: 60_000 });
    await new Promise<void>((r) => s.server.listen(0, r));
    const url = `http://localhost:${(s.server.address() as AddressInfo).port}`;
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp')));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      if (res.isError) throw new Error(res.content[0].text);
      return JSON.parse(res.content[0].text);
    };
    return { s, client, call };
  };

  let run = await start();
  await run.call('create_project', { title: '續作', tasks: [{ key: 'a', title: '長任務' }] });
  await run.call('register_worker', { worker_id: 'first', name: '先手' });
  await run.call('register_worker', { worker_id: 'second', name: '後手' });
  const first = await run.call('claim_task', { worker_id: 'first' });
  assert.equal(first.resume, null);
  await run.call('save_checkpoint', {
    worker_id: 'first',
    task_id: first.task.id,
    summary: '完成前三步',
    next_steps: '從第四步開始',
    progress: 60,
    commit: 'deadbeef',
  });
  await run.call('release_task', {
    worker_id: 'first',
    task_id: first.task.id,
    reason: 'usage_limit',
    note: '額度用完',
  });

  // 協調服務重啟：檢查點存在 SQLite 裡
  await run.client.close();
  await run.s.close();
  run = await start();

  const second = await run.call('claim_task', { worker_id: 'second' });
  assert.equal(second.task.id, first.task.id);
  assert.equal(second.task.attempt, 2);
  assert.equal(second.resume.progress, 60);
  assert.equal(second.resume.summary, '完成前三步');
  assert.equal(second.resume.next_steps, '從第四步開始');
  assert.equal(second.resume.commit, 'deadbeef');
  assert.equal(second.resume.reason, 'usage_limit');
  assert.equal(second.resume.from_worker, 'first');
  assert.equal(second.resume.branch, first.task.branch);
  await run.client.close();
  await run.s.close();
});

test('REST：並行配額在併發下不會超發（20 個 worker 同時搶配額為 2 的項目）', async () => {
  const api = httpApi(base);
  const { project } = await api.createProject({
    title: '配額',
    key: 'quota',
    priority: 5,
    max_parallel: 2,
    tasks: Array.from({ length: 6 }, (_, i) => ({ key: `q${i}`, title: `配額任務 ${i}`, labels: ['quota-only'] })),
  });
  const workers = Array.from({ length: 20 }, (_, i) => `quota-${i}`);
  await Promise.all(workers.map((id) => api.registerWorker({ id, labels: ['quota-only'], projects: ['quota'] })));
  const claimed = (await Promise.all(workers.map((id) => api.claimTask(id)))).filter(Boolean);
  assert.equal(claimed.length, 2);
  const snap = await api.snapshot();
  assert.equal(snap.tasks.filter((t) => t.project_id === project.id && t.state === 'claimed').length, 2);
});

test('鑒權：每個人用自己的 token，只看得到自己參與的項目（REST、WebSocket、MCP 一致）', async () => {
  const s = createServer({ dbFile: ':memory:', leaseMs: 60_000, token: 'admin-secret' });
  await new Promise<void>((r) => s.server.listen(0, r));
  const url = `http://localhost:${(s.server.address() as AddressInfo).port}`;
  try {
    // 沒有 token 或 token 不對：讀也不行
    assert.equal((await fetch(`${url}/api/state`)).status, 401);
    assert.equal((await fetch(`${url}/api/state`, { headers: { authorization: 'Bearer nope' } })).status, 401);

    const admin = httpApi(url, 'admin-secret');
    const amy = await admin.createUser({ id: 'amy', name: 'Amy' });
    const bob = await admin.createUser({ id: 'bob', name: 'Bob' });
    assert.match(amy.token!, /^pm_/);
    const asAmy = httpApi(url, amy.token);
    const asBob = httpApi(url, bob.token);
    assert.equal((await asAmy.me()).user.id, 'amy');
    // 普通用戶不能建用戶
    await assert.rejects(asAmy.createUser({ name: '新人' }), /只有管理員/);

    const task = (key: string) => [{ key: 'a', title: `${key} 的任務` }];
    await admin.createProject({ title: 'Amy 的項目', key: 'amys', tasks: task('amys'), members: [{ user_id: 'amy', role: 'contributor' }] });
    const bobs = await admin.createProject({ title: 'Bob 的項目', key: 'bobs', tasks: task('bobs'), members: [{ user_id: 'bob', role: 'manager' }] });

    assert.deepEqual((await admin.snapshot()).projects.map((p) => p.key), ['amys', 'bobs']);
    assert.deepEqual((await asAmy.snapshot()).projects.map((p) => p.key), ['amys']);
    assert.deepEqual((await asBob.snapshot()).projects.map((p) => p.key), ['bobs']);
    // 管理員可以用別人的視角看；普通用戶不行
    assert.deepEqual((await httpApi(url, 'admin-secret', 'amy').snapshot()).projects.map((p) => p.key), ['amys']);
    await assert.rejects(httpApi(url, amy.token, 'bob').snapshot(), /只有管理員/);

    // worker 登記在 token 的主人名下，只領得到主人參與的項目
    assert.equal((await asAmy.registerWorker({ id: 'amy-pc' })).owner, 'amy');
    assert.equal((await asAmy.claimTask('amy-pc'))!.project_key, 'amys');
    await assert.rejects(asBob.claimTask('amy-pc'), /不屬於/);
    // Amy 不是 bobs 的成員：看不到它的任務，也不能 review
    await assert.rejects(asAmy.getTask(bobs.tasks[0].id), /不存在/);

    // MCP 也按 token 過濾
    const mcp = async (token: string) => {
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
      );
      const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[] };
      await client.close();
      return (JSON.parse(res.content[0].text) as { key: string; my_role: string }[]).map((p) => `${p.key}:${p.my_role}`);
    };
    assert.deepEqual(await mcp(amy.token!), ['amys:contributor']);
    assert.deepEqual(await mcp(bob.token!), ['bobs:manager']);

    // WebSocket：Amy 連上只收到自己的項目；被加進 bobs 後收到一份新的快照
    const hellos: { projects: { key: string }[] }[] = [];
    const leaked: PmEvent[] = [];
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws?token=${amy.token}`);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'hello') hellos.push(msg.snapshot);
      if (msg.type === 'event' && JSON.stringify(msg.event).includes('Bob 的項目')) leaked.push(msg.event);
    });
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(ok(), '等待超時');
    };
    await until(() => hellos.length === 1);
    assert.deepEqual(hellos[0].projects.map((p) => p.key), ['amys']);
    // bobs 裡發生的事不會推給 Amy
    await asBob.registerWorker({ id: 'bob-pc' });
    await asBob.claimTask('bob-pc');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(leaked.length, 0);
    await asBob.setMember('bobs', 'amy', 'viewer');
    await until(() => hellos.length === 2);
    assert.deepEqual(hellos[1].projects.map((p) => p.key), ['amys', 'bobs']);
    ws.close();
    // 沒有 token 的 WebSocket 會被關掉
    const bad = new WebSocket(`${url.replace('http', 'ws')}/ws`);
    const code = await new Promise<number>((r) => bad.on('close', (c) => r(c)));
    assert.equal(code, 4401);
  } finally {
    await s.close();
  }
});
