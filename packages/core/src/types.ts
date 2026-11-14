/** 任務狀態機：
 *
 *  pending ──(依賴全部 done)──▶ ready ──claim──▶ claimed ──submit──▶ in_review ──approve──▶ done
 *                               ▲  ▲               │  │                 │
 *                               │  └─租約超時/釋放─┘  └─report_blocked─▶ blocked
 *                               │                                       │
 *                               └────────────unblock────────────────────┘
 *                                        changes_requested ◀──reject──(in_review)
 *                                        changes_requested ──claim──▶ claimed
 */
export type TaskState =
  | 'pending'
  | 'ready'
  | 'claimed'
  | 'in_review'
  | 'changes_requested'
  | 'blocked'
  | 'done';

export const TASK_STATES: TaskState[] = [
  'pending',
  'ready',
  'claimed',
  'in_review',
  'changes_requested',
  'blocked',
  'done',
];

export type ProjectKind = 'dev' | 'chore';
export type ProjectStatus = 'active' | 'delivered' | 'archived';

export interface Project {
  id: string;
  title: string;
  description: string;
  kind: ProjectKind;
  status: ProjectStatus;
  created_at: number;
  delivered_at: number | null;
}

export interface TaskResult {
  summary: string;
  /** 研發類任務的交付物是一個 PR，這裡只存鏈接 */
  pr_url?: string;
  submitted_by: string;
  submitted_at: number;
}

export interface Review {
  reviewer: string;
  decision: 'approve' | 'reject';
  comment: string;
  at: number;
}

export interface Task {
  id: string;
  project_id: string;
  /** 項目內的短名，拆解時用來互相引用依賴 */
  key: string;
  title: string;
  description: string;
  /** 驗收標準 */
  acceptance: string;
  /** 需要的能力標籤，worker 的標籤必須全部包含才可領取 */
  labels: string[];
  /** 依賴的任務 id */
  deps: string[];
  state: TaskState;
  assignee: string | null;
  last_assignee: string | null;
  lease_expires_at: number | null;
  /** 被領取過幾次 */
  attempt: number;
  result: TaskResult | null;
  reviews: Review[];
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface Worker {
  id: string;
  name: string;
  /** 所在電腦，例如「家用電腦」 */
  machine: string;
  labels: string[];
  status: 'online' | 'offline';
  current_task: string | null;
  last_seen: number;
  registered_at: number;
}

export type EventType =
  | 'project_created'
  | 'project_delivered'
  | 'project_archived'
  | 'task_ready'
  | 'task_claimed'
  | 'task_submitted'
  | 'task_released'
  | 'task_blocked'
  | 'task_unblocked'
  | 'review_approved'
  | 'review_rejected'
  | 'lease_expired'
  | 'worker_registered'
  | 'worker_online'
  | 'worker_offline'
  | 'heartbeat';

/** 每個事件都帶上變更後的快照，前端只需按 id 覆蓋即可，也能據此回放 */
export interface PmEvent {
  /** 遞增序號；heartbeat 這類不落庫的事件為 0 */
  id: number;
  ts: number;
  type: EventType;
  message: string;
  project_id?: string;
  task_id?: string;
  worker_id?: string;
  project?: Project;
  task?: Task;
  tasks?: Task[];
  worker?: Worker;
}

export interface TaskInput {
  key: string;
  title: string;
  description?: string;
  acceptance?: string;
  labels?: string[];
  /** 依賴的任務 key */
  deps?: string[];
}

export interface ProjectInput {
  title: string;
  description?: string;
  kind?: ProjectKind;
  tasks: TaskInput[];
}

export interface WorkerInput {
  id: string;
  name?: string;
  machine?: string;
  labels?: string[];
}

export interface Snapshot {
  server_time: number;
  lease_ms: number;
  projects: Project[];
  tasks: Task[];
  workers: Worker[];
  last_event_id: number;
}

export class PmError extends Error {
  constructor(
    public code: 'not_found' | 'conflict' | 'invalid' | 'lease_lost' | 'forbidden',
    message: string,
  ) {
    super(message);
    this.name = 'PmError';
  }
}
