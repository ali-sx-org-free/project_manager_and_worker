import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, MemoryStore, PmError, scoped, type PmEvent } from './index.ts';

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

// ───────────────────────── 一個 PM 管多個項目 ─────────────────────────

const one = (key: string, extra: object = {}) => ({
  key,
  title: `項目 ${key}`,
  tasks: [
    { key: 'x', title: `${key}-x` },
    { key: 'y', title: `${key}-y` },
    { key: 'z', title: `${key}-z` },
  ],
  ...extra,
});

test('共用倉庫：分支名帶項目短名，短名不能重複', () => {
  const { engine } = setup();
  const site = engine.createProject(one('site'));
  const blog = engine.createProject(one('blog'));
  // 兩個項目裡同名的任務，分支落在各自項目的前綴下
  assert.match(site.tasks[0].branch, /^project\/site\/x-[a-z0-9]{4}$/);
  assert.match(blog.tasks[0].branch, /^project\/blog\/x-[a-z0-9]{4}$/);
  assert.equal(site.tasks[0].project_key, 'site');
  assert.throws(() => engine.createProject(one('site')), /已被另一個項目使用/);
  assert.throws(() => engine.createProject(one('My Site')), /短名/);
  // 歸檔後短名可以重新使用
  engine.archiveProject(site.project.id);
  engine.createProject(one('site'));
  // 不給短名會自動生成一個
  assert.match(engine.createProject({ title: '沒給短名', tasks: [{ key: 'a', title: 'A' }] }).project.key, /^p-[a-z0-9]{4}$/);
});

test('優先級：先領優先級高的項目；PM 調整後立刻按新的順序', () => {
  const { engine, events } = setup();
  const low = engine.createProject(one('low', { priority: 2 }));
  const high = engine.createProject(one('high', { priority: 4 }));
  engine.registerWorker({ id: 'w1' });
  engine.registerWorker({ id: 'w2' });
  // low 先建立，但 high 優先級高
  assert.equal(engine.claimTask('w1')!.project_id, high.project.id);
  // PM 把 low 調成緊急
  engine.updateProject('low', { priority: 5 });
  assert.equal(events.at(-1)!.type, 'project_updated');
  assert.match(events.at(-1)!.message, /優先級 2 → 5/);
  assert.equal(engine.claimTask('w2')!.project_id, low.project.id);
  assert.throws(() => engine.updateProject('low', { priority: 9 }), /1 到 5/);
});

test('並行配額：滿了就領不到這個項目的任務，名額空出來才能再領', () => {
  const { engine } = setup();
  const hot = engine.createProject(one('hot', { priority: 5, max_parallel: 2 }));
  const cold = engine.createProject(one('cold', { priority: 1 }));
  for (const id of ['w1', 'w2', 'w3']) engine.registerWorker({ id });
  const t1 = engine.claimTask('w1')!;
  const t2 = engine.claimTask('w2')!;
  assert.deepEqual([t1.project_id, t2.project_id], [hot.project.id, hot.project.id]);
  // hot 還有一個 ready 的任務，但名額已滿：第三個 worker 被分到優先級低的項目
  const left = hot.tasks.find((t) => t.id !== t1.id && t.id !== t2.id)!;
  assert.throws(() => engine.claimTask('w3', left.id), /並行配額 2 已滿/);
  assert.equal(engine.claimTask('w3')!.project_id, cold.project.id);
  // w1 交付後空出一個名額
  engine.submitResult('w1', t1.id, { summary: 'ok' });
  assert.equal(engine.claimTask('w1')!.id, left.id);
  // 配額設成 0 等於暫停派工：正在做的不受影響，新的領不到
  engine.updateProject('cold', { max_parallel: 0 });
  engine.submitResult('w2', t2.id, { summary: 'ok' });
  assert.equal(engine.claimTask('w2'), null);
  assert.equal(engine.getTask(engine.getWorker('w3').current_task!).state, 'claimed');
  // 改回不限
  engine.updateProject('cold', { max_parallel: null });
  assert.equal(engine.claimTask('w2')!.project_id, cold.project.id);
});

test('權限：worker 只能領主人有權參與的項目；也可以自己限定只做某些項目', () => {
  const { engine } = setup();
  engine.upsertUser({ id: 'boss', name: '老闆', admin: true });
  engine.upsertUser({ id: 'amy', name: 'Amy' });
  engine.upsertUser({ id: 'bob', name: 'Bob' });
  const site = engine.createProject(one('site', { priority: 5, members: [{ user_id: 'amy', role: 'contributor' }] }));
  const blog = engine.createProject(one('blog', { members: [{ user_id: 'bob', role: 'contributor' }, { user_id: 'amy', role: 'viewer' }] }));
  engine.registerWorker({ id: 'amy-pc', owner: 'amy' });
  engine.registerWorker({ id: 'bob-pc', owner: 'bob' });
  engine.registerWorker({ id: 'boss-pc', owner: 'boss' });
  engine.registerWorker({ id: 'boss-nas', owner: 'boss', projects: ['blog'] });

  // Amy 在 site 是參與者，在 blog 只是觀察者：她的 worker 只領得到 site
  assert.deepEqual(new Set(engine.listClaimable('amy-pc').map((t) => t.project_id)), new Set([site.project.id]));
  // Bob 不是 site 的成員：優先級再高也領不到，指定領取會被拒絕
  assert.deepEqual(new Set(engine.listClaimable('bob-pc').map((t) => t.project_id)), new Set([blog.project.id]));
  assert.throws(() => engine.claimTask('bob-pc', site.tasks[0].id), /沒有參與項目/);
  // 管理員的 worker 兩個項目都能領，先領優先級高的
  assert.equal(engine.claimTask('boss-pc')!.project_id, site.project.id);
  // 但限定了項目的那台只做 blog
  assert.equal(engine.claimTask('boss-nas')!.project_id, blog.project.id);
  // 把 Bob 加進 site 之後他就領得到了
  engine.setMember('site', 'bob', 'contributor');
  assert.equal(engine.claimTask('bob-pc')!.project_id, site.project.id);
});

