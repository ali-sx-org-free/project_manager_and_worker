import type { InterruptReason, ResumeContext, Review } from '@agent-pm/core';
import {
  branchOf,
  deriveTask,
  depsDone,
  listClaimable,
  resumeOf,
  type AttemptMeta,
  type CheckpointMeta,
  type ClaimableResult,
  type SubmittedMeta,
  type WorkerMeta,
} from './derive.ts';
import type { Hub, ProjectInfo, TaskInfo } from './hub.ts';
import type { HeldState, StateFile } from './local.ts';
import { isAlive, type Lock, type LockPayload, type LockStatus } from './locks.ts';
import { readCommentMeta } from './meta.ts';

export interface WorkerIdentity {
  id: string;
  name: string;
  machine: string;
  labels: string[];
  projects: string[] | null;
  /** GitHub 帳號 */
  owner: string;
}

/** 租約已經不屬於你：任務被別人接手（或被管理員收回）。照 Skill 第 7 節處理：停手、不 push、不交付 */
export class LeaseLost extends Error {
  readonly code = 'lease_lost';
  constructor(
    message: string,
    public detail: { task: number; holder: string | null; status: LockStatus | null },
  ) {
    super(message);
    this.name = 'LeaseLost';
  }
}

export class NothingHeld extends Error {
  readonly code = 'no_task';
  constructor() {
    super('這個 worker 手上沒有任務。先用 apm claim 領一個');
  }
}

export interface ClaimResult {
  task: {
    number: number;
    id: string;
    url: string;
    title: string;
    description: string;
    acceptance: string;
    project: string;
    project_title: string;
    key: string;
    caps: string[];
    deps: number[];
    human_review: boolean;
  };
  attempt: number;
  resume: ResumeContext | null;
  reviews: Review[];
  git: {
    repo: string;
    base: string | null;
    branch: string;
    commit_prefix: string;
    commit_trailers: string;
    pr_title: string;
    pr_body_footer: string;
  };
  lease_ms: number;
  heartbeat_every_ms: number;
  lease_expires_at: number;
}

