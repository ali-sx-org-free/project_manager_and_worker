import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { Engine, PmError, type PmEvent } from '@agent-pm/core';
import { mcpHandler } from './mcp.ts';
import { SqliteStore } from './sqliteStore.ts';

export interface ServerOptions {
  dbFile: string;
  leaseMs: number;
  /** 設置後，所有寫操作和 MCP 都需要 Authorization: Bearer <token> */
  token?: string;
  /** 網頁靜態文件目錄（vite build 的輸出），存在才掛載 */
  webDir?: string;
}

const STATUS: Record<PmError['code'], number> = {
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
    res.setHeader('access-control-allow-headers', 'content-type, authorization, mcp-protocol-version, mcp-session-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!opts.token || req.method === 'GET') return next();
    if (req.headers.authorization === `Bearer ${opts.token}`) return next();
    res.status(401).json({ error: { code: 'forbidden', message: '需要有效的 token' } });
  };
  app.use('/api', auth);
  app.use('/mcp', auth);

  const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || !v) throw new PmError('invalid', `缺少參數 ${name}`);
    return v;
  };
  const id = (req: Request) => str(req.params.id, 'id');

  // ── 查詢 ──
  app.get('/api/state', (_req, res) => res.json(engine.snapshot()));
  app.get('/api/events', (req, res) => res.json(engine.events(Number(req.query.since ?? 0))));
  app.get('/api/tasks/claimable', (req, res) => res.json(engine.listClaimable(str(req.query.worker_id, 'worker_id'))));
  app.get('/api/tasks/:id', (req, res) => res.json(engine.getTask(id(req))));

  // ── PM ──
  app.post('/api/projects', (req, res) => res.status(201).json(engine.createProject(req.body)));
  app.post('/api/projects/:id/archive', (req, res) => res.json(engine.archiveProject(id(req))));
  app.post('/api/tasks/:id/review', (req, res) => res.json(engine.review(id(req), req.body ?? {})));
  app.post('/api/tasks/:id/unblock', (req, res) => res.json(engine.unblock(id(req), req.body?.by)));

  // ── Worker ──
  app.post('/api/workers/register', (req, res) => res.json(engine.registerWorker(req.body ?? {})));
  app.post('/api/tasks/claim', (req, res) =>
    res.json(engine.claimTask(str(req.body?.worker_id, 'worker_id'), req.body?.task_id || undefined)),
  );
  app.post('/api/tasks/:id/heartbeat', (req, res) =>
    res.json(engine.heartbeat(str(req.body?.worker_id, 'worker_id'), id(req))),
  );
  app.post('/api/tasks/:id/submit', (req, res) =>
    res.json(
      engine.submitResult(str(req.body?.worker_id, 'worker_id'), id(req), {
        summary: req.body?.summary ?? '',
        pr_url: req.body?.pr_url,
      }),
    ),
  );
  app.post('/api/tasks/:id/block', (req, res) =>
    res.json(engine.reportBlocked(str(req.body?.worker_id, 'worker_id'), id(req), req.body?.reason ?? '')),
  );
  app.post('/api/tasks/:id/release', (req, res) =>
    res.json(engine.releaseTask(str(req.body?.worker_id, 'worker_id'), id(req))),
  );

  // ── MCP（無狀態 Streamable HTTP）──
  app.post('/mcp', mcpHandler(engine));
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
  wss.on('connection', (ws) => {
    send(ws, { type: 'hello', snapshot: engine.snapshot(), events: engine.events(0, 2000) });
  });
  engine.on((event: PmEvent) => {
    for (const ws of wss.clients) send(ws, { type: 'event', event });
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
