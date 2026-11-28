import type { HttpRequest, HttpResponse, Transport } from './client.ts';

/** 記憶體裡的假 GitHub：只實現 apm 用到的 REST 端點，行為照真實 GitHub（分頁、標籤篩選、since、權限）。
 *  測試用它跑完整的狀態機；多個 token 代表多個帳號。 */

interface FUser {
  login: string;
  token: string;
}
interface FIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  labels: string[];
  assignees: string[];
  user: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  sub_issues: number[];
}
interface FComment {
  id: number;
  issue: number;
  body: string;
  user: string;
  created_at: number;
  updated_at: number;
}
interface FPull {
  number: number;
  title: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_by: string | null;
  mergeable: boolean;
  user: string;
  reviews: { user: string; state: string; body: string; submitted_at: number }[];
  sha: string;
}
interface FRepo {
  owner: string;
  name: string;
  private: boolean;
  default_branch: string;
  /** login → 權限 */
  collaborators: Map<string, 'admin' | 'push' | 'triage' | 'pull'>;
  invitations: Set<string>;
  issues: Map<number, FIssue>;
  pulls: Map<number, FPull>;
  comments: Map<number, FComment>;
  labels: Map<string, string>;
  files: Map<string, string>;
  branches: Set<string>;
  next: number;
  allowedMerge: Set<string>;
  /** 開 PR 時不檢查分支在不在（本機假 GitHub 用：分支推到了另一個裸倉庫，REST 這邊不知道） */
  anyHead?: boolean;
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

export class FakeGitHub {
  private users = new Map<string, FUser>();
  private repos = new Map<string, FRepo>();
  private seq = 1000;
  private commentSeq = 5000;
  /** 每個請求記一筆（測試用來數寫入次數） */
  log: { method: string; path: string; user: string | null }[] = [];
  clock: number;
  /** 模擬有些環境（例如 Claude Code 雲端會話）寫 Issue、留言、PR 時自動在正文最後加的頁腳 */
  footer: string | null = null;
  /** 測試用：讓某個請求失敗 */
  failNext: ((method: string, path: string) => { status: number; message: string } | null) | null = null;

  constructor(start = Date.parse('2026-11-22T00:00:00Z')) {
    this.clock = start;
  }

  now = () => this.clock;

  private withFooter(text: string): string {
    return this.footer ? `${text}${this.footer}` : text;
  }
  advance(ms: number) {
    this.clock += ms;
  }

  addUser(login: string): string {
    const token = `tok-${login}`;
    this.users.set(token, { login, token });
    return token;
  }

  addRepo(full: string, opts: { private?: boolean; owner?: string; empty?: boolean } = {}): FRepo {
    const [owner, name] = full.split('/');
    const r: FRepo = {
      owner,
      name,
      private: opts.private ?? true,
      default_branch: 'main',
      collaborators: new Map(),
      invitations: new Set(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      labels: new Map(),
      files: new Map(),
      branches: new Set(opts.empty ? [] : ['main']),
      next: 1,
      allowedMerge: new Set(['merge', 'squash', 'rebase']),
    };
    if (opts.owner) r.collaborators.set(opts.owner, 'admin');
    this.repos.set(full, r);
    return r;
  }

  repo(full: string) {
    const r = this.repos.get(full);
    if (!r) throw new Error(`fake: no repo ${full}`);
    return r;
  }

  grant(full: string, login: string, perm: 'admin' | 'push' | 'triage' | 'pull' = 'push') {
    this.repo(full).collaborators.set(login, perm);
  }

  /** 模擬 worker 開 PR */
  openPr(full: string, head: string, title: string, user: string): string {
    const r = this.repo(full);
    const number = r.next++;
    r.pulls.set(number, { number, title, head, base: r.default_branch, state: 'open', merged: false, merged_by: null, mergeable: true, user, reviews: [], sha: `sha${number}` });
    return `https://github.com/${full}/pull/${number}`;
  }

  /** 模擬「分支已經推上去了」 */
  pushBranch(full: string, branch: string) {
    this.repo(full).branches.add(branch);
  }

  reviewPr(full: string, n: number, user: string, state: 'APPROVED' | 'CHANGES_REQUESTED', body = '') {
    this.repo(full).pulls.get(n)!.reviews.push({ user, state, body, submitted_at: this.clock });
  }

  mergePrByHand(full: string, n: number, user: string) {
    const pr = this.repo(full).pulls.get(n)!;
    pr.merged = true;
    pr.state = 'closed';
    pr.merged_by = user;
  }

  pull(full: string, n: number) {
    return this.repo(full).pulls.get(n);
  }

  writes() {
    return this.log.filter((l) => l.method !== 'GET').length;
  }

  // ───────────────────────── HTTP ─────────────────────────

  transport: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
    await Promise.resolve();
    const auth = req.headers.authorization?.replace(/^Bearer\s+/, '');
    const user = auth ? (this.users.get(auth)?.login ?? null) : null;
    const u = new URL(req.url);
    this.log.push({ method: req.method, path: u.pathname, user });
    const headers: Record<string, string> = {
      date: new Date(this.clock).toUTCString(),
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': String(Math.floor(this.clock / 1000) + 3600),
    };
    const reply = (status: number, data?: unknown): HttpResponse => ({
      status,
      headers,
      text: data === undefined ? '' : JSON.stringify(data),
    });
    if (!user) return reply(401, { message: 'Bad credentials' });
    const forced = this.failNext?.(req.method, u.pathname);
    if (forced) {
      this.failNext = null;
      return reply(forced.status, { message: forced.message });
    }
    try {
      const body = req.body ? JSON.parse(req.body) : {};
      return this.route(req.method, u, body, user, reply);
    } catch (err) {
      return reply(500, { message: err instanceof Error ? err.message : String(err) });
    }
  };

