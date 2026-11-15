import type { PmApi } from './api.ts';
import { buildResume } from './engine.ts';
import type { ProjectInput, Task, TaskInput, UserInput, WorkerInput } from './types.ts';

/** 模擬器：扮演幾台電腦上的 Worker Agent 和一個 PM Agent，只通過 PmApi 與協調服務交互。
 *  同一份代碼既可以連真實服務（HTTP），也可以在瀏覽器裡直接驅動記憶體 Engine。 */

export interface SimOptions {
  /** 時間倍率，2 表示快一倍 */
  speed?: number;
  /** 協調服務的租約時長，用來決定心跳間隔和「當機」要沉默多久 */
  leaseMs: number;
  /** 隨機種子，同一個種子劇情相同 */
  seed?: number;
  /** 所有項目交付後是否自動開始下一輪 */
  loop?: boolean;
  log?: (msg: string) => void;
}

type Fate = 'crash' | 'block' | 'reject' | 'usage_limit' | 'interrupt';

const STEPS = 5;
const STEP_NOTES = ['讀完需求並定下做法', '完成主要部分', '補上邊界情況', '自測並修正問題', '對照驗收標準整理交付'];
type SimTask = TaskInput & { fate?: Fate };

/** 四個人。「你」是管理員，看得到全部項目；其他人只看得到自己參與的項目。 */
export const SIM_USERS: UserInput[] = [
  { id: 'you', name: '你', admin: true },
  { id: 'colleague-a', name: '同事A' },
  { id: 'colleague-b', name: '同事B' },
  { id: 'family', name: '家人' },
];

/** 每個 worker 屬於一個人，只能領主人有權參與的項目的任務 */
export const SIM_WORKERS: WorkerInput[] = [
  { id: 'w-office', name: '阿工', machine: '工作電腦', labels: ['code', 'office-pc'], owner: 'you' },
  { id: 'w-home', name: '小家', machine: '家用電腦', labels: ['code', 'gpu', 'home-pc', 'chore'], owner: 'you' },
  { id: 'w-colleague-a', name: '同事A', machine: '同事A 的筆電', labels: ['code', 'design'], owner: 'colleague-a' },
  { id: 'w-colleague-b', name: '同事B', machine: '同事B 的電腦', labels: ['docs', 'research', 'chore'], owner: 'colleague-b' },
];

const DEV_TASKS: SimTask[] = [
  {
    key: 'spec',
    title: '需求梳理與 API 設計',
    labels: ['docs'],
    description: '整理會員系統的使用者故事，產出 API 契約文件。',
    acceptance: 'API 文件涵蓋註冊、登入、登出、第三方登入；PM 確認範圍。',
  },
  {
    key: 'schema',
    title: '資料庫 schema',
    labels: ['code'],
    deps: ['spec'],
    description: '建立 users、sessions、oauth_accounts 三張表與遷移腳本。',
    acceptance: '遷移可正向與回滾執行；欄位與 API 文件一致。',
  },
  {
    key: 'ui-design',
    title: '登入頁設計稿',
    labels: ['design'],
    deps: ['spec'],
    fate: 'reject',
    description: '登入、註冊、忘記密碼三個畫面的設計稿。',
    acceptance: '提供桌面與手機兩種尺寸；符合品牌色。',
  },
  {
    key: 'avatar-model',
    title: '頭像生成模型微調',
    labels: ['gpu'],
    deps: ['spec'],
    fate: 'block',
    description: '用現有素材微調頭像生成模型，供會員中心使用。',
    acceptance: '產出模型權重與 20 張樣例；單張生成 < 3 秒。',
  },
  {
    key: 'auth-api',
    title: '登入 / 註冊 API',
    labels: ['code'],
    deps: ['schema'],
    fate: 'usage_limit',
    description: '實作 email + 密碼的註冊、登入、登出。',
    acceptance: '單元測試覆蓋成功與失敗路徑；密碼以 argon2 雜湊。',
  },
  {
    key: 'oauth',
    title: '第三方登入（OAuth）',
    labels: ['code'],
    deps: ['schema'],
    fate: 'crash',
    description: '接入 Google 與 GitHub 登入。',
    acceptance: '兩家 provider 皆可完成授權並綁定既有帳號。',
  },
  {
    key: 'login-page',
    title: '前端登入頁',
    labels: ['code'],
    deps: ['ui-design', 'auth-api'],
    description: '依設計稿實作登入與註冊頁並串接 API。',
    acceptance: '表單驗證、錯誤提示、載入狀態齊全。',
  },
  {
    key: 'profile',
    title: '會員中心頁',
    labels: ['code'],
    deps: ['auth-api', 'avatar-model'],
    description: '顯示個人資料並可生成頭像。',
    acceptance: '可修改暱稱與頭像；未登入時導回登入頁。',
  },
  {
    key: 'e2e',
    title: '端到端測試',
    labels: ['code'],
    deps: ['login-page', 'oauth', 'profile'],
    description: '用 Playwright 覆蓋註冊到登出的完整流程。',
    acceptance: 'CI 上全部通過；失敗時保留截圖。',
  },
  {
    key: 'release',
    title: '發布說明與上線',
    labels: ['docs'],
    deps: ['e2e'],
    description: '撰寫發布說明、更新文件並安排上線。',
    acceptance: '發布說明經 PM 確認；回滾步驟寫明。',
  },
];

