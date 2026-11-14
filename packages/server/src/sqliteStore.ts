import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PmEvent, Project, Store, Task, TaskState, Worker } from '@agent-pm/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'dev',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  key              TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  acceptance       TEXT NOT NULL DEFAULT '',
  labels           TEXT NOT NULL DEFAULT '[]',   -- JSON 陣列：需要的能力標籤
  state            TEXT NOT NULL,
  assignee         TEXT,
  last_assignee    TEXT,
  lease_expires_at INTEGER,
  attempt          INTEGER NOT NULL DEFAULT 0,
  result           TEXT,                          -- JSON：summary / pr_url
  reviews          TEXT NOT NULL DEFAULT '[]',   -- JSON 陣列：review 歷史
  blocked_reason   TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (project_id, key)
);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);

-- DAG 的邊：task_id 依賴 depends_on
CREATE TABLE IF NOT EXISTS task_deps (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  depends_on TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE IF NOT EXISTS workers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  machine       TEXT NOT NULL DEFAULT '',
  labels        TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL,
  current_task  TEXT,
  last_seen     INTEGER NOT NULL,
  registered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL
);
`;

type TaskRow = Omit<Task, 'labels' | 'deps' | 'result' | 'reviews'> & {
  labels: string;
  result: string | null;
  reviews: string;
};
type WorkerRow = Omit<Worker, 'labels'> & { labels: string };

const TASK_COLS = `project_id=@project_id, key=@key, title=@title, description=@description,
  acceptance=@acceptance, labels=@labels, state=@state, assignee=@assignee, last_assignee=@last_assignee,
  lease_expires_at=@lease_expires_at, attempt=@attempt, result=@result, reviews=@reviews,
  blocked_reason=@blocked_reason, created_at=@created_at, updated_at=@updated_at`;

export class SqliteStore implements Store {
  readonly db: Database.Database;
  private depsCache = new Map<string, string[]>();

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /** BEGIN IMMEDIATE：一開始就拿寫鎖，就算將來多進程共用同一個庫，領取也不會互相踩到 */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // ── projects ──
  insertProject(p: Project) {
    this.db
      .prepare(
        `INSERT INTO projects (id,title,description,kind,status,created_at,delivered_at)
         VALUES (@id,@title,@description,@kind,@status,@created_at,@delivered_at)`,
      )
      .run(p);
  }
  updateProject(p: Project) {
    this.db
      .prepare(
        `UPDATE projects SET title=@title, description=@description, kind=@kind, status=@status,
         delivered_at=@delivered_at WHERE id=@id`,
      )
      .run(p);
  }
  getProject(id: string) {
    return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Project | undefined;
  }
  listProjects() {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at, rowid').all() as Project[];
  }

  // ── tasks ──
  private toRow(t: Task) {
    return {
      ...t,
      labels: JSON.stringify(t.labels),
      result: t.result ? JSON.stringify(t.result) : null,
      reviews: JSON.stringify(t.reviews),
    };
  }
  private depsOf(id: string): string[] {
    let deps = this.depsCache.get(id);
    if (!deps) {
      deps = (
        this.db.prepare('SELECT depends_on FROM task_deps WHERE task_id=? ORDER BY rowid').all(id) as {
          depends_on: string;
        }[]
      ).map((r) => r.depends_on);
      this.depsCache.set(id, deps); // 依賴在建立後不可變，可以放心緩存
    }
    return deps;
  }
  private fromRow(r: TaskRow): Task {
    return {
      ...r,
      labels: JSON.parse(r.labels),
      result: r.result ? JSON.parse(r.result) : null,
      reviews: JSON.parse(r.reviews),
      deps: this.depsOf(r.id),
    };
  }
  insertTask(t: Task) {
    const { deps: _deps, ...row } = this.toRow(t);
    this.db
      .prepare(
        `INSERT INTO tasks (id,project_id,key,title,description,acceptance,labels,state,assignee,last_assignee,
           lease_expires_at,attempt,result,reviews,blocked_reason,created_at,updated_at)
         VALUES (@id,@project_id,@key,@title,@description,@acceptance,@labels,@state,@assignee,@last_assignee,
           @lease_expires_at,@attempt,@result,@reviews,@blocked_reason,@created_at,@updated_at)`,
      )
      .run(row);
    // 依賴的任務可能還沒插入（同一批建立），所以這個事務內暫緩外鍵檢查
    this.db.pragma('defer_foreign_keys = ON');
    const ins = this.db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)');
    for (const d of t.deps) ins.run(t.id, d);
  }
  updateTask(t: Task) {
    const { deps: _deps, ...row } = this.toRow(t);
    this.db.prepare(`UPDATE tasks SET ${TASK_COLS} WHERE id=@id`).run(row);
  }
  casTask(t: Task, expected: TaskState[]) {
    const { deps: _deps, ...row } = this.toRow(t);
    const marks = expected.map((_, i) => `@exp${i}`).join(',');
    const exp = Object.fromEntries(expected.map((s, i) => [`exp${i}`, s]));
    // 條件更新：WHERE state IN (...) 不成立就一行都不改，這就是「原子領取」
    const info = this.db
      .prepare(`UPDATE tasks SET ${TASK_COLS} WHERE id=@id AND state IN (${marks})`)
      .run({ ...row, ...exp });
    return info.changes === 1;
  }
  getTask(id: string) {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | undefined;
    return r && this.fromRow(r);
  }
  listTasks(projectId?: string) {
    const rows = (
      projectId
        ? this.db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY rowid').all(projectId)
        : this.db.prepare('SELECT * FROM tasks ORDER BY rowid').all()
    ) as TaskRow[];
    return rows.map((r) => this.fromRow(r));
  }

  // ── workers ──
  upsertWorker(w: Worker) {
    this.db
      .prepare(
        `INSERT INTO workers (id,name,machine,labels,status,current_task,last_seen,registered_at)
         VALUES (@id,@name,@machine,@labels,@status,@current_task,@last_seen,@registered_at)
         ON CONFLICT(id) DO UPDATE SET name=@name, machine=@machine, labels=@labels, status=@status,
           current_task=@current_task, last_seen=@last_seen`,
      )
      .run({ ...w, labels: JSON.stringify(w.labels) });
  }
  private workerFromRow(r: WorkerRow): Worker {
    return { ...r, labels: JSON.parse(r.labels) };
  }
  getWorker(id: string) {
    const r = this.db.prepare('SELECT * FROM workers WHERE id=?').get(id) as WorkerRow | undefined;
    return r && this.workerFromRow(r);
  }
  listWorkers() {
    return (this.db.prepare('SELECT * FROM workers ORDER BY registered_at, rowid').all() as WorkerRow[]).map((r) =>
      this.workerFromRow(r),
    );
  }

  // ── events ──
  appendEvent(e: Omit<PmEvent, 'id'>) {
    const info = this.db
      .prepare('INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)')
      .run(e.ts, e.type, JSON.stringify(e));
    return { ...e, id: Number(info.lastInsertRowid) } as PmEvent;
  }
  listEvents(sinceId = 0, limit = 1000) {
    const rows = this.db
      .prepare('SELECT id, payload FROM (SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(sinceId, limit) as { id: number; payload: string }[];
    return rows.map((r) => ({ ...JSON.parse(r.payload), id: r.id }) as PmEvent);
  }
  lastEventId() {
    const r = this.db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null };
    return r.id ?? 0;
  }
}
