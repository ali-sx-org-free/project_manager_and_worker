import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { PmError, type Me, type PmEvent } from '@agent-pm/core';
import {
  deriveEvents,
  deriveSnapshot,
  isAlive,
  loadModel,
  PmOps,
  stripSha,
  type HubModel,
  type HubSnapshot,
  type Hub,
  type Plan,
  type WorkerMeta,
} from '@agent-pm/github';

/** 本機管理端：一個只在你電腦上跑的小服務。它用你的 GitHub 登入讀寫 hub，token 不進瀏覽器。
 *  對網頁提供和原來協調服務一樣的接口（/api/state、/ws 等），所以 3D 網頁不用改就能用。
 *  沒有推送：每隔幾秒輪詢一次 hub（帶 ETag，沒變化不算 API 額度），算出新事件推給網頁。 */

export interface ConsoleOptions {
  hub: Hub;
  port: number;
  host?: string;
  /** vite build 的輸出 */
  webDir?: string;
  intervalMs?: number;
  log?: (msg: string) => void;
}

export interface HubInfo {
  name: string;
  url: string;
  me: string;
  admin: boolean;
  private: boolean | null;
  lease_minutes: number;
  poll_ms: number;
  last_sync: number | null;
  syncing: boolean;
  error: string | null;
  rate: { limit: number; remaining: number; reset: number } | null;
  requests: { total: number; not_modified: number };
  locks: { task: number; title: string | null; worker: string; owner: string; attempt: number; status: string; alive: boolean; expires_at: number | null; task_open: boolean }[];
  roster: { id: string; owner: string; labels: string[]; status: string; current_task: number | null; seen: number; machine: string }[];
  counts: { projects: number; tasks: number; comments: number };
}

const STATUS: Record<string, number> = { unauthorized: 401, not_found: 404, conflict: 409, invalid: 400, lease_lost: 409, forbidden: 403 };
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

interface Conn {
  actAs: string | null;
}

export class ConsoleServer {
  readonly pm: PmOps;
  private server: http.Server;
  private wss: WebSocketServer;
  private conns = new Map<WebSocket, Conn>();
  private model: HubModel | null = null;
  private snap: HubSnapshot | null = null;
  private history: PmEvent[] = [];
  private keyToId = new Map<string, number>();
  private seq = 0;
  private last = { tasks: new Map<string, string>(), projects: new Map<string, string>(), workers: new Map<string, string>() };
  private lastSync: number | null = null;
  private syncing: Promise<void> | null = null;
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private me = '';
  private admin = false;
  private isPrivate: boolean | null = null;
  private log: (m: string) => void;

