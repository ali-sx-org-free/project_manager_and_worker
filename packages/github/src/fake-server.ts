import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGitHub } from './fake.ts';

/** 本機的假 GitHub（HTTP 服務 + 一個裸倉庫放鎖）。用來在不碰真 GitHub 的情況下演練 apm 和管理端：
 *
 *    npx tsx packages/github/src/fake-server.ts --port 4010 --users pm,alice,bob
 *
 *  它會印出每個帳號要設的環境變量（APM_API_BASE、APM_GIT_REMOTE、GH_TOKEN、APM_HUB）。 */

export interface FakeServer {
  url: string;
  gh: FakeGitHub;
  hub: string;
  lockRemote: string;
  env(login: string): Record<string, string>;
  close(): Promise<void>;
}

export async function startFakeServer(opts: { port?: number; users?: string[]; hub?: string; skewMs?: number; repos?: string[] } = {}): Promise<FakeServer> {
  const users = opts.users ?? ['pm', 'alice', 'bob'];
  const hub = opts.hub ?? 'demo/hub';
  const gh = new FakeGitHub(Date.now());
  let skew = opts.skewMs ?? 0;
  for (const u of users) gh.addUser(u);
  gh.addRepo(hub, { owner: users[0] }).anyHead = true;
  for (const u of users.slice(1)) gh.grant(hub, u, 'push');
  // 代碼倉庫（只在 REST 上存在，用來開 PR、合併 PR）
  for (const r of opts.repos ?? []) {
    gh.addRepo(r, { owner: users[0] }).anyHead = true;
    for (const u of users.slice(1)) gh.grant(r, u, 'push');
  }
  const dir = mkdtempSync(join(tmpdir(), 'apm-fake-'));
  const lockRemote = join(dir, 'hub.git');
  execFileSync('git', ['init', '--bare', '-q', lockRemote]);

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    gh.clock = Date.now() + skew;
    const url = new URL(req.url ?? '/', 'http://fake');
    // 測試控制：快轉時間、開 PR、合併 PR
    if (url.pathname.startsWith('/_fake/')) {
      const data = body ? JSON.parse(body) : {};
      let out: unknown = { ok: true };
      if (url.pathname === '/_fake/advance') skew += Number(data.ms ?? 0);
      else if (url.pathname === '/_fake/pr') out = { url: gh.openPr(data.repo ?? hub, data.head, data.title ?? data.head, data.user ?? users[1]) };
      else if (url.pathname === '/_fake/merge') gh.mergePrByHand(data.repo ?? hub, Number(data.number), data.user ?? users[0]);
      else if (url.pathname === '/_fake/state') out = { clock: gh.clock, writes: gh.writes() };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    const r = await gh.transport({ method: req.method ?? 'GET', url: `https://api.github.com${url.pathname}${url.search}`, headers, body: body || undefined });
    res.writeHead(r.status, { ...r.headers, 'content-type': 'application/json' });
    res.end(r.text);
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    gh,
    hub,
    lockRemote,
    env: (login: string) => ({ APM_API_BASE: url, APM_GIT_REMOTE: lockRemote, GH_TOKEN: `tok-${login}`, APM_HUB: hub }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const isMain = /fake-server\.ts$/.test(process.argv[1] ?? '');
if (isMain) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const s = await startFakeServer({
    port: Number(arg('port') ?? 4010),
    users: arg('users')?.split(','),
    hub: arg('hub'),
    repos: arg('repos')?.split(','),
  });
  console.log(`假 GitHub 在 ${s.url}，hub ${s.hub}，鎖倉庫 ${s.lockRemote}`);
  for (const u of arg('users')?.split(',') ?? ['pm', 'alice', 'bob']) {
    console.log(`\n# ${u}（每個帳號開一個終端，貼上這幾行；APM_HOME 讓同一台電腦上的帳號互不干擾）`);
    for (const [k, v] of Object.entries({ ...s.env(u), APM_HOME: join(tmpdir(), `apm-${u}`) })) console.log(`export ${k}=${v}`);
  }
  console.log('\nCtrl+C 結束（所有數據都在記憶體裡，結束就沒了）');
}
