import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitLockStore, type LockPayload } from './locks.ts';
import { parseYamlish, readBodyBlock, readCommentMeta, splitTaskBody, stringifyYamlish, taskBody, writeBodyBlock, writeComment } from './meta.ts';

/** 用本機的裸倉庫當「遠端」：git push --force-with-lease 的比較並交換和推到 GitHub 時一樣 */
function remote() {
  const root = mkdtempSync(join(tmpdir(), 'apm-locks-'));
  const url = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', url]);
  let n = 0;
  const store = () => new GitLockStore({ remoteUrl: url, dir: join(root, `local-${++n}.git`) });
  return { root, url, store };
}

const payload = (task: number, worker: string, extra: Partial<LockPayload> = {}): LockPayload => ({
  v: 1,
  task,
  worker,
  owner: worker,
  attempt: 1,
  status: 'held',
  at: Date.now(),
  expires_at: Date.now() + 600_000,
  ...extra,
});

test('git 鎖：建立、比較並交換、讀取、強制、刪除', async () => {
  const { store } = remote();
  const a = store();
  const b = store();
  const l1 = await a.create(payload(7, 'alice'));
  assert.ok(l1);
  assert.equal(await b.create(payload(7, 'bob')), null, '分支已存在時建立失敗');
  const seen = await b.list();
  assert.equal(seen.get(7)?.worker, 'alice');
  const l2 = await a.advance(l1!.sha, payload(7, 'alice', { attempt: 1 }));
  assert.ok(l2);
  assert.equal(await b.advance(l1!.sha, payload(7, 'bob', { attempt: 2 })), null, '用舊值推送會被拒絕');
  assert.equal((await b.get(7))?.sha, l2!.sha);
  const l3 = await b.advance(l2!.sha, payload(7, 'bob', { attempt: 2 }));
  assert.ok(l3);
  // a 手上的是舊值：續約失敗
  assert.equal(await a.advance(l2!.sha, payload(7, 'alice')), null);
  const f = await a.force(payload(7, 'admin', { status: 'revoked', expires_at: null }));
  assert.equal((await b.get(7))?.status, 'revoked');
  assert.equal(await b.remove(7, l3!.sha), false);
  assert.equal(await b.remove(7, f.sha), true);
  assert.equal((await a.list()).has(7), false);
  assert.equal(await a.get(7), null);
});

test('git 鎖：8 個進程同時搶同一個任務，只有一個成功', async () => {
  const { store } = remote();
  const stores = Array.from({ length: 8 }, () => store());
  const created = await Promise.all(stores.map((s, i) => s.create(payload(1, `w${i}`))));
  assert.equal(created.filter(Boolean).length, 1);
  const winner = created.find(Boolean)!;
  // 再從同一個舊值同時往前推
  const advanced = await Promise.all(stores.map((s, i) => s.advance(winner.sha, payload(1, `w${i}`, { attempt: 2 }))));
  assert.equal(advanced.filter(Boolean).length, 1);
});

test('git 鎖：初始化 hub 的預設分支（只在不存在時）', async () => {
  const { store, url } = remote();
  const s = store();
  assert.equal(await s.initBranch('main', { 'README.md': '# hub\n', '.agent-pm/config.yml': 'lease_minutes: 10\n' }, 'init'), 'created');
  assert.equal(await s.initBranch('main', { 'README.md': 'x' }, 'init'), 'exists');
  const cfg = execFileSync('git', ['--git-dir', url, 'show', 'main:.agent-pm/config.yml'], { encoding: 'utf8' });
  assert.equal(cfg, 'lease_minutes: 10\n');
});

test('隱藏區塊：YAML 往返、-->、引號、列表', () => {
  const data = { key: 'site', priority: 4, max_parallel: 'none', repo: 'a/b', merge_on_approve: true, managers: ['amy', 'bob'], weird: 'x --> y, "z"', num_str: '42', empty: [] as string[] };
  const text = stringifyYamlish(data);
  assert.ok(!text.includes('-->'));
  assert.deepEqual(parseYamlish(text), { ...data, empty: [] });
  const body = writeBodyBlock('說明文字\n\n第二段', 'apm:project', data);
  const back = readBodyBlock(body, 'apm:project');
  assert.equal(back.rest, '說明文字\n\n第二段');
  assert.deepEqual(back.data, { ...data, empty: [] });
  assert.equal(readBodyBlock('沒有區塊', 'apm:project').data, null);
  const c = writeComment({ kind: 'checkpoint', summary: 'a --> b' }, '**檢查點**');
  assert.deepEqual(readCommentMeta(c), { meta: { kind: 'checkpoint', summary: 'a --> b' }, text: '**檢查點**\n' });
  assert.equal(readCommentMeta('普通留言'), null);
  const tb = taskBody('做這個', '- 有測試');
  assert.deepEqual(splitTaskBody(tb), { description: '做這個', acceptance: '- 有測試' });
  assert.deepEqual(splitTaskBody(taskBody('', '')), { description: '', acceptance: '' });
});