test('權限：不是成員就看不到項目、任務和事件；別人的 worker 在看不到的項目裡做什麼會被抹掉', () => {
  const { engine } = setup();
  const amy = engine.upsertUser({ id: 'amy', name: 'Amy' });
  const bob = engine.upsertUser({ id: 'bob', name: 'Bob' });
  const eve = engine.upsertUser({ id: 'eve', name: 'Eve' });
  const shared = engine.createProject(
    one('shared', { priority: 1, members: [{ user_id: 'amy', role: 'manager' }, { user_id: 'bob', role: 'contributor' }] }),
  );
  const secret = engine.createProject(one('secret', { priority: 5, members: [{ user_id: 'bob', role: 'manager' }] }));
  engine.registerWorker({ id: 'bob-pc', name: 'Bob 的電腦', owner: 'bob' });
  const t = engine.claimTask('bob-pc')!; // 優先級高的 secret
  assert.equal(t.project_id, secret.project.id);

  const forAmy = scoped(engine, amy).snapshot();
  assert.deepEqual(forAmy.projects.map((p) => p.key), ['shared']);
  assert.ok(forAmy.tasks.every((x) => x.project_id === shared.project.id));
  // Amy 看得到 Bob 的 worker（他們有共同的項目），但只知道它「忙於其他項目」
  const w = forAmy.workers.find((x) => x.id === 'bob-pc')!;
  assert.equal(w.current_task, null);
  assert.equal(w.busy_elsewhere, true);
  // 事件裡也沒有 secret 的任何內容
  const evs = scoped(engine, amy).events();
  assert.ok(evs.every((e) => !JSON.stringify(e).includes('secret')));
  assert.ok(evs.some((e) => e.type === 'worker_updated' && e.worker?.busy_elsewhere));
  // 看不到的任務說「不存在」，不洩漏它存在
  assert.throws(() => scoped(engine, amy).getTask(t.id), (e: PmError) => e.code === 'not_found');
  // Bob 兩個都看得到；Eve 什麼都看不到，連 worker 也看不到
  assert.deepEqual(scoped(engine, bob).snapshot().projects.map((p) => p.key).sort(), ['secret', 'shared']);
  const forEve = scoped(engine, eve).snapshot();
  assert.deepEqual([forEve.projects.length, forEve.tasks.length, forEve.workers.length], [0, 0, 0]);
  // 管理員（未啟用鑒權時的預設身分）看到全部
  assert.equal(scoped(engine).snapshot().projects.length, 2);
});

test('權限：只有負責人能 review、改設定、管成員；只能操作自己的 worker', () => {
  const { engine } = setup();
  const amy = engine.upsertUser({ id: 'amy', name: 'Amy' });
  const bob = engine.upsertUser({ id: 'bob', name: 'Bob' });
  const cat = engine.upsertUser({ id: 'cat', name: 'Cat' });
  // 非管理員建項目，自動成為負責人
  const { project, tasks } = scoped(engine, amy).createProject(
    one('amys', { members: [{ user_id: 'bob', role: 'contributor' }, { user_id: 'cat', role: 'viewer' }] }),
  );
  assert.equal(engine.roleOf(amy, project.id), 'manager');
  // worker 登記在誰名下由 token 決定，不能冒名，也不能動別人的 worker
  const w = scoped(engine, bob).registerWorker({ id: 'bob-pc', owner: 'amy' });
  assert.equal(w.owner, 'bob');
  assert.throws(() => scoped(engine, cat).claimTask('bob-pc'), (e: PmError) => e.code === 'forbidden');
  assert.throws(() => scoped(engine, cat).registerWorker({ id: 'bob-pc' }), /別人名下/);
  const t = scoped(engine, bob).claimTask('bob-pc')!;
  scoped(engine, bob).submitResult('bob-pc', t.id, { summary: '做完了' });
  // 參與者和觀察者不能 review，負責人可以；review 記錄上的名字是負責人自己
  assert.throws(() => scoped(engine, bob).review(t.id, { decision: 'approve' }), (e: PmError) => e.code === 'forbidden');
  assert.throws(() => scoped(engine, cat).review(t.id, { decision: 'approve' }), (e: PmError) => e.code === 'forbidden');
  const done = scoped(engine, amy).review(t.id, { decision: 'approve', reviewer: '冒名' });
  assert.equal(done.reviews.at(-1)!.reviewer, 'Amy');
  // 設定和成員同理
  assert.throws(() => scoped(engine, bob).updateProject(project.id, { priority: 5 }), (e: PmError) => e.code === 'forbidden');
  assert.throws(() => scoped(engine, bob).setMember(project.id, 'cat', 'manager'), (e: PmError) => e.code === 'forbidden');
  assert.equal(scoped(engine, amy).updateProject(project.id, { priority: 5 }).priority, 5);
  // 觀察者看得到，但被移出後就看不到了
  assert.equal(scoped(engine, cat).snapshot().tasks.length, tasks.length);
  scoped(engine, amy).setMember(project.id, 'cat', null);
  assert.equal(scoped(engine, cat).snapshot().projects.length, 0);
  // 只有管理員能建用戶
  assert.throws(() => scoped(engine, amy).upsertUser({ name: '新人' }), (e: PmError) => e.code === 'forbidden');
});
