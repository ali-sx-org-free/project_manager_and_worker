import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { PmError, buildResume, type Engine, type Task } from '@agent-pm/core';

/** 把協調服務暴露成 MCP 工具。Agent 只要配置一行 MCP 地址就能領任務、交付、review。
 *
 *  Worker 用：register_worker / list_ready_tasks / claim_task / heartbeat / save_checkpoint /
 *             submit_result / release_task / report_blocked
 *  PM 用：    create_project / list_tasks / get_task / review_task / unblock_task
 */

const brief = (t: Task) => ({
  id: t.id,
  key: t.key,
  title: t.title,
  state: t.state,
  labels: t.labels,
  deps: t.deps,
  assignee: t.assignee,
  attempt: t.attempt,
  progress: t.progress,
  branch: t.branch,
});

function buildServer(engine: Engine) {
  const server = new McpServer({ name: 'agent-pm', version: '0.1.0' });

  const ok = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  });
  const fail = (err: unknown) => ({
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: err instanceof PmError ? `[${err.code}] ${err.message}` : String(err),
      },
    ],
  });
  const guard = <A>(fn: (args: A) => unknown) => {
    return async (args: A) => {
      try {
        return ok(fn(args));
      } catch (err) {
        return fail(err);
      }
    };
  };

  // ───────── Worker 工具 ─────────

  server.registerTool(
    'register_worker',
    {
      description:
        '註冊（或更新）一個 Worker。labels 是這台電腦的能力標籤，例如 code、gpu、home-pc；只有標籤完全覆蓋任務要求時才能領取該任務。',
      inputSchema: {
        worker_id: z.string().describe('這個 worker 的固定 id，例如 home-pc-1'),
        name: z.string().optional().describe('顯示名稱'),
        machine: z.string().optional().describe('所在電腦，例如「家用電腦」'),
        labels: z.array(z.string()).optional().describe('能力標籤'),
      },
    },
    guard(({ worker_id, ...rest }) => engine.registerWorker({ id: worker_id, ...rest })),
  );

  server.registerTool(
    'list_ready_tasks',
    {
      description: '列出這個 worker 目前可以領取的任務（ready 或被退回待修改，且能力標籤符合）。',
      inputSchema: { worker_id: z.string() },
    },
    guard(({ worker_id }) => engine.listClaimable(worker_id).map(brief)),
  );

  server.registerTool(
    'claim_task',
    {
      description:
        '原子領取一個任務並取得租約。不傳 task_id 會自動挑一個適合的。返回任務詳情（含驗收標準、之前的 review 意見）；沒有可領的任務時返回 null。領取後必須定期調用 heartbeat，否則租約過期任務會被收回。如果返回的 resume 不是 null，表示這個任務別人（或你自己）已經做了一部分：請先讀 resume 裡的 summary、next_steps，切到 branch 分支拿到已有的中間成果，從那裡接著做，不要從頭開始。',
      inputSchema: {
        worker_id: z.string(),
        task_id: z.string().optional().describe('指定要領取的任務；省略則自動挑選'),
      },
    },
    guard(({ worker_id, task_id }) => {
      const task = engine.claimTask(worker_id, task_id);
      return task
        ? {
            task,
            resume: buildResume(task),
            lease_ms: engine.leaseMs,
            heartbeat_every_ms: Math.floor(engine.leaseMs / 3),
          }
        : null;
    }),
  );

  server.registerTool(
    'heartbeat',
    {
      description: '續約。執行任務期間每隔 lease 的三分之一調用一次。如果返回 lease_lost，表示任務已被收回，請立即停止。',
      inputSchema: { worker_id: z.string(), task_id: z.string() },
    },
    guard(({ worker_id, task_id }) => engine.heartbeat(worker_id, task_id)),
  );

  server.registerTool(
    'save_checkpoint',
    {
      description:
        '保存檢查點（同時續約）。每完成一個有意義的小步驟就調用一次：寫清楚到目前為止完成了什麼、接下來要做什麼，代碼先 commit 並 push 到任務分支再把 commit 填上。你隨時可能斷線、被打斷或用完額度，接手的 agent 只能看到最後一個檢查點，所以要寫到「換一個人照著就能接著做」的程度。',
      inputSchema: {
        worker_id: z.string(),
        task_id: z.string(),
        summary: z.string().describe('到目前為止完成了什麼'),
        next_steps: z.string().optional().describe('接下來要做什麼，寫給接手的人看'),
        progress: z.number().min(0).max(100).optional().describe('完成百分比'),
        commit: z.string().optional().describe('已 push 到任務分支的 commit'),
        artifacts: z.array(z.string()).optional().describe('其他中間產物的鏈接或路徑'),
      },
    },
    guard(({ worker_id, task_id, ...cp }) => engine.saveCheckpoint(worker_id, task_id, cp)),
  );

  server.registerTool(
    'release_task',
    {
      description:
        '主動交出任務，讓別的 worker 立刻接手（不用等租約超時）。在你無法繼續但任務本身沒有問題時使用，例如用量額度快用完、被要求停下。交出前先 save_checkpoint，note 裡寫交接說明。',
      inputSchema: {
        worker_id: z.string(),
        task_id: z.string(),
        reason: z.enum(['usage_limit', 'interrupted', 'released', 'error']).optional(),
        note: z.string().optional().describe('給接手者的交接說明'),
      },
    },
    guard(({ worker_id, task_id, reason, note }) => brief(engine.releaseTask(worker_id, task_id, { reason, note }))),
  );

  server.registerTool(
    'submit_result',
    {
      description:
        '提交交付物，任務進入 in_review 等待 PM review。研發類任務請把改動推到分支並開 PR，pr_url 填 PR 鏈接；非代碼任務只填 summary。',
      inputSchema: {
        worker_id: z.string(),
        task_id: z.string(),
        summary: z.string().describe('做了什麼、如何對照驗收標準自查'),
        pr_url: z.string().optional().describe('PR 鏈接（研發類任務）'),
      },
    },
    guard(({ worker_id, task_id, summary, pr_url }) =>
      brief(engine.submitResult(worker_id, task_id, { summary, pr_url })),
    ),
  );

  server.registerTool(
    'report_blocked',
    {
      description: '任務無法繼續時回報受阻（例如缺少權限、需要人類決定）。任務進入 blocked，等 PM 或人類解除。',
      inputSchema: { worker_id: z.string(), task_id: z.string(), reason: z.string() },
    },
    guard(({ worker_id, task_id, reason }) => brief(engine.reportBlocked(worker_id, task_id, reason))),
  );

  // ───────── PM 工具 ─────────

  server.registerTool(
    'create_project',
    {
      description:
        'PM 專用：把人類的請求拆解成任務 DAG 並建立項目。每個任務用 key 互相引用依賴，服務端會校驗無環。沒有依賴的任務立即變成 ready。',
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        kind: z.enum(['dev', 'chore']).optional().describe('dev=研發項目，chore=日常雜事'),
        tasks: z
          .array(
            z.object({
              key: z.string().describe('項目內唯一的短名'),
              title: z.string(),
              description: z.string().optional(),
              acceptance: z.string().optional().describe('驗收標準，review 時以此為準'),
              labels: z.array(z.string()).optional().describe('執行這個任務需要的能力標籤'),
              deps: z.array(z.string()).optional().describe('依賴的任務 key'),
            }),
          )
          .min(1),
      },
    },
    guard((input) => {
      const { project, tasks } = engine.createProject(input);
      return { project, tasks: tasks.map(brief) };
    }),
  );

  server.registerTool(
    'list_tasks',
    {
      description: '列出任務，可按項目或狀態過濾。PM 用它找出 in_review、blocked 的任務。',
      inputSchema: {
        project_id: z.string().optional(),
        state: z
          .enum(['pending', 'ready', 'claimed', 'in_review', 'changes_requested', 'blocked', 'done'])
          .optional(),
      },
    },
    guard(({ project_id, state }) => {
      const snap = engine.snapshot();
      return {
        projects: snap.projects,
        tasks: snap.tasks
          .filter((t) => (!project_id || t.project_id === project_id) && (!state || t.state === state))
          .map(brief),
      };
    }),
  );

  server.registerTool(
    'get_task',
    {
      description: '查看任務完整內容：描述、驗收標準、交付結果、PR 鏈接、review 歷史。',
      inputSchema: { task_id: z.string() },
    },
    guard(({ task_id }) => engine.getTask(task_id)),
  );

  server.registerTool(
    'review_task',
    {
      description:
        'PM 專用：review 一個 in_review 的任務。approve 後任務 done 並解鎖下游；reject 則變成 changes_requested，worker 會帶著 comment 重新領取。',
      inputSchema: {
        task_id: z.string(),
        decision: z.enum(['approve', 'reject']),
        comment: z.string().optional(),
        reviewer: z.string().optional().describe('預設 PM'),
      },
    },
    guard(({ task_id, decision, comment, reviewer }) =>
      brief(engine.review(task_id, { decision, comment, reviewer: reviewer ?? 'PM' })),
    ),
  );

  server.registerTool(
    'unblock_task',
    {
      description: 'PM 專用：阻塞原因解決後，把 blocked 的任務放回任務池。',
      inputSchema: { task_id: z.string(), by: z.string().optional() },
    },
    guard(({ task_id, by }) => brief(engine.unblock(task_id, by ?? 'PM'))),
  );

  return server;
}

/** 無狀態 Streamable HTTP：每個請求建一個 server + transport，不需要會話保持，方便放在反向代理後面。 */
export function mcpHandler(engine: Engine) {
  return async (req: Request, res: Response) => {
    const server = buildServer(engine);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (err) {
      console.error('[mcp] 處理請求失敗', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };
}