const PROMO_TASKS: SimTask[] = [
  {
    key: 'banner',
    title: '活動主視覺',
    labels: ['design'],
    description: '週年慶活動的主視覺與配色。',
    acceptance: '桌面與手機各一版；文字可替換。',
  },
  {
    key: 'page',
    title: '活動頁切版',
    labels: ['code'],
    deps: ['banner'],
    description: '依主視覺完成活動頁。',
    acceptance: '手機與桌面版面正確；圖片有壓縮。',
  },
  {
    key: 'form',
    title: '報名表單串接',
    labels: ['code'],
    deps: ['page'],
    description: '報名表單送出後寫入名單並寄確認信。',
    acceptance: '重複報名有提示；確認信內容正確。',
  },
];

const CHORE_TASKS: SimTask[] = [
  {
    key: 'tidy',
    title: '整理下載資料夾',
    labels: ['home-pc'],
    description: '按類型歸檔，刪除 90 天前的安裝包。',
    acceptance: '下載資料夾少於 20 個檔案，附上整理清單。',
  },
  {
    key: 'backup',
    title: '備份照片到 NAS',
    labels: ['home-pc'],
    deps: ['tidy'],
    description: '把本月照片同步到 NAS 並校驗。',
    acceptance: '校驗和一致；回報新增檔案數。',
  },
  {
    key: 'projector',
    title: '調研三款投影機',
    labels: ['research'],
    fate: 'interrupt',
    description: '預算兩萬以內，客廳使用。',
    acceptance: '列出亮度、噪音、價格與購買鏈接。',
  },
  {
    key: 'compare',
    title: '匯總成比較表',
    labels: ['docs'],
    deps: ['projector'],
    description: '把調研結果整理成一頁比較表並給出建議。',
    acceptance: '一頁以內，有明確推薦。',
  },
  {
    key: 'dinner',
    title: '訂週五團隊聚餐',
    labels: ['chore'],
    description: '8 人，晚上 7 點，公司附近。',
    acceptance: '回報餐廳、時間與訂位人。',
  },
  {
    key: 'domain',
    title: '提醒：續費域名',
    labels: ['chore'],
    deps: ['dinner'],
    description: '域名下週到期，建立提醒並確認自動續費。',
    acceptance: '提醒已建立；回報到期日。',
  },
];

