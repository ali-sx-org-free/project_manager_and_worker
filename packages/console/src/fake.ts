import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGitHub, Hub, LeaseLost, MemoryLockStore, PmOps, StateFile, WorkerOps, type Plan } from '@agent-pm/github';

/** npm run console -- --fake：不碰真 GitHub，在記憶體裡模擬一個 hub，再讓幾個假 worker 和假 PM 在上面幹活。
 *  用來先看看管理端長什麼樣，或在演示時不用準備真倉庫。所有讀寫走的都是真正的 apm 代碼（WorkerOps / PmOps）。 */

const REPO = 'demo/agent-pm-hub';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export async function startFakeHub(opts: { sim?: boolean; examplesDir?: string; log?: (m: string) => void } = {}) {
  const log = opts.log ?? ((m: string) => console.log(`[fake] ${m}`));
  process.env.APM_HOME ??= mkdtempSync(join(tmpdir(), 'apm-console-fake-'));
  const gh = new FakeGitHub(Date.now());
  const users = ['you', 'amy', 'bob'];
  for (const u of users) gh.addUser(u);
  const repo = gh.addRepo(REPO, { owner: 'you' });
  for (const u of users.slice(1)) gh.grant(REPO, u, 'push');
  // 演示用短租約：1 分鐘沒續約就被接手
  repo.files.set('.agent-pm/config.yml', 'lease_minutes: 1\nheartbeat_minutes: 1\nidle_minutes: 30\nadmins: [you]\n');
  const transport: typeof gh.transport = (req) => {
    gh.clock = Date.now();
    return gh.transport(req);
  };
  const locks = new MemoryLockStore();
  const hubFor = (u: string, etags = false) => new Hub({ repo: REPO, token: `tok-${u}`, transport, locks, etags });
  const hub = hubFor('you', true);
  const pm = new PmOps(hubFor('you'));
  await pm.init();

  const examples = (name: string): Plan | null => {
    try {
      return JSON.parse(readFileSync(join(opts.examplesDir ?? '', name), 'utf8')) as Plan;
    } catch {
      return null;
    }
  };
  let round = 0;
  const seed = async () => {
    round++;
    const plans: Plan[] = [
      examples('project.json') ?? {
        key: 'guestbook',
        title: '部落格加上留言功能',
        tasks: [
          { key: 'api', title: '留言 API', caps: ['code'] },
          { key: 'ui', title: '留言區前端', caps: ['code'], deps: ['api'] },
        ],
      },
      examples('multi-site.json') ?? { key: 'site', title: '官網改版', priority: 4, max_parallel: 1, tasks: [{ key: 'api', title: 'API 文件' }, { key: 'ui', title: '介面文件' }] },
    ];
    for (const p of plans) {
      const plan: Plan = { ...p, key: round > 1 ? `${p.key ?? 'p'}-${round}` : p.key, contributors: ['amy', 'bob'] };
      await pm.createProject(plan);
    }
    log(`建好第 ${round} 輪的項目`);
  };
  await seed();

  let running = true;
  if (opts.sim !== false) {
    const workers = [
      { owner: 'amy', id: 'amy-laptop', labels: ['code'] },
      { owner: 'bob', id: 'bob-pc', labels: ['code'] },
      { owner: 'amy', id: 'amy-desktop', labels: ['code', 'docs'] },
    ].map((w) => ({ ...w, ops: new WorkerOps(hubFor(w.owner), { ...w, name: w.id, machine: 'demo', projects: null }, new StateFile(REPO, w.id)), progress: 0, offlineUntil: 0 }));
    for (const w of workers) await w.ops.join();

    const workerLoop = async (w: (typeof workers)[number]) => {
      while (running) {
        await sleep(rand(3000, 7000));
        try {
          if (Date.now() < w.offlineUntil) continue; // 斷線中：不續約，等別人接手
          const held = w.ops.state.load();
          if (!held || held.lost) {
            if (held) w.ops.state.clear();
            const c = await w.ops.claim();
            w.progress = c?.resume?.progress ?? 0;
            continue;
          }
          w.progress = Math.min(100, w.progress + Math.round(rand(15, 35)));
          const dice = Math.random();
          if (w.progress >= 100) {
            const pr = gh.openPr(REPO, held.branch, `[${held.project_key}] ${held.title}`, w.owner);
            await w.ops.submit({ summary: `完成「${held.title}」，對照驗收標準逐條自查通過`, pr_url: pr });
          } else if (dice < 0.05) {
            await w.ops.block('需要 PM 確認介面的欄位命名');
          } else if (dice < 0.1) {
            await w.ops.checkpoint({ summary: `做到 ${w.progress}%`, next_steps: '接著寫剩下的部分', progress: w.progress });
            await w.ops.release('usage_limit', '額度用完，交給下一位');
          } else if (dice < 0.14) {
            await w.ops.checkpoint({ summary: `做到 ${w.progress}%`, next_steps: '接著寫剩下的部分', progress: w.progress });
            w.offlineUntil = Date.now() + 100_000; // 模擬斷網 100 秒
          } else {
            await w.ops.checkpoint({ summary: `完成了第 ${Math.ceil(w.progress / 25)} 部分`, next_steps: '寫下一部分和測試', progress: w.progress, commit: Math.random().toString(16).slice(2, 9) });
          }
        } catch (err) {
          if (err instanceof LeaseLost) w.ops.state.clear();
          else log(`${w.id}：${err instanceof Error ? err.message : err}`);
        }
      }
    };
    const pmLoop = async () => {
      const seen = new Map<number, number>();
      while (running) {
        await sleep(4000);
        try {
          const s = await pm.status();
          if (!s.projects.length) {
            await seed();
            continue;
          }
          for (const p of s.projects) {
            for (const t of p.tasks) {
              if (t.state !== 'in_review' && t.state !== 'blocked') continue;
              const since = seen.get(t.number) ?? Date.now();
              seen.set(t.number, since);
              if (Date.now() - since < 6000) continue;
              seen.delete(t.number);
              if (t.state === 'blocked') await pm.unblock(t.number, '欄位用 snake_case');
              else if (Math.random() < 0.2) await pm.review(t.number, 'reject', '少了錯誤處理的測試，補上再交');
              else await pm.review(t.number, 'approve', '符合驗收標準', { human: true });
            }
          }
        } catch (err) {
          log(`PM：${err instanceof Error ? err.message : err}`);
        }
      }
    };
    for (const w of workers) void workerLoop(w);
    void pmLoop();
  }
  return {
    hub,
    gh,
    stop: () => {
      running = false;
    },
  };
}
