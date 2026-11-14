import { useEffect, useState } from 'react';
import { TASK_STATES, type Task, type TaskState } from '@agent-pm/core';
import { backend } from '../backend.ts';
import { sortedProjects, useStore, useWorld, type World } from '../store.ts';
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
            </button>
          );
        })}
      </nav>

      <div className="right">
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
        <span className={`mode ${mode}`}>
          <i />
          {mode === 'live' ? '實時連線' : mode === 'demo' ? '瀏覽器內模擬' : '連線中…'}
        </span>
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
  const shown = (replayIdx === null ? events : events.slice(0, replayIdx)).slice(-7).reverse();
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
  const history = (replayIdx === null ? events : events.slice(0, replayIdx)).filter((e) => e.task_id === task.id).slice(-8);
  const replaying = replayIdx !== null;

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
        {project?.title} · <code>{task.key}</code>
      </p>

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

      {!replaying && task.state === 'in_review' && (
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
      {!replaying && task.state === 'blocked' && (
        <div className="actions">
          <button className="approve" disabled={busy} onClick={() => act(() => backend.api!.unblock(task.id, '你'))}>
            解除阻塞，放回任務池
          </button>
        </div>
      )}
      {error && <p className="warn">{error}</p>}

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
                {p.kind === 'dev' ? '研發項目' : '日常雜事'} · {p.status === 'delivered' ? 'PM 已交付' : `${pr.done}/${pr.total} 完成`}
              </span>
            </h2>
            <p className="muted">{p.description}</p>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>任務</th>
                    <th>狀態</th>
                    <th>能力標籤</th>
                    <th>執行者</th>
                    <th>依賴</th>
                    <th className="num">領取次數</th>
                    <th>交付</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
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
                <span className="muted">{w.machine}</span>
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
                    : '閒置，等待任務'}
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
