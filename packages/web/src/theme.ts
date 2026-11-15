import type { EventType, TaskState } from '@agent-pm/core';

export const STATE_META: Record<TaskState, { label: string; color: string }> = {
  pending: { label: '等待依賴', color: '#5d6a86' },
  ready: { label: '可領取', color: '#3b9dff' },
  claimed: { label: '執行中', color: '#f7c948' },
  in_review: { label: '待 review', color: '#b57bff' },
  changes_requested: { label: '退回修改', color: '#ff9d4d' },
  blocked: { label: '受阻', color: '#ff5468' },
  done: { label: '已完成', color: '#3ddc97' },
};

/** Worker 的強調色，刻意避開狀態色 */
export const WORKER_COLORS = ['#22d3ee', '#f472b6', '#bef264', '#ffffff', '#5eead4', '#fda4af', '#93c5fd'];

export const PM_COLOR = '#ffd98a';

export const EVENT_COLOR: Partial<Record<EventType, string>> = {
  project_created: PM_COLOR,
  project_delivered: PM_COLOR,
  task_ready: STATE_META.ready.color,
  task_claimed: STATE_META.claimed.color,
  task_resumed: '#ffffff',
  task_released: STATE_META.changes_requested.color,
  task_checkpoint: '#5d6a86',
  task_submitted: STATE_META.in_review.color,
  review_approved: STATE_META.done.color,
  review_rejected: STATE_META.changes_requested.color,
  task_blocked: STATE_META.blocked.color,
  lease_expired: STATE_META.blocked.color,
  worker_offline: STATE_META.pending.color,
};

export const CANVAS_FONT =
  '"PingFang TC","Noto Sans TC","Microsoft JhengHei","WenQuanYi Zen Hei",system-ui,sans-serif';

export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('zh-Hant', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