  private route(method: string, u: URL, body: Record<string, unknown>, user: string, reply: (s: number, d?: unknown) => HttpResponse): HttpResponse {
    const p = u.pathname;
    const q = u.searchParams;
    if (p === '/user' && method === 'GET') return reply(200, { login: user });
    if (p === '/rate_limit') return reply(200, { resources: { core: { limit: 5000, remaining: 4999 } } });
    if ((p === '/user/repos' || /^\/orgs\/[^/]+\/repos$/.test(p)) && method === 'POST') {
      const owner = p === '/user/repos' ? user : p.split('/')[2];
      const full = `${owner}/${body.name}`;
      if (this.repos.has(full)) return reply(422, { message: 'name already exists on this account' });
      const r = this.addRepo(full, { private: body.private !== false, owner: user, empty: true });
      return reply(201, this.repoJson(r, user));
    }
    const m = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return reply(404, { message: 'Not Found' });
    const r = this.repos.get(`${m[1]}/${m[2]}`);
    const perm = r?.collaborators.get(user);
    if (!r || !perm) return reply(404, { message: 'Not Found' });
    const canWrite = perm === 'admin' || perm === 'push';
    const canTriage = canWrite || perm === 'triage';
    const rest = m[3] ?? '';
    const page = (list: unknown[]) => {
      const per = Number(q.get('per_page') ?? 30);
      const pg = Number(q.get('page') ?? 1);
      return list.slice((pg - 1) * per, pg * per);
    };
    const now = this.clock;

    if (rest === '' && method === 'GET') return reply(200, this.repoJson(r, user));

    // contents
    let mm = rest.match(/^\/contents\/(.+)$/);
    if (mm) {
      const path = decodeURIComponent(mm[1]);
      if (method === 'GET') {
        const f = r.files.get(path);
        return f === undefined ? reply(404, { message: 'Not Found' }) : reply(200, { content: Buffer.from(f).toString('base64'), encoding: 'base64' });
      }
      if (method === 'PUT') {
        if (!canWrite) return reply(403, { message: 'Resource not accessible' });
        r.files.set(path, Buffer.from(String(body.content), 'base64').toString('utf8'));
        r.branches.add(r.default_branch);
        return reply(201, { content: { path } });
      }
    }
    if (rest === '/branches') return reply(200, page([...r.branches].map((name) => ({ name }))));

    // labels
    if (rest === '/labels') {
      if (method === 'GET') return reply(200, page([...r.labels].map(([name, color]) => ({ name, color }))));
      if (method === 'POST') {
        if (!canWrite) return reply(403, { message: 'Resource not accessible' });
        if (r.labels.has(String(body.name))) return reply(422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] });
        r.labels.set(String(body.name), String(body.color ?? 'cccccc'));
        return reply(201, { name: body.name });
      }
    }

    // collaborators
    if (rest === '/collaborators' && method === 'GET') {
      return reply(200, page([...r.collaborators].map(([login, perm]) => ({ login, role_name: perm === 'push' ? 'write' : perm }))));
    }
    mm = rest.match(/^\/collaborators\/([^/]+)$/);
    if (mm) {
      const who = mm[1];
      if (method === 'GET') return r.collaborators.has(who) ? reply(204) : reply(404, { message: 'Not Found' });
      if (perm !== 'admin') return reply(403, { message: 'Must have admin rights' });
      if (method === 'PUT') {
        if (r.collaborators.has(who)) {
          r.collaborators.set(who, (body.permission as 'push') ?? 'push');
          return reply(204);
        }
        r.invitations.add(who);
        r.collaborators.set(who, (body.permission as 'push') ?? 'push'); // 測試裡直接當作已接受
        return reply(201, { invitee: { login: who } });
      }
      if (method === 'DELETE') {
        r.collaborators.delete(who);
        return reply(204);
      }
    }

