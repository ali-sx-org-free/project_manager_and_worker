import { execFileSync } from 'node:child_process';

/** 一次 HTTP 往返。真實環境用 fetch，測試用記憶體裡的假 GitHub（fake.ts）。 */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, headers, text: await res.text() };
};

/** 登入：GH_TOKEN / GITHUB_TOKEN 環境變量優先，沒有就借用 `gh auth token`。 */
export function resolveToken(): string | undefined {
  const env = process.env.APM_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env.trim();
  try {
    const t = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export interface GitHubOptions {
  token?: string;
  transport?: Transport;
  apiBase?: string;
  /** 本機時鐘，只用來量「距離上次收到 GitHub 時間過了多久」 */
  now?: () => number;
  /** GET 帶 If-None-Match：沒變化時 GitHub 返回 304，不算 API 額度（管理端輪詢用） */
  etags?: boolean;
}

/** GitHub REST 的薄封裝。順便記下 GitHub 的時間（每個回應的 Date 標頭），租約一律按 GitHub 的時鐘算。 */
export class GitHub {
  readonly apiBase: string;
  private transport: Transport;
  private token?: string;
  private localNow: () => number;
  private offset = 0;
  private synced = false;
  rate: { limit: number; remaining: number; reset: number } | null = null;
  private etagCache: Map<string, { etag: string; text: string }> | null;
  /** 統計：請求數、其中 304 的數目 */
  stats = { requests: 0, notModified: 0 };

  constructor(opts: GitHubOptions = {}) {
    this.etagCache = opts.etags ? new Map() : null;
    this.apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.transport = opts.transport ?? fetchTransport;
    this.token = opts.token;
    this.localNow = opts.now ?? Date.now;
  }

  /** 以 GitHub 的時鐘為準的「現在」（毫秒） */
  now(): number {
    return this.localNow() + this.offset;
  }

  async syncClock(): Promise<void> {
    if (!this.synced) await this.request('GET', '/rate_limit');
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: { accept404?: boolean } = {},
  ): Promise<{ status: number; data: T; headers: Record<string, string> }> {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'agent-pm-apm',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const cached = method === 'GET' ? this.etagCache?.get(url) : undefined;
    if (cached) headers['if-none-match'] = cached.etag;
    let res: HttpResponse | undefined;
    let lastErr: unknown;
    // 網路抖動和 5xx 重試兩次；GitHub 要求放慢（secondary rate limit）時照它說的等；其他 4xx 不重試
    let slowdowns = 0;
    for (let i = 0; i < 3; i++) {
      try {
        res = await this.transport({ method, url, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        if ((res.status === 403 || res.status === 429) && slowdowns < 2 && /secondary rate limit|abuse/i.test(res.text)) {
          const wait = Math.min(120, Number(res.headers['retry-after']) || 30 * (slowdowns + 1));
          slowdowns++;
          i--;
          process.stderr.write(`GitHub 要求放慢寫入速度，等 ${wait} 秒再試…\n`);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        if (res.status < 500) break;
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
    if (!res) throw new GitHubError(0, `連不上 GitHub：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    this.stats.requests++;
    if (res.status === 304 && cached) {
      this.stats.notModified++;
      res = { ...res, status: 200, text: cached.text };
    } else if (method === 'GET' && this.etagCache && res.status === 200 && res.headers['etag']) {
      this.etagCache.set(url, { etag: res.headers['etag'], text: res.text });
    }
    const date = res.headers['date'];
    if (date) {
      const t = Date.parse(date);
      if (!Number.isNaN(t)) {
        this.offset = t - this.localNow();
        this.synced = true;
      }
    }
    if (res.headers['x-ratelimit-remaining']) {
      this.rate = {
        limit: Number(res.headers['x-ratelimit-limit']),
        remaining: Number(res.headers['x-ratelimit-remaining']),
        reset: Number(res.headers['x-ratelimit-reset']) * 1000,
      };
    }
    let data: unknown = null;
    if (res.text) {
      try {
        data = JSON.parse(res.text);
      } catch {
        data = res.text;
      }
    }
    if (res.status === 404 && opts.accept404) return { status: 404, data: null as T, headers: res.headers };
    if (res.status >= 400) {
      const msg = (data as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      const hint =
        res.status === 401
          ? '（GitHub 登入無效：執行 gh auth login）'
          : res.status === 403 && /rate limit/i.test(msg)
            ? '（API 額度用完，稍後再試）'
            : res.status === 404
              ? '（不存在，或你沒有這個倉庫的權限）'
              : '';
      throw new GitHubError(res.status, `${method} ${path}：${msg}${hint}`, data);
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }

  get<T>(path: string) {
    return this.request<T>('GET', path).then((r) => r.data);
  }
  async getOrNull<T>(path: string): Promise<T | null> {
    const r = await this.request<T>('GET', path, undefined, { accept404: true });
    return r.status === 404 ? null : r.data;
  }
  post<T>(path: string, body: unknown) {
    return this.request<T>('POST', path, body).then((r) => r.data);
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body).then((r) => r.data);
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>('PUT', path, body).then((r) => r.data);
  }
  del(path: string) {
    return this.request('DELETE', path).then(() => undefined);
  }

  /** 逐頁讀完一個列表（每頁 100 筆） */
  async paginate<T>(path: string, max = 50): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= max; page++) {
      const items = await this.get<T[]>(`${path}${sep}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }
}
