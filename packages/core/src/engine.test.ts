import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, MemoryStore, PmError, type PmEvent } from './index.ts';

function setup(leaseMs = 1000) {
  let now = 1_000_000;
  const engine = new Engine(new MemoryStore(), { leaseMs, now: () => now });
  const events: PmEvent[] = [];
  engine.on((e) => events.push(e));
  return { engine, events, advance: (ms: number) => (now += ms) };
}

const chain = {
  title: '測試項目',
  tasks: [
    { key: 'a', title: 'A', labels: ['code'] },
    { key: 'b', title: 'B', labels: ['code'], deps: ['a'] },
    { key: 'c', title: 'C', labels: ['gpu'], deps: ['a'] },
    { key: 'd', title: 'D', deps: ['b', 'c'] },
  ],
};

test('拆解：無依賴的任務立即 ready，其餘 pending', () => {
  const { engine } = setup();
  const { tasks } = engine.createProject(chain);
  assert.deepEqual(
    tasks.map((t) => [t.key, t.state]),
    [
      ['a', 'ready'],
      ['b', 'pending'],
      ['c', 'pending'],
      ['d', 'pending'],
    ],
  );
});

test('拆解：拒絕有環或依賴不存在的圖', () => {
  const { engine } = setup();
  assert.throws(
    () =>
      engine.createProject({
        title: 'x',
        tasks: [
          { key: 'a', title: 'A', deps: ['b'] },
          { key: 'b', title: 'B', deps: ['a'] },
        ],
      }),
    (e: unknown) => e instanceof PmError && e.code === 'invalid' && /環/.test(e.message),
  );
  assert.throws(() => engine.createProject({ title: 'x', tasks: [{ key: 'a', title: 'A', deps: ['zzz'] }] }), PmError);
});

test('領取：同一個任務只會被一個 worker 領到', () => {
  const { engine } = setup();
  engine.createProject(chain);
  engine.registerWorker({ id: 'w1', labels: ['code'] });
  engine.registerWorker({ id: 'w2', labels: ['code'] });
  const first = engine.claimTask('w1');
  const second = engine.claimTask('w2');
  assert.equal(first?.key, 'a');
  assert.equal(first?.state, 'claimed');
  assert.equal(second, null);
});

test('領取：能力標籤不符就領不到', () => {
  const { engine } = setup();
  engine.createProject({ title: 'x', tasks: [{ key: 'a', title: 'A', labels: ['gpu'] }] });
  engine.registerWorker({ id: 'w1', labels: ['code'] });
  engine.registerWorker({ id: 'w2', labels: ['code', 'gpu'] });
  assert.equal(engine.claimTask('w1'), null);
  assert.equal(engine.claimTask('w2')?.key, 'a');
});

test('完整流程：交付 → review 通過 → 解鎖下游 → 項目交付', () => {
  const { engine, events } = setup();
  const { project } = engine.createProject(chain);
  engine.registerWorker({ id: 'w', labels: ['code', 'gpu'] });

  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
    const t = engine.claimTask('w')!;
    order.push(t.key);
    engine.submitResult('w', t.id, { summary: 'ok', pr_url: 'https://example.com/pr/1' });
    assert.equal(engine.getTask(t.id).state, 'in_review');
    engine.review(t.id, { decision: 'approve' });
    assert.equal(engine.getTask(t.id).state, 'done');
  }
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  assert.equal(engine.snapshot().projects.find((p) => p.id === project.id)?.status, 'delivered');
  assert.ok(events.some((e) => e.type === 'project_delivered'));
});

test('review 退回：changes_requested，優先還給原來的人，意見保留', () => {
  const { engine } = setup();
  engine.createProject({ title: 'x', tasks: [{ key: 'a', title: 'A' }] });
  engine.registerWorker({ id: 'w1' });
  const t = engine.claimTask('w1')!;
  engine.submitResult('w1', t.id, { summary: 'v1' });
  engine.review(t.id, { decision: 'reject', comment: '缺測試' });
  assert.equal(engine.getTask(t.id).state, 'changes_requested');

  const again = engine.claimTask('w1')!;
  assert.equal(again.id, t.id);
  assert.equal(again.attempt, 2);
  assert.equal(again.reviews[0].comment, '缺測試');
});

test('租約：心跳續約；超時後任務回到任務池，worker 標記離線', () => {
  const { engine, events, advance } = setup(1000);
  engine.createProject({ title: 'x', tasks: [{ key: 'a', title: 'A' }] });
  engine.registerWorker({ id: 'w1' });
  engine.registerWorker({ id: 'w2' });
  const t = engine.claimTask('w1')!;

  advance(800);
  engine.heartbeat('w1', t.id);
  advance(800);
  engine.tick();
  assert.equal(engine.getTask(t.id).state, 'claimed', '心跳後租約應該還有效');

  advance(1200);
  engine.tick();
  assert.equal(engine.getTask(t.id).state, 'ready');
  assert.ok(events.some((e) => e.type === 'lease_expired'));
  assert.equal(engine.snapshot().workers.find((w) => w.id === 'w1')?.status, 'offline');

  // 原來的 worker 再心跳會被告知租約已丟失；別人可以接手
  assert.throws(() => engine.heartbeat('w1', t.id), (e: unknown) => e instanceof PmError && e.code === 'lease_lost');
  assert.equal(engine.claimTask('w2')?.id, t.id);
  assert.throws(() => engine.submitResult('w1', t.id, { summary: '晚了' }), PmError);
});

test('受阻：report_blocked → blocked → unblock → ready', () => {
  const { engine } = setup();
  engine.createProject({ title: 'x', tasks: [{ key: 'a', title: 'A' }] });
  engine.registerWorker({ id: 'w1' });
  const t = engine.claimTask('w1')!;
  engine.reportBlocked('w1', t.id, '缺金鑰');
  assert.equal(engine.getTask(t.id).state, 'blocked');
  assert.equal(engine.claimTask('w1'), null);
  engine.unblock(t.id, 'human');
  assert.equal(engine.getTask(t.id).state, 'ready');
});