function renderAttempt(m: AttemptMeta, title: string): string {
  const last = m.checkpoints.at(-1);
  const head = m.resumed?.progress
    ? `**第 ${m.attempt} 次領取** · ${m.worker}（${m.owner}）從 ${m.resumed.progress}% 接手${m.resumed.from_worker && m.resumed.from_worker !== m.worker ? `（上一位 ${m.resumed.from_worker}）` : ''}`
    : `**第 ${m.attempt} 次領取** · ${m.worker}（${m.owner}）`;
  const lines = [head, ''];
  if (!last) lines.push(`開始做「${title}」，還沒有檢查點。`);
  else {
    lines.push(`**進度 ${last.progress ?? 0}%**${last.commit ? ` · commit \`${last.commit}\`` : ''}`, '', `做完了：${last.summary}`);
    if (last.next_steps) lines.push('', `接下來：${last.next_steps}`);
    if (m.checkpoints.length > 1) {
      lines.push('', '<details><summary>之前的檢查點</summary>', '');
      for (const cp of m.checkpoints.slice(0, -1).reverse()) lines.push(`- ${cp.progress ?? 0}% ${cp.summary.replace(/\n/g, ' ')}`);
      lines.push('', '</details>');
    }
  }
  lines.push('', '_這條留言會隨著檢查點更新（編輯留言不發通知）。_');
  return lines.join('\n');
}

const REASON_TEXT: Record<string, string> = {
  interrupted: '被人工打斷',
  usage_limit: '用量額度用完',
  released: '主動交出',
  error: '環境出錯',
  lease_expired: '心跳中斷，租約超時',
};

export class WorkerOps {
  constructor(
    public hub: Hub,
    public me: WorkerIdentity,
    public state: StateFile,
  ) {}

  private async leaseMs() {
    return (await this.hub.config()).lease_minutes * 60_000;
  }

  // ───────────── 名冊 ─────────────

  async updateRoster(patch: Partial<WorkerMeta> = {}): Promise<WorkerMeta> {
    const issue = await this.hub.rosterIssue();
    const mine = (await this.hub.comments(issue)).find((c) => c.meta.kind === 'worker' && c.meta.id === this.me.id);
    const prev = mine?.meta as unknown as WorkerMeta | undefined;
    if (prev && prev.owner && prev.owner !== this.me.owner) {
      throw new Error(`worker id「${this.me.id}」已經登記在 ${prev.owner} 名下，換一個 id（apm join --id 新名字）`);
    }
    const now = this.hub.now();
    const meta: WorkerMeta = {
      kind: 'worker',
      id: this.me.id,
      name: this.me.name,
      machine: this.me.machine,
      owner: this.me.owner,
      labels: this.me.labels,
      projects: this.me.projects,
      status: 'online',
      current_task: prev?.current_task ?? null,
      seen: now,
      registered_at: prev?.registered_at ?? now,
      ...patch,
    };
    const text = [
      `**${meta.name}**（\`${meta.id}\`）· ${meta.owner} 的 ${meta.machine || '電腦'}`,
      `能力：${meta.labels.join('、') || '（無）'}；${meta.projects?.length ? `只做 ${meta.projects.join('、')}` : '所有能參與的項目'}`,
      meta.status === 'left' ? '狀態：已離開' : meta.current_task ? `正在做 #${meta.current_task}` : '閒置',
      `最後出現：${new Date(meta.seen).toISOString()}`,
    ].join('\n\n');
    if (mine) await this.hub.editComment(mine.id, meta as unknown as WorkerMeta & Record<string, unknown>, text);
    else await this.hub.comment(issue, meta as unknown as WorkerMeta & Record<string, unknown>, text);
    return meta;
  }

  async join(): Promise<WorkerMeta> {
    return this.updateRoster({ status: 'online' });
  }

  async forget(): Promise<void> {
    const issue = await this.hub.rosterIssue();
    const mine = (await this.hub.comments(issue)).find((c) => c.meta.kind === 'worker' && c.meta.id === this.me.id);
    if (mine) await this.hub.deleteComment(mine.id);
  }

  // ───────────── 領取 ─────────────

  async list(): Promise<ClaimableResult & { now: number }> {
    const [admin, projects, tasks, locks] = await Promise.all([
      this.hub.isAdmin(this.me.owner),
      this.hub.projects('open'),
      this.hub.tasks('open'),
      this.hub.locks.list(),
    ]);
    const now = this.hub.now();
    return { ...listClaimable(this.me, admin, projects, tasks, locks, now), now };
  }

  /** 手上還有沒做完的任務嗎（以遠端的鎖為準） */
  async current(): Promise<{ held: HeldState | null; lock: Lock | null; alive: boolean }> {
    const held = this.state.load();
    if (!held) return { held: null, lock: null, alive: false };
    await this.hub.gh.syncClock();
    const lock = await this.hub.locks.get(held.task);
    const mine = !!lock && lock.worker === this.me.id && lock.attempt === held.attempt && lock.status === 'held';
    return { held, lock, alive: mine && isAlive(lock, this.hub.now()) };
  }

  async claim(taskNumber?: number): Promise<ClaimResult | null> {
    const cur = await this.current();
    if (cur.held && !cur.held.lost) {
      const l = cur.lock;
      if (l && l.worker === this.me.id && l.attempt === cur.held.attempt && l.status === 'held') {
        throw Object.assign(
          new Error(`這個 worker 還持有任務 #${cur.held.task}「${cur.held.title}」，一次只能領一個。接著做它（apm current 看詳情），或先 apm release`),
          { code: 'conflict' },
        );
      }
      this.state.clear();
    } else if (cur.held) this.state.clear();

    const [cfg, admin, projects, tasks, locks] = await Promise.all([
      this.hub.config(),
      this.hub.isAdmin(this.me.owner),
      this.hub.projects('open'),
      this.hub.tasks('open'),
      this.hub.locks.list(),
    ]);
    const leaseMs = cfg.lease_minutes * 60_000;
    const res = listClaimable(this.me, admin, projects, tasks, locks, this.hub.now());
    let cands = res.candidates;
    if (taskNumber !== undefined) {
      cands = cands.filter((c) => c.task.number === taskNumber);
      if (!cands.length) {
        throw Object.assign(new Error(`任務 #${taskNumber} 目前不可領取：${res.why.get(taskNumber) ?? '不存在、已關閉，或不是 agent-pm 的任務'}`), {
          code: 'conflict',
        });
      }
    }
    const skipProjects = new Set<number>();
    for (const c of cands.slice(0, 10)) {
      if (skipProjects.has(c.project.number)) continue;
      const now = this.hub.now();
      const prev = c.lock;
      const payload: LockPayload = {
        v: 1,
        task: c.task.number,
        project: c.project.key,
        worker: this.me.id,
        owner: this.me.owner,
        attempt: (prev?.attempt ?? 0) + 1,
        status: 'held',
        at: now,
        expires_at: now + leaseMs,
      };
      const lock = prev ? await this.hub.locks.advance(prev.sha, payload) : await this.hub.locks.create(payload);
      if (!lock) continue; // 被別人搶先
      if (await this.overQuota(c.project, tasks, lock)) {
        // 配額是軟限制：同時領取超出了，領得最晚的那個讓出來
        await this.hub.locks.advance(
          lock.sha,
          prev
            ? { ...stripSha(prev), at: this.hub.now() }
            : { ...payload, attempt: 0, status: 'released', reason: 'quota', expires_at: null, at: this.hub.now() },
        );
        skipProjects.add(c.project.number);
        continue;
      }
      return this.afterClaim(c.task, c.project, tasks, prev, lock, leaseMs, cfg.heartbeat_minutes * 60_000);
    }
    return null;
  }

  private async overQuota(p: ProjectInfo, tasks: TaskInfo[], mine: Lock): Promise<boolean> {
    if (p.max_parallel === null) return false;
    const fresh = await this.hub.locks.list();
    const now = this.hub.now();
    const live = tasks
      .filter((t) => t.project === p.number)
      .map((t) => fresh.get(t.number))
      .filter((l): l is Lock => isAlive(l, now))
      .sort((a, b) => a.at - b.at || a.sha.localeCompare(b.sha));
    if (live.length <= p.max_parallel) return false;
    return live.slice(p.max_parallel).some((l) => l.sha === mine.sha);
  }

  private async afterClaim(
    t: TaskInfo,
    p: ProjectInfo,
    openTasks: TaskInfo[],
    prev: Lock | undefined,
    lock: Lock,
    leaseMs: number,
    heartbeatMs: number,
  ): Promise<ClaimResult> {
    const now = this.hub.now();
    // 上一位斷線（鎖過期）被我接手：替他補記一條中斷記錄
    if (prev && prev.status === 'held') {
      await this.hub.comment(
        t.number,
        {
          kind: 'interrupted',
          attempt: prev.attempt,
          worker: prev.worker,
          reason: 'lease_expired',
          note: '心跳中斷，租約超時',
          at: now,
          by: this.me.id,
        },
        `**租約超時** · ${prev.worker}（第 ${prev.attempt} 次領取）超過租約沒有續約，由 ${this.me.id} 接手。`,
      );
    }
    const comments = await this.hub.comments(t.number);
    const open = new Set(openTasks.map((x) => x.number));
    const view = deriveTask(t, p.key, comments, prev, now, depsDone(t, open));
    if (view.state === 'claimed') view.state = 'ready';
    const resume = resumeOf(view);
    const meta: AttemptMeta = {
      kind: 'attempt',
      attempt: lock.attempt,
      worker: this.me.id,
      owner: this.me.owner,
      at: now,
      resumed: resume ? { from_worker: resume.from_worker, progress: resume.progress, reason: resume.reason } : null,
      checkpoints: [],
    };
    const c = await this.hub.comment(t.number, meta as unknown as AttemptMeta & Record<string, unknown>, renderAttempt(meta, t.title));
    try {
      await this.hub.setStatus(t, 'claimed', { assignees: [this.me.owner] });
    } catch {
      await this.hub.setStatus(t, 'claimed'); // 不是協作者時加不了 assignee，標籤照改
    }
    const codeRepo = p.repo ?? this.hub.name;
    const branch = branchOf(t, p.key);
    const held: HeldState = {
      hub: this.hub.name,
      worker: this.me.id,
      task: t.number,
      project_key: p.key,
      title: t.title,
      attempt: lock.attempt,
      lock,
      comment_id: c.id,
      branch,
      code_repo: codeRepo,
      claimed_at: now,
      last_activity: Date.now(),
    };
    this.state.save(held);
    await this.updateRoster({ current_task: t.number }).catch(() => undefined);
    const taskRef = `${this.hub.name}#${t.number}`;
    return {
      task: {
        number: t.number,
        id: String(t.number),
        url: t.url,
        title: t.title,
        description: t.description,
        acceptance: t.acceptance,
        project: p.key,
        project_title: p.title,
        key: t.key,
        caps: t.caps,
        deps: t.deps,
        human_review: t.human_review,
      },
      attempt: lock.attempt,
      resume,
      reviews: view.reviews,
      git: {
        repo: codeRepo,
        base: p.base,
        branch,
        commit_prefix: `[${p.key}/${t.key}]`,
        commit_trailers: `Project: ${p.key}\nTask: ${taskRef}\nWorker: ${this.me.id}`,
        pr_title: `[${p.key}/${t.key}] ${t.title}`,
        pr_body_footer: `Project: ${p.key}\nTask: ${taskRef}`,
      },
      lease_ms: leaseMs,
      heartbeat_every_ms: heartbeatMs,
      lease_expires_at: lock.expires_at!,
    };
  }

  // ───────────── 持有期間 ─────────────

  private requireHeld(): HeldState {
    const s = this.state.load();
    if (!s) throw new NothingHeld();
    if (s.lost) {
      throw new LeaseLost(`任務 #${s.task} 已經被 ${s.lost.holder ?? '別人'} 接手，請停手`, {
        task: s.task,
        holder: s.lost.holder,
        status: null,
      });
    }
    return s;
  }

  /** 把鎖往前推一步。被別人改過就拋 LeaseLost。自己的另一個進程（keepalive）剛推過的話，接著它往前推 */
  private async writeLock(s: HeldState, status: LockStatus, extra: Partial<LockPayload> = {}): Promise<Lock> {
    await this.hub.gh.syncClock();
    const leaseMs = await this.leaseMs();
    let base: Lock = s.lock;
    for (let i = 0; i < 3; i++) {
      const now = this.hub.now();
      const payload: LockPayload = {
        ...stripSha(base),
        status,
        at: now,
        expires_at: status === 'held' ? now + leaseMs : null,
        reason: undefined,
        ...extra,
      };
      const next = await this.hub.locks.advance(base.sha, payload);
      if (next) {
        this.state.save({ ...s, lock: next, last_activity: Date.now() });
        return next;
      }
      const cur = await this.hub.locks.get(s.task);
      if (cur && cur.worker === this.me.id && cur.attempt === s.attempt && cur.status === 'held') {
        base = cur;
        continue;
      }
      this.state.save({ ...s, lost: { at: Date.now(), holder: cur?.worker ?? null } });
      throw new LeaseLost(
        cur?.status === 'revoked'
          ? `任務 #${s.task} 被管理員收回了，請停手：不要再 push，也不要交付`
          : `任務 #${s.task} 的租約已經不屬於你（現在：${cur ? `${cur.worker} ${cur.status}` : '沒有鎖'}），請停手：不要再 push，也不要交付`,
        { task: s.task, holder: cur?.worker ?? null, status: cur?.status ?? null },
      );
    }
    throw new Error('續約一直衝突，稍後再試');
  }

  async heartbeat(): Promise<{ task: number; lease_expires_at: number; attempt: number }> {
    const s = this.requireHeld();
    const l = await this.writeLock(s, 'held');
    return { task: s.task, lease_expires_at: l.expires_at!, attempt: s.attempt };
  }

  async checkpoint(cp: Omit<CheckpointMeta, 'at'>): Promise<{ task: number; progress: number; lease_expires_at: number }> {
    if (!cp.summary?.trim()) throw new Error('檢查點需要 --summary：到目前為止完成了什麼');
    const s = this.requireHeld();
    const l = await this.writeLock(s, 'held');
    const c = await this.hub.gh.get<{ body: string }>(`/repos/${this.hub.name}/issues/comments/${s.comment_id}`);
    const parsed = readCommentMeta<AttemptMeta>(c.body);
    const meta: AttemptMeta = parsed?.meta ?? {
      kind: 'attempt',
      attempt: s.attempt,
      worker: this.me.id,
      owner: this.me.owner,
      at: s.claimed_at,
      checkpoints: [],
    };
    const prevProgress = meta.checkpoints.at(-1)?.progress ?? meta.resumed?.progress ?? 0;
    const entry: CheckpointMeta = {
      at: this.hub.now(),
      summary: cp.summary.trim().slice(0, 4000),
      next_steps: cp.next_steps?.trim().slice(0, 2000) || undefined,
      progress: cp.progress === undefined || Number.isNaN(cp.progress) ? prevProgress : Math.max(0, Math.min(100, Math.round(cp.progress))),
      commit: cp.commit || undefined,
      artifacts: cp.artifacts?.length ? cp.artifacts.slice(0, 20) : undefined,
      auto: cp.auto || undefined,
    };
    meta.checkpoints = [...meta.checkpoints, entry].slice(-40);
    await this.hub.editComment(s.comment_id, meta as unknown as AttemptMeta & Record<string, unknown>, renderAttempt(meta, s.title));
    return { task: s.task, progress: entry.progress!, lease_expires_at: l.expires_at! };
  }

  private async finish(s: HeldState) {
    this.state.clear();
    await this.updateRoster({ current_task: null }).catch(() => undefined);
  }

  async submit(r: { summary: string; pr_url?: string }): Promise<{ task: number; pr_url: string | null; url: string }> {
    if (!r.summary?.trim()) throw new Error('交付需要 --summary：做了什麼、怎麼驗證、對照驗收標準的結果');
    const s = this.requireHeld();
    await this.writeLock(s, 'submitted');
    const pr = r.pr_url || (await this.findPr(s));
    const meta: SubmittedMeta = { kind: 'submitted', attempt: s.attempt, worker: this.me.id, summary: r.summary.trim(), pr_url: pr ?? undefined, at: this.hub.now() };
    await this.hub.comment(
      s.task,
      meta as unknown as SubmittedMeta & Record<string, unknown>,
      `**已交付，等待 review** · ${this.me.id}（第 ${s.attempt} 次領取）${pr ? `\n\nPR：${pr}` : ''}\n\n${r.summary.trim()}`,
    );
    const t = await this.hub.task(s.task);
    await this.hub.setStatus(t, 'in_review');
    await this.finish(s);
    return { task: s.task, pr_url: pr, url: t.url };
  }

  async block(reason: string): Promise<{ task: number }> {
    if (!reason?.trim()) throw new Error('需要 --reason：缺什麼、需要誰做什麼決定');
    const s = this.requireHeld();
    await this.writeLock(s, 'blocked');
    await this.hub.comment(
      s.task,
      { kind: 'blocked', attempt: s.attempt, worker: this.me.id, reason: reason.trim(), at: this.hub.now() },
      `**受阻** · ${this.me.id}（第 ${s.attempt} 次領取）\n\n${reason.trim()}`,
    );
    await this.hub.setStatus(await this.hub.task(s.task), 'blocked');
    await this.finish(s);
    return { task: s.task };
  }

  async release(reason: InterruptReason = 'released', note = ''): Promise<{ task: number }> {
    const s = this.requireHeld();
    await this.writeLock(s, 'released', { reason });
    const text = note.trim() || REASON_TEXT[reason] || reason;
    await this.hub.comment(
      s.task,
      { kind: 'interrupted', attempt: s.attempt, worker: this.me.id, reason, note: note.trim(), at: this.hub.now() },
      `**交出任務**（${REASON_TEXT[reason] ?? reason}）· ${this.me.id}（第 ${s.attempt} 次領取）\n\n交接說明：${text}`,
    );
    await this.hub.setStatus(await this.hub.task(s.task), 'ready');
    await this.finish(s);
    return { task: s.task };
  }

  /** 交付時沒給 PR 網址：按任務分支在代碼倉庫找一個開著的 PR */
  private async findPr(s: HeldState): Promise<string | null> {
    try {
      const owner = s.code_repo.split('/')[0];
      const prs = await this.hub.gh.get<{ html_url: string }[]>(
        `/repos/${s.code_repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${s.branch}`)}`,
      );
      return prs[0]?.html_url ?? null;
    } catch {
      return null;
    }
  }
}

export function stripSha(l: Lock): LockPayload {
  const { sha: _sha, ...rest } = l;
  return rest;
}