    // comments（整個倉庫）
    if (rest === '/issues/comments' && method === 'GET') {
      const since = q.get('since') ? Date.parse(q.get('since')!) : 0;
      const list = [...r.comments.values()].filter((c) => c.updated_at >= since).sort((a, b) => a.updated_at - b.updated_at || a.id - b.id);
      return reply(200, page(list.map((c) => this.commentJson(r, c))));
    }
    mm = rest.match(/^\/issues\/comments\/(\d+)$/);
    if (mm) {
      const c = r.comments.get(Number(mm[1]));
      if (!c) return reply(404, { message: 'Not Found' });
      if (method === 'GET') return reply(200, this.commentJson(r, c));
      if (c.user !== user && !canWrite) return reply(403, { message: 'Resource not accessible' });
      if (method === 'PATCH') {
        c.body = this.withFooter(String(body.body));
        c.updated_at = now;
        return reply(200, this.commentJson(r, c));
      }
      if (method === 'DELETE') {
        r.comments.delete(c.id);
        return reply(204);
      }
    }

    // issues
    if (rest === '/issues') {
      if (method === 'GET') {
        const labels = (q.get('labels') ?? '').split(',').filter(Boolean);
        const state = q.get('state') ?? 'open';
        const since = q.get('since') ? Date.parse(q.get('since')!) : 0;
        const list = [...r.issues.values()]
          .filter((i) => state === 'all' || i.state === state)
          .filter((i) => labels.every((l) => i.labels.includes(l)))
          .filter((i) => i.updated_at >= since)
          .sort((a, b) => a.created_at - b.created_at || a.number - b.number);
        return reply(200, page(list.map((i) => this.issueJson(r, i))));
      }
      if (method === 'POST') {
        if (!canTriage) return reply(403, { message: 'Resource not accessible' });
        const number = r.next++;
        const labels = ((body.labels as string[]) ?? []).map(String);
        for (const l of labels) if (!r.labels.has(l)) r.labels.set(l, 'ededed');
        const i: FIssue = {
          id: ++this.seq,
          number,
          title: String(body.title),
          body: this.withFooter(String(body.body ?? '')),
          state: 'open',
          state_reason: null,
          labels,
          assignees: canWrite ? ((body.assignees as string[]) ?? []) : [],
          user,
          created_at: now,
          updated_at: now,
          closed_at: null,
          sub_issues: [],
        };
        r.issues.set(number, i);
        return reply(201, this.issueJson(r, i));
      }
    }
    mm = rest.match(/^\/issues\/(\d+)(\/.*)?$/);
    if (mm) {
      const n = Number(mm[1]);
      const sub = mm[2] ?? '';
      const i = r.issues.get(n);
      const pr = r.pulls.get(n);
      if (!i && !pr) return reply(404, { message: 'Not Found' });
      if (sub === '' && i) {
        if (method === 'GET') return reply(200, this.issueJson(r, i));
        if (method === 'PATCH') {
          if (!canTriage) return reply(403, { message: 'Resource not accessible' });
          if (body.title !== undefined) i.title = String(body.title);
          if (body.body !== undefined) i.body = this.withFooter(String(body.body));
          if (body.labels !== undefined) {
            i.labels = (body.labels as string[]).map(String);
            for (const l of i.labels) if (!r.labels.has(l)) r.labels.set(l, 'ededed');
          }
          if (body.assignees !== undefined) {
            const bad = (body.assignees as string[]).find((a) => !r.collaborators.has(a));
            if (bad) return reply(422, { message: `Validation Failed: ${bad} cannot be assigned` });
            i.assignees = body.assignees as string[];
          }
          if (body.state !== undefined && body.state !== i.state) {
            i.state = body.state as 'open' | 'closed';
            i.closed_at = i.state === 'closed' ? now : null;
            i.state_reason = i.state === 'closed' ? String(body.state_reason ?? 'completed') : 'reopened';
          } else if (body.state_reason !== undefined) i.state_reason = String(body.state_reason);
          i.updated_at = now;
          return reply(200, this.issueJson(r, i));
        }
      }
      if (sub === '/comments') {
        if (method === 'GET') {
          const list = [...r.comments.values()].filter((c) => c.issue === n).sort((a, b) => a.created_at - b.created_at || a.id - b.id);
          return reply(200, page(list.map((c) => this.commentJson(r, c))));
        }
        if (method === 'POST') {
          const c: FComment = { id: ++this.commentSeq, issue: n, body: this.withFooter(String(body.body)), user, created_at: now, updated_at: now };
          r.comments.set(c.id, c);
          if (i) i.updated_at = now;
          return reply(201, this.commentJson(r, c));
        }
      }
      if (sub === '/sub_issues' && method === 'POST' && i) {
        if (!canTriage) return reply(403, { message: 'Resource not accessible' });
        const child = [...r.issues.values()].find((x) => x.id === Number(body.sub_issue_id));
        if (!child) return reply(422, { message: 'Validation Failed' });
        if (i.sub_issues.length >= 100) return reply(422, { message: 'Sub-issue limit reached' });
        i.sub_issues.push(child.number);
        return reply(201, this.issueJson(r, i));
      }
    }

