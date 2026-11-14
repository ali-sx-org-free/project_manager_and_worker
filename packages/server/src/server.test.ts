import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
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
