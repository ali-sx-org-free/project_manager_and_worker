import type { Member, PmEvent, Project, Task, TaskState, User, Worker } from './types.ts';

/** 存儲介面。服務端用 SQLite 實現，瀏覽器示範模式用記憶體實現，狀態機邏輯共用同一份 Engine。 */
export interface Store {
  transaction<T>(fn: () => T): T;

  insertProject(p: Project): void;
  updateProject(p: Project): void;
  getProject(id: string): Project | undefined;
  listProjects(): Project[];

  insertTask(t: Task): void;
  updateTask(t: Task): void;
  /** 原子 compare-and-swap：只有當任務目前狀態仍在 `expected` 之中才寫入，返回是否成功。
   *  領取任務靠它保證「同一個任務只會被一個 worker 領到」。 */
  casTask(t: Task, expected: TaskState[]): boolean;
  getTask(id: string): Task | undefined;
  listTasks(projectId?: string): Task[];

  upsertWorker(w: Worker): void;
  getWorker(id: string): Worker | undefined;
  listWorkers(): Worker[];

  /** tokenHash 由服務端算好傳進來（core 不碰密碼學）；瀏覽器示範模式不用 token */
  upsertUser(u: User, tokenHash?: string | null): void;
  getUser(id: string): User | undefined;
  findUserByTokenHash(hash: string): User | undefined;
  listUsers(): User[];

  setMember(m: Member): void;
  removeMember(projectId: string, userId: string): void;
  listMembers(projectId?: string): Member[];

  appendEvent(e: Omit<PmEvent, 'id'>): PmEvent;
  listEvents(sinceId?: number, limit?: number): PmEvent[];
  lastEventId(): number;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class MemoryStore implements Store {
  private projects = new Map<string, Project>();
  private tasks = new Map<string, Task>();
  private workers = new Map<string, Worker>();
  private users = new Map<string, User>();
  private tokens = new Map<string, string>();
  private members = new Map<string, Member>();
  private events: PmEvent[] = [];
  private seq = 0;

  transaction<T>(fn: () => T): T {
    return fn();
  }

  insertProject(p: Project) {
    this.projects.set(p.id, clone(p));
  }
  updateProject(p: Project) {
    this.projects.set(p.id, clone(p));
  }
  getProject(id: string) {
    const p = this.projects.get(id);
    return p && clone(p);
  }
  listProjects() {
    return [...this.projects.values()].map(clone);
  }

  insertTask(t: Task) {
    this.tasks.set(t.id, clone(t));
  }
  updateTask(t: Task) {
    this.tasks.set(t.id, clone(t));
  }
  casTask(t: Task, expected: TaskState[]) {
    const cur = this.tasks.get(t.id);
    if (!cur || !expected.includes(cur.state)) return false;
    this.tasks.set(t.id, clone(t));
    return true;
  }
  getTask(id: string) {
    const t = this.tasks.get(id);
    return t && clone(t);
  }
  listTasks(projectId?: string) {
    const all = [...this.tasks.values()];
    return (projectId ? all.filter((t) => t.project_id === projectId) : all).map(clone);
  }

  upsertWorker(w: Worker) {
    this.workers.set(w.id, clone(w));
  }
  getWorker(id: string) {
    const w = this.workers.get(id);
    return w && clone(w);
  }
  listWorkers() {
    return [...this.workers.values()].map(clone);
  }

  upsertUser(u: User, tokenHash?: string | null) {
    this.users.set(u.id, clone(u));
    if (tokenHash) this.tokens.set(tokenHash, u.id);
  }
  getUser(id: string) {
    const u = this.users.get(id);
    return u && clone(u);
  }
  findUserByTokenHash(hash: string) {
    const id = this.tokens.get(hash);
    return id ? this.getUser(id) : undefined;
  }
  listUsers() {
    return [...this.users.values()].map(clone);
  }

  setMember(m: Member) {
    this.members.set(`${m.project_id}/${m.user_id}`, clone(m));
  }
  removeMember(projectId: string, userId: string) {
    this.members.delete(`${projectId}/${userId}`);
  }
  listMembers(projectId?: string) {
    const all = [...this.members.values()];
    return (projectId ? all.filter((m) => m.project_id === projectId) : all).map(clone);
  }

  appendEvent(e: Omit<PmEvent, 'id'>) {
    const ev = { ...clone(e), id: ++this.seq } as PmEvent;
    this.events.push(ev);
    // 瀏覽器示範模式會一直跑，避免無限增長
    if (this.events.length > 5000) this.events.splice(0, 1000);
    return ev;
  }
  listEvents(sinceId = 0, limit = 1000) {
    const out = this.events.filter((e) => e.id > sinceId);
    return out.slice(Math.max(0, out.length - limit));
  }
  lastEventId() {
    return this.seq;
  }
}
