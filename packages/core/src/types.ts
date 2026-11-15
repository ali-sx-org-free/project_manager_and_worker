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

/** 項目內的角色：manager 可以改設定、管成員、review；contributor 的 worker 可以領任務；viewer 只能看 */
export type ProjectRole = 'manager' | 'contributor' | 'viewer';
export const ROLE_LABEL: Record<ProjectRole, string> = { manager: '負責人', contributor: '參與者', viewer: '觀察者' };

/** 一個人（或一個 PM agent）的身分。admin 能看到並管理所有項目。 */
export interface User {
  id: string;
  name: string;
  admin: boolean;
  created_at: number;
}

export interface Member {
  project_id: string;
  user_id: string;
  role: ProjectRole;
}

export const PRIORITY_LABEL: Record<number, string> = { 1: '最低', 2: '低', 3: '普通', 4: '高', 5: '緊急' };

export interface Project {
  id: string;
  /** 項目短名，只含小寫字母、數字和連字號。所有項目共用一個倉庫，分支名和 commit 靠它區分項目 */
  key: string;
  /** 1 到 5，越大越優先。worker 有多個項目的任務可領時，先領優先級高的 */
  priority: number;
  /** 並行配額：這個項目同時最多有幾個任務在執行。null 不限，0 等於暫停派工 */
  max_parallel: number | null;
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
  /** 所屬項目的短名（冗餘一份，方便 worker 和 agent 直接看到） */
  project_key: string;
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
  /** 這個任務專用的 git 分支，格式 project/<項目短名>/<任務 key>-<編號>。中間成果推到這裡，換人也是同一個分支 */
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
  /** 這個 worker 屬於誰。它只能領「主人有權參與」的項目的任務；null 表示不設限（未啟用鑒權時） */
  owner: string | null;
  /** 可選：只為這些項目（短名）幹活。null 表示主人能參與的都可以 */
  projects: string[] | null;
  status: 'online' | 'offline';
  /** 只出現在按身分過濾後的視圖裡：worker 正忙於一個你看不到的項目 */
  busy_elsewhere?: boolean;
  current_task: string | null;
  last_seen: number;
  registered_at: number;
}

export type EventType =
  | 'project_created'
  | 'project_delivered'
  | 'project_archived'
  | 'project_updated'
  | 'member_changed'
  | 'worker_updated'
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
  /** member_changed / project_created：這個項目變更後的全部成員 */
  members?: Member[];
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
  /** 項目短名，不給就自動生成 */
  key?: string;
  priority?: number;
  max_parallel?: number | null;
  members?: { user_id: string; role: ProjectRole }[];
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
  owner?: string | null;
  projects?: string[] | null;
}

export interface ProjectPatch {
  priority?: number;
  max_parallel?: number | null;
}

export interface UserInput {
  id?: string;
  name: string;
  admin?: boolean;
}

/** 「我是誰」：auth 為 false 表示服務沒有啟用鑒權，所有人都是管理員 */
export interface Me {
  user: User;
  auth: boolean;
  /** 管理員（或未啟用鑒權時）以別人的身分檢視時，這是原本的身分 */
  acting_for?: User;
}

export interface Snapshot {
  server_time: number;
  lease_ms: number;
  projects: Project[];
  tasks: Task[];
  workers: Worker[];
  users: User[];
  members: Member[];
  last_event_id: number;
}

export class PmError extends Error {
  constructor(
    public code: 'not_found' | 'conflict' | 'invalid' | 'lease_lost' | 'forbidden' | 'unauthorized',
    message: string,
  ) {
    super(message);
    this.name = 'PmError';
  }
}
