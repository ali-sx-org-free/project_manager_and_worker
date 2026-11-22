import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeServer, type FakeServer } from './fake-server.ts';

/** 端到端：真的起多個 apm 進程，經過 HTTP 連本機的假 GitHub，鎖推到本機的裸倉庫 */

const here = dirname(fileURLToPath(import.meta.url));
const tsx = resolve(here, '../../../node_modules/tsx/dist/cli.mjs');
const cli = join(here, 'cli.ts');
const tmp = mkdtempSync(join(tmpdir(), 'apm-e2e-'));
let fake: FakeServer;

before(async () => {
  fake = await startFakeServer({ users: ['pm', 'alice', 'bob', 'carol'], hub: 'e2e/hub' });
});
after(async () => {
  await fake.close();
});

function apm(login: string, workerId: string, args: string[]): Promise<{ code: number; json: Record<string, unknown> & { [k: string]: unknown }; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [tsx, cli, ...args, '--json'], {
      env: {
        ...process.env,
        ...fake.env(login),
        APM_HOME: join(tmp, workerId),
        APM_WORKER_ID: workerId,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => {
      let json = {};
      try {
        json = JSON.parse(stdout);
      } catch {
        /* keepalive 之類輸出多行 */
      }
      res({ code: code ?? 1, json, stdout, stderr });
    });
  });
}

const advance = (ms: number) => fetch(`${fake.url}/_fake/advance`, { method: 'POST', body: JSON.stringify({ ms }) });

test('apm 端到端：init → 建項目 → 多進程搶任務 → 檢查點 → keepalive → 交付 → review → 斷線接手', { timeout: 120_000 }, async () => {
  const init = await apm('pm', 'pm', ['init']);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  assert.equal(init.json.private, true);

  const plan = join(tmp, 'plan.json');
  writeFileSync(
    plan,
    JSON.stringify({
      key: 'site',
      title: '官網改版',
      contributors: ['alice', 'bob', 'carol'],
      tasks: [
        { key: 'a', title: 'A', caps: ['code'] },
        { key: 'b', title: 'B', caps: ['code'] },
        { key: 'c', title: 'C', caps: ['code'] },
        { key: 'd', title: 'D', deps: ['a'] },
      ],
    }),
  );
  const created = await apm('pm', 'pm', ['project', 'create', '-f', plan]);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const tasks = created.json.tasks as { key: string; number: number }[];
  assert.equal(tasks.length, 4);

  // 每個 worker 先 join（寫本機設定：能力 code）
  const ids = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
  const owner = (i: number) => ['alice', 'bob', 'carol'][i % 3];
  await Promise.all(ids.map((id, i) => apm(owner(i), id, ['join', '--labels', 'code'])));

  // 6 個進程同時搶 3 個能做的任務（d 要等 a）
  const claims = await Promise.all(ids.map((id, i) => apm(owner(i), id, ['claim'])));
  const winners = claims.filter((c) => c.code === 0);
  assert.equal(winners.length, 3, claims.map((c) => `${c.code} ${c.stdout.slice(0, 200)} ${c.stderr.slice(0, 200)}`).join('\n'));
  assert.equal(claims.filter((c) => c.code === 2).length, 3);
  const got = winners.map((w) => (w.json.task as { number: number }).number).sort();
  assert.equal(new Set(got).size, 3);

  const first = ids[claims.findIndex((c) => c.code === 0)];
  const firstOwner = owner(ids.indexOf(first));
  const cp = await apm(firstOwner, first, ['checkpoint', '--summary', '做了一半', '--progress', '50', '--next', '寫測試']);
  assert.equal(cp.code, 0, cp.stdout + cp.stderr);
  assert.equal(cp.json.progress, 50);
  const ka = await apm(firstOwner, first, ['keepalive', '--once', '--pid', String(process.pid)]);
  assert.equal(ka.code, 0, ka.stdout + ka.stderr);
  assert.match(ka.stdout, /"renewed":true/);

  const cur = await apm(firstOwner, first, ['current']);
  assert.equal(cur.code, 0);
  const myTask = (cur.json.held as { task: number }).task;

  const sub = await apm(firstOwner, first, ['submit', '--summary', '完成了']);
  assert.equal(sub.code, 0, sub.stdout + sub.stderr);
  const again = await apm(firstOwner, first, ['heartbeat']);
  assert.equal(again.code, 2, '交付後手上沒有任務');

  const rev = await apm('pm', 'pm', ['review', String(myTask), '--approve']);
  assert.equal(rev.code, 0, rev.stdout + rev.stderr);

  // 斷線：另一個持有者 11 分鐘沒續約，別人接手，原持有者得到退出碼 3
  const second = ids[claims.findIndex((c, i) => c.code === 0 && ids[i] !== first)];
  const secondOwner = owner(ids.indexOf(second));
  await advance(11 * 60_000);
  const idle = ids.filter((id) => !winners.some((_, j) => ids[claims.indexOf(winners[j])] === id));
  const takeover = await apm(owner(ids.indexOf(idle[0])), idle[0], ['claim']);
  assert.equal(takeover.code, 0, takeover.stdout + takeover.stderr);
  const lost = await apm(secondOwner, second, ['heartbeat']);
  const lostOrOk = lost.code;
  // 被接手的可能是 second，也可能是第三個持有者（排序決定）；兩者之一必定 lease_lost
  if (lostOrOk !== 3) {
    const third = ids[claims.findIndex((c, i) => c.code === 0 && ids[i] !== first && ids[i] !== second)];
    const l3 = await apm(owner(ids.indexOf(third)), third, ['heartbeat']);
    assert.equal(l3.code, 3, l3.stdout);
    assert.equal(l3.json.error, 'lease_lost');
  } else assert.equal(lost.json.error, 'lease_lost');

  const status = await apm('pm', 'pm', ['status']);
  assert.equal(status.code, 0);
  const proj = (status.json.projects as { key: string; counts: Record<string, number> }[])[0];
  assert.equal(proj.key, 'site');
  assert.equal(proj.counts.done, 1);

  const locks = await apm('pm', 'pm', ['locks']);
  assert.ok((locks.json as unknown as unknown[]).length >= 3);
  const doctor = await apm('alice', 'w1', ['doctor']);
  assert.match(doctor.stdout, /讀取鎖/);
});