  constructor(private opts: ConsoleOptions) {
    this.pm = new PmOps(opts.hub);
    this.log = opts.log ?? ((m) => console.log(`[console] ${m}`));
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws' || !this.hostOk(req) || !this.originOk(req)) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const c: Conn = { actAs: url.searchParams.get('as') || null };
        this.conns.set(ws, c);
        ws.on('close', () => this.conns.delete(ws));
        void this.ready().then(() => this.hello(ws, c));
      });
    });
  }

  get hub() {
    return this.opts.hub;
  }

  async start(): Promise<string> {
    this.me = await this.hub.me();
    this.admin = await this.hub.isAdmin(this.me);
    this.isPrivate = ((await this.hub.repoInfo()) as { private?: boolean }).private ?? null;
    await new Promise<void>((r) => this.server.listen(this.opts.port, this.opts.host ?? '127.0.0.1', () => r()));
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
    this.opts.port = port;
    void this.sync();
    const every = this.opts.intervalMs ?? 15_000;
    this.timer = setInterval(() => void this.sync(), every);
    return `http://localhost:${port}`;
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    for (const ws of this.conns.keys()) ws.close();
    this.wss.close();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** 第一次同步完成前，網頁連上來先等一下 */
  private async ready() {
    while (!this.snap) {
      if (this.syncing) await this.syncing;
      else await this.sync();
      if (!this.snap) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // ───────────── 同步 ─────────────

  sync(): Promise<void> {
    this.syncing ??= (async () => {
      try {
        const model = await loadModel(this.hub);
        const now = this.hub.now();
        const snap = deriveSnapshot(model, now);
        const names = new Map(snap.workers.map((w) => [w.id, w.name]));
        const events = deriveEvents(model, snap, names);
        const first = !this.snap;
        const removed =
          !!this.snap &&
          (this.snap.tasks.some((t) => !snap.tasks.find((x) => x.id === t.id)) || this.snap.projects.some((p) => !snap.projects.find((x) => x.id === p.id)));
        const fresh: PmEvent[] = [];
        for (const e of events) {
          if (this.keyToId.has(e.key)) continue;
          const id = ++this.seq;
          this.keyToId.set(e.key, id);
          const { key: _k, ...rest } = e;
          const ev = { ...rest, id } as PmEvent;
          this.history.push(ev);
          fresh.push(ev);
        }
        if (this.history.length > 5000) this.history = this.history.slice(-5000);
        this.model = model;
        this.snap = snap;
        this.lastSync = Date.now();
        this.error = null;
        if (first || removed) {
          this.remember(snap);
          for (const [ws, c] of this.conns) this.hello(ws, c);
          return;
        }
        for (const e of fresh) this.broadcast(e);
        // 事件沒涵蓋到的變化（租約倒數、過期、標籤修正）用不入歷史的同步事件補上
        for (const t of snap.tasks) {
          const j = JSON.stringify(t);
          const prev = this.last.tasks.get(t.id);
          if (prev === j) continue;
          const lastSent = this.lastSentTask(t.id);
          if (lastSent && JSON.stringify(lastSent) === j) continue;
          const onlyLease = prev && JSON.stringify({ ...JSON.parse(prev), lease_expires_at: t.lease_expires_at }) === j;
          this.broadcast({ id: 0, ts: now, type: onlyLease ? 'heartbeat' : 'worker_updated', message: '', task_id: t.id, project_id: t.project_id, worker_id: t.assignee ?? undefined, task: t });
        }
        for (const p of snap.projects) {
          const j = JSON.stringify(p);
          if (this.last.projects.get(p.id) !== j) this.broadcast({ id: 0, ts: now, type: 'project_updated', message: '', project_id: p.id, project: p, members: snap.members.filter((m) => m.project_id === p.id) });
        }
        for (const w of snap.workers) {
          const j = JSON.stringify(w);
          if (this.last.workers.get(w.id) !== j) this.broadcast({ id: 0, ts: now, type: 'worker_updated', message: '', worker_id: w.id, worker: w });
        }
        this.remember(snap);
        this.broadcastHub();
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.log(`同步失敗：${this.error}`);
        this.broadcastHub();
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private lastSentTask(id: string) {
    for (let i = this.history.length - 1; i >= 0 && i > this.history.length - 50; i--) {
      if (this.history[i].task?.id === id) return this.history[i].task;
    }
    return null;
  }

  private remember(snap: HubSnapshot) {
    this.last.tasks = new Map(snap.tasks.map((t) => [t.id, JSON.stringify(t)]));
    this.last.projects = new Map(snap.projects.map((p) => [p.id, JSON.stringify(p)]));
    this.last.workers = new Map(snap.workers.map((w) => [w.id, JSON.stringify(w)]));
  }

  // ───────────── 「檢視身分」：只是顯示過濾（同一個 hub 裡其實大家都看得到） ─────────────

  private visible(actAs: string | null): Set<string> | null {
    if (!actAs || !this.snap) return null;
    return new Set(this.snap.members.filter((m) => m.user_id === actAs).map((m) => m.project_id));
  }

  private scoped(actAs: string | null) {
    const snap = this.snap!;
    const vis = this.visible(actAs);
    if (!vis) return { snapshot: snap, events: this.history.slice(-3000) };
    return {
      snapshot: {
        ...snap,
        projects: snap.projects.filter((p) => vis.has(p.id)),
        tasks: snap.tasks.filter((t) => vis.has(t.project_id)),
        members: snap.members.filter((m) => vis.has(m.project_id)),
      },
      events: this.history.filter((e) => !e.project_id || vis.has(e.project_id)).slice(-3000),
    };
  }

  private meOf(actAs: string | null): Me {
    const user = (id: string) => ({ id, name: id, admin: this.snap?.users.find((u) => u.id === id)?.admin ?? false, created_at: 0 });
    const self = { ...user(this.me), admin: this.admin };
    if (actAs && actAs !== this.me) return { user: user(actAs), auth: true, acting_for: self };
    return { user: self, auth: true };
  }

  private hello(ws: WebSocket, c: Conn) {
    if (!this.snap) return;
    const s = this.scoped(c.actAs);
    this.send(ws, { type: 'hello', snapshot: s.snapshot, events: s.events, hub: this.hubInfo() });
  }

  private send(ws: WebSocket, msg: unknown) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(e: PmEvent) {
    for (const [ws, c] of this.conns) {
      const vis = this.visible(c.actAs);
      if (vis && e.project_id && !vis.has(e.project_id)) continue;
      this.send(ws, { type: 'event', event: e });
    }
  }

  private broadcastHub() {
    const info = this.hubInfo();
    for (const ws of this.conns.keys()) this.send(ws, { type: 'hub', hub: info });
  }

  hubInfo(): HubInfo {
    const m = this.model;
    const now = this.hub.now();
    const titles = new Map(m?.tasks.map((t) => [t.number, t]) ?? []);
    return {
      name: this.hub.name,
      url: `https://github.com/${this.hub.name}`,
      me: this.me,
      admin: this.admin,
      private: this.isPrivate,
      lease_minutes: m?.config.lease_minutes ?? 10,
      poll_ms: this.opts.intervalMs ?? 15_000,
      last_sync: this.lastSync,
      syncing: !!this.syncing,
      error: this.error,
      rate: this.hub.gh.rate,
      requests: { total: this.hub.gh.stats.requests, not_modified: this.hub.gh.stats.notModified },
      locks: [...(m?.locks.values() ?? [])]
        .sort((a, b) => a.task - b.task)
        .map((l) => ({
          ...stripSha(l),
          title: titles.get(l.task)?.title ?? null,
          task_open: titles.get(l.task)?.open ?? false,
          alive: isAlive(l, now),
        })),
      roster: (m?.roster ?? []).map((c) => {
        const w = c.meta as unknown as WorkerMeta;
        return { id: w.id, owner: w.owner, labels: w.labels ?? [], status: w.status, current_task: w.current_task, seen: w.seen, machine: w.machine };
      }),
      counts: { projects: m?.projects.length ?? 0, tasks: m?.tasks.length ?? 0, comments: [...(m?.comments.values() ?? [])].reduce((a, l) => a + l.length, 0) },
    };
  }

  // ───────────── HTTP ─────────────

  private hostOk(req: http.IncomingMessage) {
    // 防 DNS rebinding：只接受 localhost / 127.0.0.1 / ::1 這幾個 Host
    if (this.opts.host && this.opts.host !== '127.0.0.1' && this.opts.host !== 'localhost') return true;
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    return ['localhost', '127.0.0.1', '[::1]'].includes(host);
  }

  private originOk(req: http.IncomingMessage) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const u = new URL(origin);
      return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    } catch {
      return false;
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...this.cors(req) });
      res.end(JSON.stringify(data));
    };
    if (!this.hostOk(req)) return json(403, { error: { code: 'forbidden', message: 'Host 不對' } });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, this.cors(req));
      return res.end();
    }
    if (!url.pathname.startsWith('/api/')) return this.serveStatic(url.pathname, res);
    try {
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating) {
        // 防 CSRF：別的網站的頁面只能發 text/plain 之類的「簡單請求」，要求 JSON 就擋住了
        if (!this.originOk(req)) return json(403, { error: { code: 'forbidden', message: '不接受其他網站發來的請求' } });
        if (req.method !== 'DELETE' && !(req.headers['content-type'] ?? '').includes('application/json')) {
          return json(415, { error: { code: 'invalid', message: '請求要用 application/json' } });
        }
      }
      const body = mutating ? await readBody(req) : {};
      const data = await this.route(req.method ?? 'GET', url, body as Record<string, unknown>, (req.headers['x-act-as'] as string) || url.searchParams.get('as'));
      json(200, data ?? { ok: true });
    } catch (err) {
      const code = err instanceof PmError ? err.code : ((err as { code?: string }).code ?? 'internal');
      json(STATUS[code] ?? 500, { error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private cors(req: http.IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    // 只放行本機的 vite 開發服務器（npm run dev:console）
    if (origin && this.originOk(req)) {
      return {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'content-type, x-act-as',
        'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      };
    }
    return {};
  }

  private async route(method: string, url: URL, body: Record<string, unknown>, actAs: string | null): Promise<unknown> {
    const p = url.pathname;
    const id = (s: string) => {
      const n = Number(s);
      if (!Number.isInteger(n)) throw new PmError('invalid', `編號不對：${s}`);
      return n;
    };
    const after = async <T>(r: T) => {
      await this.sync();
      return r;
    };
    if (method === 'GET') {
      await this.ready();
      if (p === '/api/state') return this.scoped(actAs).snapshot;
      if (p === '/api/events') {
        const since = Number(url.searchParams.get('since') ?? 0);
        return this.scoped(actAs).events.filter((e) => e.id > since);
      }
      if (p === '/api/me') return this.meOf(actAs);
      if (p === '/api/hub') return this.hubInfo();
      if (p === '/api/users') return this.snap!.users;
      let m = p.match(/^\/api\/tasks\/(\d+)$/);
      if (m) return this.pm.showTask(id(m[1]));
      if (p === '/api/hub/members') return this.pm.collaborators();
      m = p.match(/^\/api\/tasks\/claimable$/);
      if (m) throw new PmError('invalid', '管理端不領任務：worker 用 apm claim');
    }
    let m = p.match(/^\/api\/tasks\/(\d+)\/(review|unblock|revoke|cancel)$/);
    if (m && method === 'POST') {
      const n = id(m[1]);
      if (m[2] === 'review') {
        const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
        if (!decision) throw new PmError('invalid', 'decision 要是 approve 或 reject');
        // 在管理端按按鈕的是人：帶 review:human 的任務也可以批准
        await this.pm.review(n, decision, String(body.comment ?? ''), { human: true, merge: body.merge === false ? false : undefined });
      } else if (m[2] === 'unblock') await this.pm.unblock(n, String(body.note ?? ''));
      else if (m[2] === 'revoke') await this.pm.revoke(n, String(body.note ?? ''));
      else await this.pm.cancelTask(n, String(body.note ?? ''));
      await this.sync();
      return this.snap!.tasks.find((t) => t.number === n) ?? { ok: true };
    }
    m = p.match(/^\/api\/projects\/(\d+)$/);
    if (m && method === 'PATCH') {
      const patch: Parameters<PmOps['updateProject']>[1] = {};
      for (const k of ['priority', 'max_parallel', 'repo', 'base', 'merge_on_approve', 'title'] as const) if (k in body) (patch as Record<string, unknown>)[k] = body[k];
      await this.pm.updateProject(id(m[1]), patch);
      await this.sync();
      return this.snap!.projects.find((x) => x.number === id(m![1]));
    }
    m = p.match(/^\/api\/projects\/(\d+)\/members\/([\w-]+)$/);
    if (m && (method === 'PUT' || method === 'DELETE')) {
      return after(await this.pm.setMember(id(m[1]), m[2], method === 'DELETE' ? 'none' : (String(body.role) as 'manager')));
    }
    if (p === '/api/projects' && method === 'POST') return after(await this.pm.createProject(body as unknown as Plan));
    m = p.match(/^\/api\/projects\/(\d+)\/(archive|close)$/);
    if (m && method === 'POST') return after(await this.pm.closeProject(id(m[1]), { cancel: m[2] === 'archive' || body.cancel === true, note: String(body.note ?? '') }));
    if (p === '/api/hub/sync' && method === 'POST') return after({ ok: true });
    if (p === '/api/hub/reconcile' && method === 'POST') return after(await this.pm.reconcile({ dryRun: body.dry_run === true }));
    if (p === '/api/hub/prune' && method === 'POST') return after(await this.pm.prune({ dryRun: body.dry_run === true }));
    if (p === '/api/hub/invite' && method === 'POST') return this.pm.invite(String(body.login ?? ''), (body.permission as 'push') ?? 'push');
    throw new PmError('not_found', `沒有這個接口：${method} ${p}`);
  }

  private serveStatic(pathname: string, res: http.ServerResponse) {
    const dir = this.opts.webDir;
    if (!dir || !existsSync(join(dir, 'index.html'))) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`agent-pm 管理端在運行（hub：${this.hub.name}）。網頁還沒構建：在原型倉庫裡執行 npm run build，再刷新。`);
      return;
    }
    const root = resolve(dir);
    let file = normalize(join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end();
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(readFileSync(file));
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new PmError('invalid', '請求太大');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new PmError('invalid', '請求不是合法的 JSON');
  }
}
