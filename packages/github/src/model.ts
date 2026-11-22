import type { HubModel } from './derive.ts';
import { LABELS, type CommentInfo, type Hub } from './hub.ts';

/** 一次讀齊 hub 的全部數據：項目、任務、留言、名冊、鎖。apm status 和管理端用 */
export async function loadModel(hub: Hub, opts: { closedProjects?: boolean } = {}): Promise<HubModel> {
  const [config, projects, tasks, comments, locks] = await Promise.all([
    hub.config(),
    hub.projects(opts.closedProjects === false ? 'open' : 'all'),
    hub.tasks('all'),
    hub.allComments(),
    hub.locks.list(),
  ]);
  const roster = await rosterIssues(hub);
  const byIssue = new Map<number, CommentInfo[]>();
  const rosterComments: CommentInfo[] = [];
  for (const c of comments) {
    if (roster.has(c.issue)) {
      if (c.meta.kind === 'worker') rosterComments.push(c);
      continue;
    }
    const list = byIssue.get(c.issue) ?? [];
    list.push(c);
    byIssue.set(c.issue, list);
  }
  const me = await hub.me();
  const admins = [...config.admins];
  if (!admins.includes(me) && (await hub.isAdmin(me))) admins.push(me);
  return { config, projects, tasks, comments: byIssue, roster: rosterComments, locks, admins };
}

export async function rosterIssues(hub: Hub): Promise<Set<number>> {
  return new Set((await hub.rawIssues(LABELS.roster, 'all')).map((i) => i.number));
}
