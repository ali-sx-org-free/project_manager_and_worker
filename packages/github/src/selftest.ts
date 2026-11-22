import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGitHub } from './fake.ts';
import { Hub } from './hub.ts';
import { StateFile } from './local.ts';
import { MemoryLockStore } from './locks.ts';
import { PmOps } from './pm.ts';
import { LeaseLost, WorkerOps } from './worker.ts';

/** apm selftest：不連網，用記憶體裡的假 GitHub 把完整流程跑一遍。驗收時先跑它，確認 apm 本身沒問題 */
export async function selftest(): Promise<{ ok: boolean; steps: { name: string; ok: boolean; detail?: string }[] }> {
  const steps: { name: string; ok: boolean; detail?: string }[] = [];
  const prevHome = process.env.APM_HOME;
  const home = mkdtempSync(join(tmpdir(), 'apm-selftest-'));
  process.env.APM_HOME = home;
  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      steps.push({ name, ok: true, detail: (await fn()) || undefined });
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };
  const must = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };
  try {
    const gh = new FakeGitHub();
    const repo = 'selftest/hub';
    const users = ['pm', ...Array.from({ length: 4 }, (_, i) => `dev${i}`)];
    for (const u of users) gh.addUser(u);
    gh.addRepo(repo, { owner: 'pm' });
    for (const u of users.slice(1)) gh.grant(repo, u);
    const locks = new MemoryLockStore(4);
    const hubFor = (u: string) => new Hub({ repo, token: `tok-${u}`, transport: gh.transport, now: gh.now, locks });
    const pm = new PmOps(hubFor('pm'));
    const worker = (u: string, id: string) => new WorkerOps(hubFor(u), { id, name: id, machine: 'selftest', labels: ['code'], projects: null, owner: u }, new StateFile(repo, id));

    await step('建 hub（標籤、設定、名冊）', async () => {
      const r = await pm.init();
      must(r.private && r.config === 'created', '初始化結果不對');
    });

    await step('20 個 worker 同時搶 5 個任務，每個任務只有一個人拿到', async () => {
      const { tasks } = await pm.createProject({
        key: 'race',
        title: '搶任務',
        contributors: users.slice(1),
        tasks: Array.from({ length: 5 }, (_, i) => ({ key: `t${i}`, title: `任務 ${i}` })),
      });
      void tasks;
      const ws = Array.from({ length: 20 }, (_, i) => worker(users[1 + (i % 4)], `racer-${i}`));
      const got = (await Promise.all(ws.map((w) => w.claim()))).filter(Boolean);
      const distinct = new Set(got.map((g) => g!.task.number));
      must(got.length === 5 && distinct.size === 5, `${got.length} 個人領到、${distinct.size} 個不同任務`);
      return `${got.length} 個 worker 領到，15 個什麼都沒拿到`;
    });

    await step('上游批准前下游不可領；批准後解鎖；全部完成後交付', async () => {
      const { tasks } = await pm.createProject({
        key: 'chain',
        title: '有依賴的項目',
        contributors: users.slice(1),
        tasks: [
          { key: 'api', title: 'API' },
          { key: 'ui', title: '前端', deps: ['api'] },
        ],
      });
      const a = worker('dev0', 'chain-a');
      const c = await a.claim();
      must(c?.task.number === tasks[0].number, '應該先領到 API');
      const b = worker('dev1', 'chain-b');
      must((await b.list()).candidates.every((x) => x.task.number !== tasks[1].number), '下游在上游完成前就能領了');
      await a.submit({ summary: '完成' });
      const r = await pm.review(tasks[0].number, 'approve');
      must(r.unlocked.includes(tasks[1].number), '批准後沒有解鎖下游');
      const c2 = await b.claim(tasks[1].number);
      must(c2, '下游解鎖後領不到');
      await b.submit({ summary: '完成' });
      const last = await pm.review(tasks[1].number, 'approve');
      must(last.delivered, '全部任務完成後項目沒有交付');
      return '全部完成後項目自動交付';
    });

    await step('交出後別人續作，拿到上一位的檢查點', async () => {
      const { tasks } = await pm.createProject({ key: 'relay', title: '接力', contributors: users.slice(1), tasks: [{ key: 'doc', title: '寫文件' }] });
      const a = worker('dev2', 'relay-a');
      await a.claim(tasks[0].number);
      await a.checkpoint({ summary: '寫完第一、二章', next_steps: '寫第三章', progress: 40 });
      await a.release('usage_limit', '額度用完');
      const b = worker('dev3', 'relay-b');
      const c = await b.claim(tasks[0].number);
      must(c?.resume?.progress === 40 && c.resume.from_worker === 'relay-a', '續作資訊不對');
      return `從 ${c!.resume!.progress}% 接著做：${c!.resume!.next_steps}`;
    });

    await step('斷線超過租約，別人接手；原 worker 回來得到 lease_lost', async () => {
      const { tasks } = await pm.createProject({ key: 'lost', title: '斷線', contributors: users.slice(1), tasks: [{ key: 'x', title: 'X' }] });
      const a = worker('dev0', 'lost-a');
      await a.claim(tasks[0].number);
      gh.advance(11 * 60_000);
      const b = worker('dev1', 'lost-b');
      const c = await b.claim(tasks[0].number);
      must(c?.resume === null || c?.attempt === 2, '沒有接手');
      let lost = false;
      try {
        await a.heartbeat();
      } catch (err) {
        lost = err instanceof LeaseLost;
      }
      must(lost, '原 worker 續約沒有得到 lease_lost');
    });

  } finally {
    if (prevHome === undefined) delete process.env.APM_HOME;
    else process.env.APM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
  return { ok: steps.every((s) => s.ok), steps };
}
