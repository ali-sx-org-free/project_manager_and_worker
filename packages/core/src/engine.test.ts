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

// ───────────────────────── 斷連後接手續作 ─────────────────────────

import { buildResume } from './index.ts';

test('檢查點：只有持有者能保存，保存即續約，進度記在任務上', () => {
  const { engine, advance } = setup(1000);
  engine.createProject({ title: 'x', tasks: [{ key: 'a', title: 'A' }] });
  engine.registerWorker({ id: 'w1' });
  engine.registerWorker({ id: 'w2' });
  const t = engine.claimTask('w1')!;
  assert.equal(buildResume(t), null, '第一次領取沒有續作上下文');

  advance(800);
  engine.saveCheckpoint('w1', t.id, { summary: '寫完資料表', next_steps: '接著寫 API', progress: 40, commit: 'abc123' });
  advance(800);
  engine.tick();
  assert.equal(engine.getTask(t.id).state, 'claimed', '保存檢查點也會續約');
  assert.equal(engine.getTask(t.id).progress, 40);
  assert.throws(() => engine.saveCheckpoint('w2', t.id, { summary: '搗亂' }), PmError);
});

test('斷線接手：租約超時後別人領取，拿到最後一個檢查點，從那裡接著做', () => {
  const { engine, events, advance } = setup(1000);
  engine.createProject({ title: 'x', tasks: [{ key: 'a', title: 'A' }] });
  engine.registerWorker({ id: 'w1', name: '甲' });
  engine.registerWorker({ id: 'w2', name: '乙' });
  const t = engine.claimTask('w1')!;
  engine.saveCheckpoint('w1', t.id, { summary: '第 1 步完成', progress: 20, commit: 'c1' });
  engine.saveCheckpoint('w1', t.id, { summary: '第 3 步完成', next_steps: '做第 4 步', progress: 60, commit: 'c3' });

  advance(1500); // 甲斷線，不再心跳
  engine.tick();
  const pooled = engine.getTask(t.id);
  assert.equal(pooled.state, 'ready');
  assert.equal(pooled.progress, 60, '回到任務池後進度沒有丟');

  const taken = engine.claimTask('w2')!;
  assert.equal(taken.id, t.id);
  assert.equal(taken.attempt, 2);
  const resume = buildResume(taken)!;
  assert.deepEqual(
    {
      from: resume.from_worker,
      reason: resume.reason,
      progress: resume.progress,
      summary: resume.summary,
      next: resume.next_steps,
      commit: resume.commit,
      branch: resume.branch,
      n: resume.checkpoints,
    },
    {
      from: 'w1',
      reason: 'lease_expired',
      progress: 60,
      summary: '第 3 步完成',
      next: '做第 4 步',
      commit: 'c3',
      branch: t.branch,
      n: 2,
    },
  );
  const ev = events.find((e) => e.type === 'task_resumed');
  assert.ok(ev && /乙 接手.*從 60% 繼續.*甲/.test(ev.message), ev?.message);

  // 甲的進程如果還活著，之後的檢查點和提交都會被拒絕，不會覆蓋乙的工作
  assert.throws(
    () => engine.saveCheckpoint('w1', t.id, { summary: '過期的寫入', progress: 99 }),
    (e: unknown) => e instanceof PmError && e.code === 'lease_lost',
  );
  // 乙接著做完
  engine.saveCheckpoint('w2', t.id, { summary: '第 5 步完成', progress: 100 });
  engine.submitResult('w2', t.id, { summary: '完成' });
  assert.deepEqual(
    engine.getTask(t.id).worklog.map((e) => `${e.worker_id}:${e.kind}:${e.progress ?? e.reason}`),
    ['w1:checkpoint:20', 'w1:checkpoint:60', 'w1:interrupted:lease_expired', 'w2:checkpoint:100'],
  );
});

test('主動交接：人工打斷或額度用完時立刻回到任務池，並優先留給別人', () => {
  const { engine } = setup(60_000);
  engine.createProject({
    title: 'x',
    tasks: [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B' },
    ],
  });
  engine.registerWorker({ id: 'w1' });
  engine.registerWorker({ id: 'w2' });
  const a = engine.claimTask('w1')!;
  engine.saveCheckpoint('w1', a.id, { summary: '做了一半', progress: 50 });
  engine.releaseTask('w1', a.id, { reason: 'usage_limit', note: '額度用完，測試還沒跑' });

  const pooled = engine.getTask(a.id);
  assert.equal(pooled.state, 'ready', '不用等租約超時');
  // 交出去的人自己再領，會先拿到別的任務
  assert.equal(engine.claimTask('w1')?.key, 'b');
  const taken = engine.claimTask('w2')!;
  assert.equal(taken.id, a.id);
  const resume = buildResume(taken)!;
  assert.equal(resume.reason, 'usage_limit');
  assert.equal(resume.handoff_note, '額度用完，測試還沒跑');
  assert.equal(resume.progress, 50);
});

test('斷線後自己回來：優先領回自己做到一半的任務', () => {
  const { engine, events, advance } = setup(1000);
  engine.createProject({
    title: 'x',
    tasks: [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B' },
    ],
  });
  engine.registerWorker({ id: 'w1', name: '甲' });
  engine.claimTask('w1', undefined);
  const b = engine.snapshot().tasks.find((t) => t.key === 'b')!;
  // 讓甲手上的是 b：先把 a 做完
  const a = engine.snapshot().tasks.find((t) => t.key === 'a')!;
  engine.submitResult('w1', a.id, { summary: 'ok' });
  engine.claimTask('w1', b.id);
  engine.saveCheckpoint('w1', b.id, { summary: '一半', progress: 50 });
  advance(1500);
  engine.tick();
  engine.createProject({ title: 'y', tasks: [{ key: 'c', title: 'C' }] });
  const back = engine.claimTask('w1')!;
  assert.equal(back.id, b.id);
  assert.ok(events.some((e) => e.type === 'task_resumed' && /甲 回來繼續/.test(e.message)));
});
