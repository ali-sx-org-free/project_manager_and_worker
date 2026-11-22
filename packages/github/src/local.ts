import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { Lock } from './locks.ts';

/** 本機的設定和狀態都放在 ~/.agent-pm（可以用 APM_HOME 換地方，例如同一台電腦跑兩個 worker） */
export const apmHome = () => process.env.APM_HOME || join(homedir(), '.agent-pm');

export interface LocalConfig {
  hub?: string;
  worker?: {
    id?: string;
    name?: string;
    machine?: string;
    labels?: string[];
    /** 只為這些項目（短名）幹活 */
    projects?: string[] | null;
    /** 代碼倉庫在本機的路徑，例如 {"ali-sx-org-free/site": "/home/me/code/site"} */
    repos?: Record<string, string>;
  };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

export const configPath = () => join(apmHome(), 'config.json');
export const loadConfig = (): LocalConfig => readJson<LocalConfig>(configPath()) ?? {};
export const saveConfig = (c: LocalConfig) => writeJson(configPath(), c);

export const defaultWorkerId = () =>
  (process.env.APM_WORKER_ID ||
    hostname()
      .toLowerCase()
      .replace(/\.local$/, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') ||
    'worker');

/** 這台 worker 手上的任務（只存在本機）。heartbeat、checkpoint 都靠它知道該續哪一把鎖 */
export interface HeldState {
  hub: string;
  worker: string;
  task: number;
  project_key: string;
  title: string;
  attempt: number;
  lock: Lock;
  /** 這次領取的進度留言 id，檢查點就地編輯它 */
  comment_id: number;
  branch: string;
  code_repo: string;
  claimed_at: number;
  /** 最後一次有 apm 命令動過這個任務（keepalive 用來判斷 agent 還在不在） */
  last_activity: number;
  /** 已經發現被別人接手 */
  lost?: { at: number; holder: string | null };
}

export class StateFile {
  readonly path: string;
  constructor(hub: string, worker: string) {
    this.path = join(apmHome(), 'state', hub.replace('/', '__'), `${worker}.json`);
  }
  load(): HeldState | null {
    return existsSync(this.path) ? readJson<HeldState>(this.path) : null;
  }
  save(s: HeldState) {
    writeJson(this.path, s);
  }
  clear() {
    rmSync(this.path, { force: true });
  }
  /** 記下「agent 剛剛還在動」 */
  touch() {
    const s = this.load();
    if (s) this.save({ ...s, last_activity: Date.now() });
  }
}
