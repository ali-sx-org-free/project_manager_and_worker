import { useEffect, useState } from 'react';
import {
  INTERRUPT_LABEL,
  PRIORITY_LABEL,
  ROLE_LABEL,
  TASK_STATES,
  type Project,
  type Task,
  type TaskState,
} from '@agent-pm/core';
import { backend } from '../backend.ts';
import { sortedProjects, useRole, useStore, useWorld, type World } from '../store.ts';
import { EVENT_COLOR, STATE_META, WORKER_COLORS, fmtTime } from '../theme.ts';

export function StatePill({ state }: { state: TaskState }) {
  const m = STATE_META[state];
  return (
    <span className="pill" style={{ '--c': m.color } as React.CSSProperties}>
      <i />
      {m.label}
    </span>
  );
}

function progress(world: World, projectId?: string) {
  const tasks = Object.values(world.tasks).filter((t) => !projectId || t.project_id === projectId);
  return { done: tasks.filter((t) => t.state === 'done').length, total: tasks.length };
}

// ───────────────────────── 頂欄 ─────────────────────────

export function TopBar() {
  const world = useWorld();
  const mode = useStore((s) => s.mode);
  const view = useStore((s) => s.view);
  const focus = useStore((s) => s.focus);
  const set = useStore((s) => s.set);
  const [speed, setSpeed] = useState(1);
  const projects = sortedProjects(world);
  const all = progress(world);
  const me = useStore((s) => s.me);
  // 管理員（或服務沒啟用鑒權時）可以換成別人的視角，看看對方看得到什麼
  const canSwitch = !!me && (me.user.admin || !!me.acting_for);
  const others = useStore((s) => s.roster).filter((u) => !u.admin);
  const hub = useStore((s) => s.hub);
  const hubOpen = useStore((s) => s.hubOpen);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden="true" />
        <div>
          <strong>Agent PM</strong>
          <small>多 agent 項目管理 · 原型</small>
        </div>
      </div>

      <nav className="tabs" aria-label="項目">
        <button className={focus === 'all' ? 'on' : ''} onClick={() => set({ focus: 'all' })}>
          全部
          <em>
            {all.done}/{all.total}
          </em>
        </button>
        {projects.map((p) => {
          const pr = progress(world, p.id);
          return (
            <button key={p.id} className={focus === p.id ? 'on' : ''} onClick={() => set({ focus: p.id })}>
              <i style={{ background: p.kind === 'dev' ? '#3b9dff' : '#3ddc97' }} />
              {p.title}
              <em>{p.status === 'delivered' ? '已交付' : `${pr.done}/${pr.total}`}</em>
              <em className={`prio p${p.priority}`} title={`優先級 ${p.priority}`}>
                {PRIORITY_LABEL[p.priority] ?? p.priority}
              </em>
            </button>
          );
        })}
      </nav>

      <div className="right">
        {me &&
          (canSwitch && others.length > 0 ? (
            <label className="ident" title="換成別人的視角：只看得到他參與的項目">
              檢視身分
              <select value={me.acting_for ? me.user.id : ''} onChange={(e) => backend.viewAs(e.target.value || null)}>
                <option value="">{me.acting_for?.name ?? me.user.name}（全部項目）</option>
                {others.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            me.auth && <span className="ident">{me.user.name}</span>
          ))}
        {mode === 'demo' && (
          <button
            className="ghost"
            title="模擬速度"
            onClick={() => {
              const next = speed >= 4 ? 1 : speed * 2;
              setSpeed(next);
              if (backend.sim) backend.sim.speed = next;
            }}
          >
            速度 ×{speed}
          </button>
        )}
        {hub && mode === 'live' ? (
          <button className={`mode live hubbtn ${hub.error ? 'err' : ''}`} onClick={() => set({ hubOpen: !hubOpen })} title="hub 狀態、鎖和 Worker 名冊">
            <i />
            GitHub · {hub.name}
          </button>
        ) : (
          <span className={`mode ${mode}`}>
            <i />
            {mode === 'live' ? '實時連線' : mode === 'demo' ? '瀏覽器內模擬' : mode === 'denied' ? 'token 無效' : '連線中…'}
          </span>
        )}
        <div className="seg" role="tablist" aria-label="視圖">
          <button className={view === '3d' ? 'on' : ''} onClick={() => set({ view: '3d' })}>
            3D
          </button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => set({ view: 'list' })}>
            列表
          </button>
        </div>
      </div>
    </header>
  );
}

