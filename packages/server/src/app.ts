import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { Engine, PmError, ROOT_USER, scoped, type Me, type PmEvent, type Scoped, type User } from '@agent-pm/core';
import { mcpHandler } from './mcp.ts';
import { SqliteStore } from './sqliteStore.ts';

export interface ServerOptions {
  dbFile: string;
  leaseMs: number;
  /** 管理員 token。設置後啟用鑒權：所有請求（包括讀取和 WebSocket）都要帶 token，
   *  每個人只看得到自己參與的項目。不設置則不鑒權，所有人都是管理員（示範用）。 */
  token?: string;
  /** 網頁靜態文件目錄（vite build 的輸出），存在才掛載 */
  webDir?: string;
}

const STATUS: Record<PmError['code'], number> = {
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  invalid: 400,
  lease_lost: 409,
  forbidden: 403,
};

export function createServer(opts: ServerOptions) {
  const store = new SqliteStore(opts.dbFile);
  const engine = new Engine(store, { leaseMs: opts.leaseMs });

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // 開發時網頁跑在 vite 的端口上，放開跨域
  app.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-act-as, mcp-protocol-version, mcp-session-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ── 身分 ──
  const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
  const newToken = () => `pm_${crypto.randomBytes(18).toString('base64url')}`;
  const authOn = !!opts.token;
  if (opts.token) engine.upsertUser({ id: 'admin', name: 'PM', admin: true }, sha(opts.token));

  /** 從 token 認出是誰；管理員（或未啟用鑒權時的任何人）可以用 as 換成別人的視角 */
  const identify = (token: string | undefined, actAs: string | undefined): Me => {
    let user = ROOT_USER;
    if (authOn) {
      const found = token ? engine.userByTokenHash(sha(token)) : undefined;
      if (!found) throw new PmError('unauthorized', '需要有效的 token');
      user = found;
    }
    if (actAs && actAs !== user.id) {
      if (!user.admin) throw new PmError('forbidden', '只有管理員可以用別人的身分檢視');
      const target = engine.getUser(actAs);
      if (!target) throw new PmError('not_found', `用戶 ${actAs} 不存在`);
      return { user: target, auth: authOn, acting_for: user };
    }
    return { user, auth: authOn };
  };
  const one = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const meOf = (req: Request): Me => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    return identify(bearer ?? one(req.query.token), one(req.headers['x-act-as']) ?? one(req.query.as));
  };
  const actorOf = (req: Request): User => meOf(req).user;
  const api = (req: Request): Scoped => scoped(engine, actorOf(req));

  const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || !v) throw new PmError('invalid', `缺少參數 ${name}`);
    return v;
  };
  const id = (req: Request) => str(req.params.id, 'id');
  const worker = (req: Request) => str(req.body?.worker_id, 'worker_id');

  // ── 查詢（都按調用者的身分過濾）──
  app.get('/api/me', (req, res) => res.json(meOf(req)));
  app.get('/api/state', (req, res) => res.json(api(req).snapshot()));
  app.get('/api/events', (req, res) => res.json(api(req).events(Number(req.query.since ?? 0))));
  app.get('/api/tasks/claimable', (req, res) => res.json(api(req).listClaimable(str(req.query.worker_id, 'worker_id'))));
  app.get('/api/tasks/:id', (req, res) => res.json(api(req).getTask(id(req))));
  app.get('/api/users', (req, res) => res.json(api(req).snapshot().users));

  // ── 用戶（管理員）──
  app.post('/api/users', (req, res) => {
    const token = newToken();
    const user = api(req).upsertUser(req.body ?? {}, sha(token));
    // token 只在這裡出現一次，服務端只存它的雜湊
    res.status(201).json({ user, token });
  });

  // ── PM ──
  app.post('/api/projects', (req, res) => res.status(201).json(api(req).createProject(req.body)));
  app.patch('/api/projects/:id', (req, res) =>
    res.json(api(req).updateProject(id(req), { priority: req.body?.priority, max_parallel: req.body?.max_parallel })),
  );
  app.post('/api/projects/:id/archive', (req, res) => res.json(api(req).archiveProject(id(req))));
  app.put('/api/projects/:id/members/:userId', (req, res) =>
    res.json(api(req).setMember(id(req), str(req.params.userId, 'userId'), req.body?.role)),
  );
  app.delete('/api/projects/:id/members/:userId', (req, res) =>
    res.json(api(req).setMember(id(req), str(req.params.userId, 'userId'), null)),
  );
  app.post('/api/tasks/:id/review', (req, res) => res.json(api(req).review(id(req), req.body ?? {})));
  app.post('/api/tasks/:id/unblock', (req, res) => res.json(api(req).unblock(id(req), req.body?.by)));

  // ── Worker ──
  app.post('/api/workers/register', (req, res) => res.json(api(req).registerWorker(req.body ?? {})));
  app.post('/api/tasks/claim', (req, res) => res.json(api(req).claimTask(worker(req), req.body?.task_id || undefined)));
  app.post('/api/tasks/:id/heartbeat', (req, res) => res.json(api(req).heartbeat(worker(req), id(req))));
  app.post('/api/tasks/:id/submit', (req, res) =>
    res.json(api(req).submitResult(worker(req), id(req), { summary: req.body?.summary ?? '', pr_url: req.body?.pr_url })),
  );
  app.post('/api/tasks/:id/checkpoint', (req, res) =>
    res.json(
      api(req).saveCheckpoint(worker(req), id(req), {
        summary: req.body?.summary ?? '',
        next_steps: req.body?.next_steps,
        progress: req.body?.progress,
        commit: req.body?.commit,
        artifacts: req.body?.artifacts,
        auto: req.body?.auto === true,
      }),
    ),
  );
  app.post('/api/tasks/:id/block', (req, res) =>
    res.json(api(req).reportBlocked(worker(req), id(req), req.body?.reason ?? '')),
  );
  app.post('/api/tasks/:id/release', (req, res) =>
    res.json(api(req).releaseTask(worker(req), id(req), { reason: req.body?.reason, note: req.body?.note })),
  );

  // ── MCP（無狀態 Streamable HTTP）──
  app.post('/mcp', (req, res, next) => {
    try {
      actorOf(req); // token 不對就直接 401，不進 MCP
    } catch (err) {
      return next(err);
    }
    void mcpHandler(engine, actorOf)(req, res);
  });
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  // ── 網頁 ──
  if (opts.webDir && fs.existsSync(path.join(opts.webDir, 'index.html'))) {
    app.use(express.static(opts.webDir));
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send('agent-pm 協調服務運行中。網頁尚未構建：npm run build，或 npm run dev 後打開 vite 的地址。');
    });
  }

  // ── 錯誤 ──
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PmError) {
      res.status(STATUS[err.code]).json({ error: { code: err.code, message: err.message } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: String(err) } });
  });

  // ── WebSocket：連上先收快照和歷史事件，之後只收增量事件 ──
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  // 每條連線記住它是誰、看得到哪些項目；事件按身分過濾後再推
  type Conn = { actor: User; view: ReturnType<Engine['viewOf']> | null; key: string };
  const conns = new Map<WebSocket, Conn>();
  const visKey = (actor: User) => [...engine.visibleProjects(actor)].sort().join(',');
  const hello = (ws: WebSocket, c: Conn) => {
    const s = scoped(engine, c.actor);
    c.key = visKey(c.actor);
    c.view = null;
    send(ws, { type: 'hello', snapshot: s.snapshot(), events: s.events(0, 2000) });
  };
  wss.on('connection', (ws, req) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    let me: Me;
    try {
      me = identify(q.get('token') ?? undefined, q.get('as') ?? undefined);
    } catch (err) {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      ws.close(4401, 'unauthorized');
      return;
    }
    const c: Conn = { actor: me.user, view: null, key: '' };
    conns.set(ws, c);
    ws.on('close', () => conns.delete(ws));
    hello(ws, c);
  });
  const RESCOPE = new Set(['project_created', 'project_archived', 'member_changed', 'worker_registered']);
  engine.on((event: PmEvent) => {
    for (const [ws, c] of conns) {
      if (c.actor.admin) {
        send(ws, { type: 'event', event });
        continue;
      }
      if (RESCOPE.has(event.type)) {
        // 看得到的項目變了（被加進或移出項目）：重新發一份完整的快照
        if (visKey(c.actor) !== c.key) {
          hello(ws, c);
          continue;
        }
        c.view = null;
      }
      c.view ??= engine.viewOf(c.actor);
      const ev = engine.viewEvent(c.view, event);
      if (ev) send(ws, { type: 'event', event: ev });
    }
  });

  const timer = setInterval(() => {
    try {
      engine.tick();
    } catch (err) {
      console.error('[tick]', err);
    }
  }, 1000);

  const close = () =>
    new Promise<void>((resolve) => {
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => {
        store.db.close();
        resolve();
      });
    });

  return { app, server, engine, store, close };
}
