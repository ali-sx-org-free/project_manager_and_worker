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

/** 任務為什麼從一個 worker 手上離開 */
export type InterruptReason =
  | 'lease_expired' // 心跳中斷（斷網、關機、進程被殺），租約超時後被服務收回
  | 'interrupted' // 人工打斷（例如在 runner 上按 Ctrl+C）
  | 'usage_limit' // agent 用量額度用完
  | 'released' // worker 主動放棄
  | 'blocked' // 受阻，等人解決
  | 'error'; // agent 異常退出

/** 工作日誌的一條記錄。日誌只追加、跟著任務走，不隨租約回收而消失，接手的 worker 靠它續作。 */
export interface WorkLogEntry {
  seq: number;
  kind: 'checkpoint' | 'interrupted';
  worker_id: string;
  /** 第幾次領取期間寫下的 */
  attempt: number;
  at: number;
  /** checkpoint：到目前為止完成了什麼；interrupted：交接說明 */
  summary: string;
  /** 接下來要做什麼（寫給接手的人看） */
  next_steps?: string;
  /** 0 到 100 */
  progress?: number;
  /** 已推送到任務分支的 commit */
  commit?: string;
  /** 其他中間產物的鏈接或路徑 */
  artifacts?: string[];
  reason?: InterruptReason;
  /** runner 定時自動存的檢查點（只有中間成果的 commit 和輸出片段），不是 agent 自己寫的總結 */
  auto?: boolean;
}

/** 領取任務時附帶的續作上下文：有檢查點就從檢查點接著做，而不是從頭開始 */
export interface ResumeContext {
  /** 上一位執行者 */
  from_worker: string | null;
  /** 上一位為什麼停下 */
  reason: InterruptReason | 'changes_requested' | null;
  handoff_note: string | null;
  progress: number;
  /** agent 自己寫的最後一個檢查點（沒有的話退而用 runner 自動存的） */
  summary: string;
  next_steps: string | null;
  /** runner 最後一次自動檢查點記下的 agent 輸出片段 */
  auto_note: string | null;
  branch: string;
  commit: string | null;
  artifacts: string[];
  checkpoints: number;
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
  /** 工作日誌：檢查點和中斷記錄 */
  worklog: WorkLogEntry[];
  /** 最近一個檢查點回報的進度，0 到 100 */
  progress: number;
  /** 這個任務專用的 git 分支。中間成果推到這裡，換人也是同一個分支 */
  branch: string;
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
  | 'task_resumed'
  | 'task_checkpoint'
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