// ───────────────────────── 圖例 ─────────────────────────

export function Legend() {
  const world = useWorld();
  const focus = useStore((s) => s.focus);
  const tasks = Object.values(world.tasks).filter((t) => focus === 'all' || t.project_id === focus);
  return (
    <div className="legend">
      {TASK_STATES.map((s) => (
        <span key={s} style={{ '--c': STATE_META[s].color } as React.CSSProperties}>
          <i />
          {STATE_META[s].label}
          <b>{tasks.filter((t) => t.state === s).length}</b>
        </span>
      ))}
    </div>
  );
}

// ───────────────────────── 動態 ─────────────────────────

export function Feed() {
  const events = useStore((s) => s.events);
  const replayIdx = useStore((s) => s.replayIdx);
  const set = useStore((s) => s.set);
  // 檢查點很頻繁，放進動態會把別的事件沖掉；它們在任務側欄的「接力記錄」裡
  const shown = (replayIdx === null ? events : events.slice(0, replayIdx))
    .filter((e) => e.type !== 'task_checkpoint' && e.message)
    .slice(-7)
    .reverse();
  return (
    <aside className="feed" aria-label="動態">
      <h3>動態</h3>
      {shown.length === 0 && <p className="muted">等待第一個事件…</p>}
      <ul>
        {shown.map((e) => (
          <li key={e.id}>
            <i style={{ background: EVENT_COLOR[e.type] ?? '#8b98b5' }} />
            <time>{fmtTime(e.ts)}</time>
            {e.task_id ? (
              <button className="link" onClick={() => set({ selected: e.task_id })}>
                {e.message}
              </button>
            ) : (
              <span>{e.message}</span>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ───────────────────────── 時間軸回放 ─────────────────────────

export function Timeline() {
  const events = useStore((s) => s.events);
  const replayIdx = useStore((s) => s.replayIdx);
  const set = useStore((s) => s.set);
  const value = replayIdx ?? events.length;
  const at = value > 0 ? events[Math.min(value, events.length) - 1] : undefined;
  return (
    <div className="timeline">
      <label htmlFor="replay">回放</label>
      <input
        id="replay"
        type="range"
        min={0}
        max={events.length}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          set({ replayIdx: v >= events.length ? null : v });
        }}
      />
      <span className="when">
        {replayIdx === null ? '實時' : at ? `${fmtTime(at.ts)} · 第 ${value}/${events.length} 個事件` : '起點'}
      </span>
      {replayIdx !== null && (
        <button className="ghost" onClick={() => set({ replayIdx: null })}>
          回到實時
        </button>
      )}
    </div>
  );
}

// ───────────────────────── 任務側邊欄 ─────────────────────────

function LeaseCountdown({ task }: { task: Task }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  if (!task.lease_expires_at) return null;
  const left = Math.max(0, Math.round((task.lease_expires_at - Date.now()) / 1000));
  return <span className="muted">租約剩 {left} 秒（心跳會續約）</span>;
}

export function SidePanel() {
  const world = useWorld();
  const selected = useStore((s) => s.selected);
  const events = useStore((s) => s.events);
  const replayIdx = useStore((s) => s.replayIdx);
  const set = useStore((s) => s.set);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const role = useRole(selected ? world.tasks[selected]?.project_id : undefined);

  useEffect(() => {
    setComment('');
    setError('');
  }, [selected]);

  const task = selected ? world.tasks[selected] : undefined;
  if (!task) return null;
  const project = world.projects[task.project_id];
  const workers = Object.values(world.workers).sort((a, b) => a.registered_at - b.registered_at || a.id.localeCompare(b.id));
  const who = (id: string | null | undefined) => {
    const i = workers.findIndex((w) => w.id === id);
    if (i < 0) return id ?? '—';
    return (
      <span className="who">
        <i style={{ background: WORKER_COLORS[i % WORKER_COLORS.length] }} />
        {workers[i].name} · {workers[i].machine}
      </span>
    );
  };
  const history = (replayIdx === null ? events : events.slice(0, replayIdx))
    .filter((e) => e.task_id === task.id && e.type !== 'task_checkpoint')
    .slice(-8);
  const name = (id: string) => workers.find((w) => w.id === id)?.name ?? id;
  const dot = (id: string) => {
    const i = workers.findIndex((w) => w.id === id);
    return i < 0 ? '#8b98b5' : WORKER_COLORS[i % WORKER_COLORS.length];
  };
  const hands = new Set(task.worklog.map((e) => e.worker_id)).size;
  const replaying = replayIdx !== null;
  const canManage = role === 'manager';

  const act = async (fn: () => Promise<unknown>) => {
    if (!backend.api) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      setComment('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="side" aria-label="任務詳情">
      <header>
        <StatePill state={task.state} />
        <button className="close" aria-label="關閉" onClick={() => set({ selected: null })}>
          ×
        </button>
      </header>
      <h2>{task.title}</h2>
      <p className="muted">
        {project?.title} · <code>{task.project_key}/{task.key}</code>
        {(task as Task & { url?: string }).url && (
          <>
            {' · '}
            <a href={(task as Task & { url?: string }).url} target="_blank" rel="noreferrer">
              在 GitHub 上打開 #{task.id}
            </a>
          </>
        )}
      </p>
      {(task as Task & { human_review?: boolean }).human_review && <p className="warn">這個任務必須由人批准（review:human）</p>}

      <dl>
        <dt>描述</dt>
        <dd>{task.description || '—'}</dd>
        <dt>驗收標準</dt>
        <dd>{task.acceptance || '—'}</dd>
        <dt>需要的能力</dt>
        <dd className="chips">
          {task.labels.length ? task.labels.map((l) => <span key={l}>{l}</span>) : '不限'}
        </dd>
        <dt>依賴</dt>
        <dd className="deps">
          {task.deps.length
            ? task.deps.map((d) => (
                <button key={d} className="link" onClick={() => set({ selected: d })}>
                  <i style={{ background: STATE_META[world.tasks[d]?.state ?? 'pending'].color }} />
                  {world.tasks[d]?.title ?? d}
                </button>
              ))
            : '無，可直接開始'}
        </dd>
        <dt>執行者</dt>
        <dd>
          {task.assignee ? who(task.assignee) : task.last_assignee ? <>上一位：{who(task.last_assignee)}</> : '尚未領取'}
          {task.attempt > 0 && <span className="muted"> · 第 {task.attempt} 次領取</span>}
          {task.state === 'claimed' && !replaying && (
            <div>
              <LeaseCountdown task={task} />
            </div>
          )}
        </dd>
        {(task.progress > 0 || task.worklog.length > 0) && (
          <>
            <dt>進度</dt>
            <dd>
              <div className="progress" role="progressbar" aria-valuenow={task.progress} aria-valuemin={0} aria-valuemax={100}>
                <i style={{ width: `${task.progress}%` }} />
              </div>
              <span className="muted">
                {task.progress}% · 分支 <code>{task.branch}</code>
              </span>
            </dd>
          </>
        )}
        {task.blocked_reason && (
          <>
            <dt>受阻原因</dt>
            <dd className="warn">{task.blocked_reason}</dd>
          </>
        )}
        {task.result && (
          <>
            <dt>交付</dt>
            <dd>
              {task.result.summary}
              {task.result.pr_url && (
                <div>
                  <a href={task.result.pr_url} target="_blank" rel="noreferrer">
                    {task.result.pr_url.replace('https://github.com/', '')}
                  </a>
                </div>
              )}
            </dd>
          </>
        )}
        {task.reviews.length > 0 && (
          <>
            <dt>Review 記錄</dt>
            <dd>
              <ul className="reviews">
                {task.reviews.map((r, i) => (
                  <li key={i} className={r.decision}>
                    <b>{r.decision === 'approve' ? '通過' : '退回'}</b> {r.reviewer} · {fmtTime(r.at)}
                    {r.comment && <p>{r.comment}</p>}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>

      {!replaying && !canManage && (task.state === 'in_review' || task.state === 'blocked') && (
        <p className="muted">
          你在這個項目裡是{role ? ROLE_LABEL[role] : '訪客'}，只有負責人可以{task.state === 'blocked' ? '解除阻塞' : ' review'}。
        </p>
      )}
      {!replaying && canManage && task.state === 'in_review' && (
        <div className="actions">
          <textarea
            id="review-comment"
            placeholder="review 意見（退回時 worker 會看到）"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
          />
          <div className="row">
            <button
              className="approve"
              disabled={busy}
              onClick={() => act(() => backend.api!.review(task.id, { reviewer: '你', decision: 'approve', comment }))}
            >
              批准
            </button>
            <button
              className="reject"
              disabled={busy}
              onClick={() => act(() => backend.api!.review(task.id, { reviewer: '你', decision: 'reject', comment }))}
            >
              退回
            </button>
          </div>
        </div>
      )}
      {!replaying && canManage && task.state === 'blocked' && (
        <div className="actions">
          <button className="approve" disabled={busy} onClick={() => act(() => backend.api!.unblock(task.id, '你'))}>
            解除阻塞，放回任務池
          </button>
        </div>
      )}
      {error && <p className="warn">{error}</p>}

      {task.worklog.length > 0 && (
        <>
          <h3>接力記錄{hands > 1 ? ` · 經過 ${hands} 個 worker` : ''}</h3>
          <ol className="worklog">
            {task.worklog.map((e) => (
              <li key={e.seq} className={e.kind}>
                <i style={{ background: dot(e.worker_id) }} />
                <div>
                  <b>
                    {name(e.worker_id)}
                    {e.kind === 'checkpoint'
                      ? ` · ${e.auto ? '自動檢查點' : '檢查點'}${e.progress !== undefined ? ` ${e.progress}%` : ''}`
                      : ` · 中斷：${INTERRUPT_LABEL[e.reason ?? 'released']}`}
                  </b>
                  <time>{fmtTime(e.at)}</time>
                  <p>{e.summary}</p>
                  {e.next_steps && <p className="muted">接下來：{e.next_steps}</p>}
                  {e.commit && (
                    <p className="muted">
                      commit <code>{e.commit}</code>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}

      <h3>這個任務的經過</h3>
      <ul className="history">
        {history.length === 0 && <li className="muted">還沒有事件</li>}
        {history.map((e) => (
          <li key={e.id}>
            <i style={{ background: EVENT_COLOR[e.type] ?? '#8b98b5' }} />
            <time>{fmtTime(e.ts)}</time>
            <span>{e.message}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ───────────────────────── 項目設定：優先級、並行配額、成員 ─────────────────────────

const running = (world: World, projectId: string) =>
  Object.values(world.tasks).filter((t) => t.project_id === projectId && t.state === 'claimed').length;

/** 負責人可以在這裡調優先級和並行配額，立刻生效；其他人只能看。 */
function ProjectSettings({ project: p, running }: { project: Project; running: number }) {
  const role = useRole(p.id);
  const members = useStore((s) => s.members).filter((m) => m.project_id === p.id);
  const users = useStore((s) => s.users);
  const replaying = useStore((s) => s.replayIdx !== null);
  const [error, setError] = useState('');
  const can = role === 'manager' && !replaying && p.status === 'active';
  const patch = (body: { priority?: number; max_parallel?: number | null }) => {
    setError('');
    backend.api?.updateProject(p.id, body).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  const full = p.max_parallel !== null && running >= p.max_parallel;
  return (
    <div className="psettings">
      <label>
        優先級
        <select value={p.priority} disabled={!can} onChange={(e) => patch({ priority: Number(e.target.value) })}>
          {[5, 4, 3, 2, 1].map((n) => (
            <option key={n} value={n}>
              {n} · {PRIORITY_LABEL[n]}
            </option>
          ))}
        </select>
      </label>
      <label>
        並行配額
        <select
          value={p.max_parallel ?? ''}
          disabled={!can}
          onChange={(e) => patch({ max_parallel: e.target.value === '' ? null : Number(e.target.value) })}
        >
          <option value="">不限</option>
          <option value="0">0 · 暫停派工</option>
          {[1, 2, 3, 4, 5, 6, 8].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span className={full ? 'full' : 'muted'}>
        執行中 {running}
        {p.max_parallel !== null ? `/${p.max_parallel}` : ''}
        {full && p.max_parallel !== 0 ? ' · 配額已滿' : ''}
      </span>
      <span className="members">
        成員：
        {members.length === 0 && <em>只有管理員</em>}
        {members.map((m) => (
          <em key={m.user_id}>
            {users[m.user_id]?.name ?? m.user_id} <small>{ROLE_LABEL[m.role]}</small>
          </em>
        ))}
      </span>
      {role && role !== 'manager' && <span className="muted">你是{ROLE_LABEL[role]}，不能改設定</span>}
      {error && <span className="warn">{error}</span>}
    </div>
  );
}

// ───────────────────────── 2D 列表視圖 ─────────────────────────

export function ListView() {
  const world = useWorld();
  const focus = useStore((s) => s.focus);
  const selected = useStore((s) => s.selected);
  const set = useStore((s) => s.set);
  const [filter, setFilter] = useState<TaskState | 'all'>('all');
  const projects = sortedProjects(world).filter((p) => focus === 'all' || p.id === focus);
  const workers = Object.values(world.workers).sort((a, b) => a.registered_at - b.registered_at || a.id.localeCompare(b.id));
  const name = (id: string | null) => workers.find((w) => w.id === id)?.name ?? id ?? '';
  const users = useStore((s) => s.users);

  return (
    <main className="list">
      <div className="filters" role="group" aria-label="按狀態篩選">
        <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
          全部狀態
        </button>
        {TASK_STATES.map((s) => (
          <button
            key={s}
            className={filter === s ? 'on' : ''}
            style={{ '--c': STATE_META[s].color } as React.CSSProperties}
            onClick={() => setFilter(s)}
          >
            <i />
            {STATE_META[s].label}
          </button>
        ))}
      </div>

      {projects.map((p) => {
        const tasks = Object.values(world.tasks).filter(
          (t) => t.project_id === p.id && (filter === 'all' || t.state === filter),
        );
        const pr = progress(world, p.id);
        return (
          <section key={p.id}>
            <h2>
              {p.title}
              <span className="muted">
                <code>{p.key}</code> · {p.kind === 'dev' ? '研發項目' : '日常雜事'} ·{' '}
                {p.status === 'delivered' ? 'PM 已交付' : `${pr.done}/${pr.total} 完成`}
              </span>
            </h2>
            <p className="muted">{p.description}</p>
            <ProjectSettings project={p} running={running(world, p.id)} />
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>任務</th>
                    <th>狀態</th>
                    <th>能力標籤</th>
                    <th>執行者</th>
                    <th className="num">進度</th>
                    <th>依賴</th>
                    <th className="num">領取次數</th>
                    <th>交付</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.length === 0 && (
                    <tr>
                      <td colSpan={8} className="muted">
                        沒有符合篩選的任務
                      </td>
                    </tr>
                  )}
                  {tasks.map((t) => (
                    <tr key={t.id} className={selected === t.id ? 'sel' : ''} onClick={() => set({ selected: t.id })}>
                      <td>
                        <button className="link strong">{t.title}</button>
                      </td>
                      <td>
                        <StatePill state={t.state} />
                      </td>
                      <td>
                        <div className="chips">
                          {t.labels.map((l) => (
                            <span key={l}>{l}</span>
                          ))}
                        </div>
                      </td>
                      <td>{name(t.assignee ?? t.result?.submitted_by ?? null) || '—'}</td>
                      <td className="num">{t.progress > 0 ? `${t.progress}%` : '—'}</td>
                      <td className="muted">{t.deps.map((d) => world.tasks[d]?.title ?? d).join('、') || '—'}</td>
                      <td className="num">{t.attempt}</td>
                      <td>
                        {t.result?.pr_url ? (
                          <a href={t.result.pr_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                            PR #{t.result.pr_url.split('/').pop()}
                          </a>
                        ) : t.result ? (
                          '已回報'
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <section>
        <h2>
          Worker
          <span className="muted">{workers.filter((w) => w.status === 'online').length}/{workers.length} 在線</span>
        </h2>
        <div className="workers">
          {workers.map((w, i) => (
            <article key={w.id} className={w.status}>
              <header>
                <i style={{ background: WORKER_COLORS[i % WORKER_COLORS.length] }} />
                <strong>{w.name}</strong>
                <span className="muted">
                  {w.machine}
                  {w.owner && users[w.owner] ? ` · ${users[w.owner].name} 的` : ''}
                </span>
              </header>
              <div className="chips">
                {w.labels.map((l) => (
                  <span key={l}>{l}</span>
                ))}
              </div>
              <p>
                {w.status === 'offline'
                  ? '離線（心跳中斷）'
                  : w.current_task
                    ? `執行中：${world.tasks[w.current_task]?.title ?? w.current_task}`
                    : w.busy_elsewhere
                      ? '忙於你看不到的項目'
                      : '閒置，等待任務'}
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

// ───────────────────────── GitHub hub：同步狀態、鎖、名冊（只有連本機管理端時有） ─────────────────────────

const ago = (t: number | null) => {
  if (!t) return '還沒同步';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s} 秒前` : `${Math.round(s / 60)} 分鐘前`;
};

export function HubPanel() {
  const hub = useStore((s) => s.hub);
  const open = useStore((s) => s.hubOpen);
  const set = useStore((s) => s.set);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!hub || !open) return null;
  const run = async (label: string, path: string, body?: unknown, done?: (r: unknown) => string) => {
    setBusy(label);
    setNote('');
    try {
      const r = await backend.hub(path, body);
      setNote(done ? done(r) : `${label}：完成`);
    } catch (err) {
      setNote(`${label}失敗：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy('');
    }
  };
  const live = hub.locks.filter((l) => l.status === 'held' && l.task_open);
  const stale = hub.locks.filter((l) => !l.task_open).length;
  return (
    <aside className="side hubpanel" aria-label="GitHub hub">
      <header>
        <strong>GitHub hub</strong>
        <button className="close" aria-label="關閉" onClick={() => set({ hubOpen: false })}>
          ×
        </button>
      </header>
      <h2>
        <a href={hub.url} target="_blank" rel="noreferrer">
          {hub.name}
        </a>
      </h2>
      <p className="muted">
        以 <b>{hub.me}</b> 的身分{hub.admin ? '（hub 管理員）' : ''} · 每 {Math.round(hub.poll_ms / 1000)} 秒同步 · 上次 {ago(hub.last_sync)}
        {hub.syncing ? ' · 同步中…' : ''}
      </p>
      {hub.private === false && <p className="warn">hub 是公開倉庫！任務正文會被 agent 當作指令執行，請改成 Private。</p>}
      {hub.error && <p className="warn">同步失敗：{hub.error}</p>}
      <dl>
        <dt>內容</dt>
        <dd>
          {hub.counts.projects} 個項目 · {hub.counts.tasks} 個任務 · {hub.counts.comments} 條接力記錄 · 租約 {hub.lease_minutes} 分鐘
        </dd>
        <dt>API 額度</dt>
        <dd>
          {hub.rate ? `本小時還剩 ${hub.rate.remaining} / ${hub.rate.limit}` : '—'}
          <span className="muted">
            {' '}
            · 已發 {hub.requests.total} 個請求，其中 {hub.requests.not_modified} 個沒變化（不算額度）
          </span>
        </dd>
      </dl>
      <div className="actions row">
        <button className="ghost" disabled={!!busy} onClick={() => run('同步', '/api/hub/sync')}>
          立即同步
        </button>
        <button
          className="ghost"
          disabled={!!busy}
          title="讓 status 標籤跟上鎖，補上在 GitHub 網頁上做的 PR review"
          onClick={() => run('對齊', '/api/hub/reconcile', {}, (r) => `對齊：${(r as { changes: unknown[] }).changes.length} 處修正`)}
        >
          對齊標籤
        </button>
        {hub.admin && (
          <button
            className="ghost"
            disabled={!!busy || !stale}
            title="刪掉已關閉任務的鎖分支"
            onClick={() => run('清理', '/api/hub/prune', {}, (r) => `清理：刪了 ${(r as { removed: unknown[] }).removed.length} 條鎖`)}
          >
            清理 {stale} 條舊鎖
          </button>
        )}
      </div>
      {note && <p className="muted">{note}</p>}

      <h3>正在執行（{live.length}）</h3>
      <ul className="history">
        {live.length === 0 && <li className="muted">沒有</li>}
        {live.map((l) => (
          <li key={l.task}>
            <i style={{ background: l.alive ? '#3ddc97' : '#ff5468' }} />
            <span>
              #{l.task} {l.title} · {l.worker}（{l.owner}）第 {l.attempt} 次 ·{' '}
              {l.alive && l.expires_at ? `租約剩 ${Math.max(0, Math.round((l.expires_at - Date.now()) / 1000))} 秒` : '已過期，等人接手'}
              {' '}
              <button
                className="link"
                disabled={!!busy}
                onClick={() => run('收回', `/api/tasks/${l.task}/revoke`, { note: '管理端收回' }, () => `已收回 #${l.task}`)}
              >
                收回
              </button>
            </span>
          </li>
        ))}
      </ul>

      <h3>Worker 名冊（{hub.roster.length}）</h3>
      <ul className="history">
        {hub.roster.length === 0 && <li className="muted">還沒有 worker 加入</li>}
        {hub.roster.map((w) => (
          <li key={w.id}>
            <i style={{ background: w.status === 'left' ? '#8b98b5' : w.current_task ? '#ffd98a' : '#3ddc97' }} />
            <span>
              <b>{w.id}</b> · {w.owner} · {w.labels.join('、') || '無能力標籤'} · {w.status === 'left' ? '已離開' : w.current_task ? `在做 #${w.current_task}` : '閒置'} ·
              最後出現 {ago(w.seen)}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