const REJECT_COMMENTS = [
  '手機尺寸的間距不對，請對照設計規範調整。',
  '缺少失敗路徑的測試，補上再提交。',
  '驗收標準第二條沒有滿足，請補充。',
];
const APPROVE_COMMENTS = ['符合驗收標準。', '改動清晰，通過。', '測試齊全，可以合併。', '確認完成。'];
const BLOCK_REASONS = ['GPU 驅動版本不符，需要人工確認是否升級。', '缺少第三方服務的 API 金鑰。'];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Simulator {
  private stopped = false;
  private rand: () => number;
  /** 可在運行中調整 */
  speed: number;
  private round = 0;
  private fates = new Map<string, Fate>(); // task id → 這一輪預設的劇情
  private scheduled = new Set<string>();
  private restarting = false;
  private log: (msg: string) => void;

  constructor(
    private api: PmApi,
    private opts: SimOptions,
  ) {
    this.rand = mulberry32(opts.seed ?? 7);
    this.speed = opts.speed ?? 1;
    this.log = opts.log ?? (() => {});
  }

  async start() {
    for (const u of SIM_USERS) await this.api.createUser(u);
    for (const w of SIM_WORKERS) await this.api.registerWorker(w);
    await this.newRound();
    for (const w of SIM_WORKERS) void this.workerLoop(w);
    void this.pmLoop();
  }

  stop() {
    this.stopped = true;
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms / this.speed));
  }
  private between(a: number, b: number) {
    return a + this.rand() * (b - a);
  }
  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rand() * arr.length)];
  }

  private async newRound() {
    this.round++;
    const suffix = this.round > 1 ? `（第 ${this.round} 輪）` : '';
    const inputs: (Omit<ProjectInput, 'tasks'> & { tasks: SimTask[] })[] = [
      {
        // 優先級最高，但最多同時佔用 3 個 worker，留一個給別的項目
        key: 'site',
        priority: 4,
        max_parallel: 3,
        members: [
          { user_id: 'colleague-a', role: 'contributor' },
          { user_id: 'colleague-b', role: 'contributor' },
        ],
        title: `官網會員系統上線${suffix}`,
        kind: 'dev',
        description: '人類的請求：「幫官網加上會員登入，月底前上線。」',
        tasks: DEV_TASKS,
      },
      {
        key: 'home',
        priority: 3,
        max_parallel: 2,
        members: [
          { user_id: 'colleague-b', role: 'contributor' },
          { user_id: 'family', role: 'viewer' },
        ],
        title: `本週日常雜事${suffix}`,
        kind: 'chore',
        description: '人類的請求：「這週的雜事幫我處理一下。」',
        tasks: CHORE_TASKS,
      },
      {
        // 優先級最低：只有別的項目用不完的 worker 才會來做，而且一次只給一個
        key: 'promo',
        priority: 2,
        max_parallel: 1,
        members: [{ user_id: 'colleague-a', role: 'manager' }],
        title: `週年慶活動頁${suffix}`,
        kind: 'dev',
        description: '人類的請求：「週年慶活動頁有空再做，不急。」',
        tasks: PROMO_TASKS,
      },
    ];
    for (const input of inputs) {
      const { project, tasks } = await this.api.createProject({
        ...input,
        tasks: input.tasks.map(({ fate: _fate, ...t }) => t),
      });
      this.log(`PM 建立項目「${project.title}」`);
      for (const t of tasks) {
        const fate = input.tasks.find((s) => s.key === t.key)?.fate;
        if (fate) this.fates.set(t.id, fate);
      }
    }
  }

  private decideFate(task: Task): Fate | 'ok' {
    if (task.attempt === 1) {
      const scripted = this.fates.get(task.id);
      if (scripted && scripted !== 'reject') return scripted;
    }
    const r = this.rand();
    if (task.attempt === 1 && this.round > 1) {
      if (r < 0.05) return 'crash';
      if (r < 0.09) return 'block';
      if (r < 0.13) return 'usage_limit';
      if (r < 0.16) return 'interrupt';
    }
    return 'ok';
  }

  private async workerLoop(w: WorkerInput) {
    await this.sleep(this.between(300, 1500));
    while (!this.stopped) {
      await this.sleep(this.between(900, 2000));
      let task: Task | null = null;
      try {
        task = await this.api.claimTask(w.id);
      } catch {
        try {
          await this.api.registerWorker(w);
        } catch {
          /* 服務暫時不可用，下一輪再試 */
        }
        continue;
      }
      if (!task) continue;

      // 每個任務分成 STEPS 步，每做完一步保存一個檢查點。
      // 接手別人（或自己之前）做到一半的任務時，從最後一個檢查點的下一步開始，而不是從第 1 步重來。
      const resume = buildResume(task);
      const done = resume ? Math.min(STEPS - 1, Math.floor((resume.progress / 100) * STEPS)) : 0;
      this.log(
        resume ? `${w.name} 接手「${task.title}」，從第 ${done + 1}/${STEPS} 步繼續` : `${w.name} 領取「${task.title}」`,
      );
      const isDev = task.labels.includes('code') || task.labels.includes('design');
      const fate = this.decideFate(task);
      // 出狀況的那一步：做到一半左右
      const stopAfter = fate === 'ok' ? STEPS : Math.max(done + 1, fate === 'usage_limit' ? 3 : 2);
      const stepMs = this.between(1000, 2000);
      let lost = false;
      let step = done;
      while (step < stopAfter && !this.stopped) {
        await this.sleep(stepMs);
        step++;
        if (step === STEPS) break; // 最後一步做完直接提交
        try {
          await this.api.saveCheckpoint(w.id, task.id, {
            summary: `完成第 ${step}/${STEPS} 步：${STEP_NOTES[step - 1]}`,
            next_steps: `第 ${step + 1} 步：${STEP_NOTES[step]}`,
            progress: Math.round((step / STEPS) * 100),
            commit: isDev ? Math.floor(this.rand() * 0xfffffff).toString(16).padStart(7, '0') : undefined,
          });
        } catch {
          lost = true; // 租約已經不是我的了，立刻停手
          break;
        }
      }
      if (lost || this.stopped) continue;

      try {
        if (fate === 'crash') {
          // 模擬電腦關機或斷網：不再心跳，等租約過期後才重新上線
          this.log(`${w.name} 的電腦斷線了`);
          await this.sleep(this.opts.leaseMs * this.speed + this.between(3000, 5000));
          await this.api.registerWorker(w);
        } else if (fate === 'block') {
          await this.api.reportBlocked(w.id, task.id, this.pick(BLOCK_REASONS));
          this.log(`${w.name} 回報「${task.title}」受阻`);
        } else if (fate === 'usage_limit') {
          // 額度用完：agent 自己做不下去了，但任務沒問題，立刻交給別人
          await this.api.releaseTask(w.id, task.id, {
            reason: 'usage_limit',
            note: '用量額度用完。中間成果都已推到任務分支，照檢查點的下一步接著做即可。',
          });
          this.log(`${w.name} 額度用完，交出「${task.title}」`);
          await this.sleep(9000);
        } else if (fate === 'interrupt') {
          // 人工打斷：例如電腦的主人按了 Ctrl+C
          await this.api.releaseTask(w.id, task.id, {
            reason: 'interrupted',
            note: '被人工打斷。已保存到最後一個檢查點。',
          });
          this.log(`${w.name} 被打斷，交出「${task.title}」`);
          await this.sleep(7000);
        } else {
          await this.api.submitResult(w.id, task.id, {
            summary: `已完成「${task.title}」，依驗收標準自查通過。`,
            pr_url: isDev ? `https://github.com/example/site/pull/${100 + Math.floor(this.rand() * 900)}` : undefined,
          });
          this.log(`${w.name} 提交「${task.title}」`);
        }
      } catch {
        /* 租約可能剛好過期，忽略 */
      }
    }
  }

  private async pmLoop() {
    while (!this.stopped) {
      await this.sleep(700);
      let snap;
      try {
        snap = await this.api.snapshot();
      } catch {
        continue;
      }
      for (const t of snap.tasks) {
        if (t.state === 'in_review') {
          const key = `${t.id}:review:${t.reviews.length}`;
          if (this.scheduled.has(key)) continue;
          this.scheduled.add(key);
          void this.reviewLater(t);
        } else if (t.state === 'blocked') {
          const key = `${t.id}:unblock:${t.attempt}`;
          if (this.scheduled.has(key)) continue;
          this.scheduled.add(key);
          void this.unblockLater(t);
        }
      }
      const active = snap.projects.filter((p) => p.status !== 'archived');
      if (
        this.opts.loop !== false &&
        !this.restarting &&
        active.length > 0 &&
        active.every((p) => p.status === 'delivered')
      ) {
        this.restarting = true;
        void (async () => {
          await this.sleep(9000);
          if (this.stopped) return;
          try {
            for (const p of active) await this.api.archiveProject(p.id);
            await this.newRound();
          } finally {
            this.restarting = false;
          }
        })();
      }
    }
  }

  private async reviewLater(t: Task) {
    await this.sleep(this.between(2500, 4500));
    if (this.stopped) return;
    const first = t.reviews.length === 0;
    const reject = first && (this.fates.get(t.id) === 'reject' || (this.round > 1 && this.rand() < 0.1));
    try {
      await this.api.review(t.id, {
        reviewer: 'PM',
        decision: reject ? 'reject' : 'approve',
        comment: this.pick(reject ? REJECT_COMMENTS : APPROVE_COMMENTS),
      });
      this.log(`PM ${reject ? '退回' : '通過'}「${t.title}」`);
    } catch {
      /* 人類可能已經先在網頁上處理了 */
    }
  }

  private async unblockLater(t: Task) {
    await this.sleep(8000);
    if (this.stopped) return;
    try {
      await this.api.unblock(t.id, 'PM');
      this.log(`PM 解除「${t.title}」的阻塞`);
    } catch {
      /* 已被人類解除 */
    }
  }
}