    // pulls
    if (rest === '/pulls' && method === 'POST') {
      if (!canWrite) return reply(403, { message: 'Resource not accessible' });
      const head = String(body.head ?? '');
      if (!r.anyHead && !r.branches.has(head)) return reply(422, { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] });
      if ([...r.pulls.values()].some((x) => x.head === head && x.state === 'open')) return reply(422, { message: `A pull request already exists for ${r.owner}:${head}.` });
      const url = this.openPr(`${r.owner}/${r.name}`, head, String(body.title ?? head), user);
      const pr = r.pulls.get(Number(url.split('/').pop()))!;
      pr.base = String(body.base ?? r.default_branch);
      return reply(201, this.pullJson(r, pr));
    }
    if (rest === '/pulls' && method === 'GET') {
      const head = q.get('head');
      const state = q.get('state') ?? 'open';
      const list = [...r.pulls.values()]
        .filter((x) => state === 'all' || x.state === state)
        .filter((x) => !head || `${r.owner}:${x.head}` === head);
      return reply(200, page(list.map((x) => this.pullJson(r, x))));
    }
    mm = rest.match(/^\/pulls\/(\d+)(\/.*)?$/);
    if (mm) {
      const pr = r.pulls.get(Number(mm[1]));
      if (!pr) return reply(404, { message: 'Not Found' });
      const sub = mm[2] ?? '';
      if (sub === '' && method === 'GET') return reply(200, this.pullJson(r, pr));
      if (sub === '/reviews' && method === 'GET') {
        return reply(200, pr.reviews.map((x) => ({ user: { login: x.user }, state: x.state, body: x.body, submitted_at: iso(x.submitted_at) })));
      }
      if (sub === '/merge' && method === 'PUT') {
        if (!canWrite) return reply(403, { message: 'Resource not accessible' });
        if (pr.merged) return reply(405, { message: 'Pull Request is not mergeable' });
        if (!r.allowedMerge.has(String(body.merge_method ?? 'merge'))) return reply(405, { message: 'Merge method not allowed' });
        if (!pr.mergeable) return reply(405, { message: 'Pull Request is not mergeable' });
        if (body.sha && body.sha !== pr.sha) return reply(409, { message: 'Head branch was modified' });
        pr.merged = true;
        pr.state = 'closed';
        pr.merged_by = user;
        return reply(200, { merged: true, sha: `m${pr.sha}` });
      }
    }
    return reply(404, { message: `fake: ${method} ${p} not implemented` });
  }

  private repoJson(r: FRepo, user: string) {
    const perm = r.collaborators.get(user);
    return {
      full_name: `${r.owner}/${r.name}`,
      private: r.private,
      html_url: `https://github.com/${r.owner}/${r.name}`,
      default_branch: r.default_branch,
      size: r.branches.size ? 1 : 0,
      permissions: { admin: perm === 'admin', push: perm === 'admin' || perm === 'push', triage: !!perm && perm !== 'pull', pull: !!perm },
    };
  }

  private issueJson(r: FRepo, i: FIssue) {
    return {
      id: i.id,
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      state_reason: i.state_reason,
      labels: i.labels.map((name) => ({ name })),
      assignees: i.assignees.map((login) => ({ login })),
      user: { login: i.user },
      created_at: iso(i.created_at),
      updated_at: iso(i.updated_at),
      closed_at: iso(i.closed_at),
      html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}`,
      sub_issues_summary: { total: i.sub_issues.length, completed: i.sub_issues.filter((n) => r.issues.get(n)?.state === 'closed').length },
    };
  }

  private commentJson(r: FRepo, c: FComment) {
    return {
      id: c.id,
      body: c.body,
      user: { login: c.user },
      created_at: iso(c.created_at),
      updated_at: iso(c.updated_at),
      html_url: `https://github.com/${r.owner}/${r.name}/issues/${c.issue}#issuecomment-${c.id}`,
      issue_url: `https://api.github.com/repos/${r.owner}/${r.name}/issues/${c.issue}`,
    };
  }

  private pullJson(r: FRepo, x: FPull) {
    return {
      number: x.number,
      title: x.title,
      state: x.state,
      merged: x.merged,
      merged_by: x.merged_by ? { login: x.merged_by } : null,
      mergeable: x.mergeable,
      html_url: `https://github.com/${r.owner}/${r.name}/pull/${x.number}`,
      head: { ref: x.head, sha: x.sha },
      base: { ref: x.base },
      user: { login: x.user },
    };
  }
}
