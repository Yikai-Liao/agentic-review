import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main, readDiscussion } from '../scripts/refresh-review-discussion.ts';

const comment = (id: number, body = '原始评论') => ({ id, body, user: { login: 'author' }, updated_at: '2026-09-07T10:00:00Z' });
const thread = (id: number, isResolved = false) => ({ id: `thread-${id}`, isResolved, isOutdated: false,
  resolvedBy: isResolved ? { login: 'maintainer' } : null, comments: { nodes: [{ databaseId: id }] } });
const threadPage = (nodes: unknown[], hasNextPage = false) => ({ data: { repository: { pullRequest: {
  reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next' : null } },
} } } });

function fixture({ issue = [[comment(1)]], inline = [[comment(2)]], reviews = [[comment(3)]],
  threads = [threadPage([thread(2)])] }: {
    issue?: unknown; inline?: unknown; reviews?: unknown; threads?: unknown;
  } = {}) {
  const calls: string[][] = [];
  return { calls, run: async (command: string, args: string[]) => {
    assert.equal(command, 'gh');
    assert.ok(args.includes('--paginate'));
    assert.ok(args.includes('--slurp'));
    calls.push(args);
    if (args.includes('graphql')) return JSON.stringify(threads);
    const route = args.at(-1)!;
    return JSON.stringify(route.includes('/issues/') ? issue : route.includes('/reviews?') ? reviews : inline);
  } };
}

test('startup snapshot and fixed-baseline delta include all comment kinds and thread-only changes', async () => {
  const initial = await readDiscussion('owner/repo', '61', fixture().run);
  const unchanged = await readDiscussion('owner/repo', '61', fixture().run, initial.baseline);
  assert.deepEqual(unchanged.discussion, { issue_comments: [], inline_comments: [], reviews: [], threads: [] });
  const changed = fixture({
    issue: [[comment(1, '编辑后的明确决定')], [comment(4, '新增决定')]],
    inline: [[comment(2)], [{ ...comment(5, '新增回复'), in_reply_to_id: 2,
      diff_hunk: '@@ -1 +1 @@', original_line: 1, commit_id: 'b'.repeat(40) }]],
    reviews: [[comment(3, '编辑后的 Review')], [comment(6, '新增 Review')]],
    threads: [threadPage([thread(2, true)], true), threadPage([thread(7)])],
  });
  const before = JSON.stringify(initial.baseline);
  const delta = (await readDiscussion('owner/repo', '61', changed.run, initial.baseline)).discussion;
  assert.deepEqual(delta.issue_comments.map(x => x.id), [1, 4]);
  assert.deepEqual(delta.inline_comments.map(x => x.id), [5]);
  assert.equal(delta.inline_comments[0].in_reply_to_id, 2);
  assert.equal(delta.inline_comments[0].diff_hunk, '@@ -1 +1 @@');
  assert.equal(delta.inline_comments[0].original_line, 1);
  assert.deepEqual(delta.reviews.map(x => x.id), [3, 6]);
  assert.deepEqual(delta.threads.map(x => [x.root_comment_id, x.isResolved]), [[2, true], [7, false]]);
  const routes = changed.calls.filter(args => !args.includes('graphql')).map(args => args.at(-1)!);
  assert.ok(routes[0].includes(`since=${encodeURIComponent(initial.baseline.since)}`));
  assert.ok(routes[1].includes('&since='));
  assert.ok(!routes[2].includes('since='));
  assert.equal(JSON.stringify(initial.baseline), before);
  assert.deepEqual((await readDiscussion('owner/repo', '61', changed.run, initial.baseline)).discussion, delta);
});

test('独立讨论查询并发开始，全部完成后才返回快照', async () => {
  const source = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  let completed = false;
  const pending = readDiscussion('owner/repo', '61', async (command, args) => {
    started++;
    await gate;
    return source.run(command, args);
  }).then(result => { completed = true; return result; });
  try {
    assert.equal(started, 4);
    assert.equal(completed, false);
  } finally {
    release();
  }
  const { discussion } = await pending;
  assert.deepEqual(discussion.issue_comments.map(record => record.id), [1]);
  assert.deepEqual(discussion.inline_comments.map(record => record.id), [2]);
  assert.deepEqual(discussion.reviews.map(record => record.id), [3]);
  assert.deepEqual(discussion.threads.map(record => record.root_comment_id), [2]);
});

test('timestamp boundary overlaps and newly visible records are not filtered by creation time', async () => {
  const before = Date.now();
  const { baseline } = await readDiscussion('owner/repo', '61', fixture().run);
  assert.ok(Date.parse(baseline.since) <= before - 1000);
  assert.ok(Date.parse(baseline.since) > before - 2000);
  const { discussion } = await readDiscussion('owner/repo', '61', fixture({
    inline: [[comment(2), { ...comment(10), created_at: '2026-09-01T00:00:00Z' }]],
  }).run, baseline);
  assert.deepEqual(discussion.inline_comments.map(x => x.id), [10]);
});

test('讨论输入保留原文、版本、行号和回复关系，去除 API 搬运字段', async () => {
  const evidence = {
    id: 21, body: '已确认保留此范围。\n\n```ts\nconst enabled = false;\n```',
    html_url: 'https://github.test/owner/repo/pull/61#discussion_r21',
    created_at: '2026-10-28T01:00:00Z', updated_at: '2026-10-28T02:00:00Z',
    author_association: 'MEMBER', commit_id: 'b'.repeat(40), original_commit_id: 'a'.repeat(40),
    pull_request_review_id: 8, in_reply_to_id: 20, path: 'src/auth.ts',
    diff_hunk: '@@ -10,2 +10,2 @@\n-const enabled = true;\n+const enabled = false;',
    line: null, original_line: 11, start_line: null, original_start_line: 10,
    side: 'RIGHT', start_side: 'RIGHT', position: null, original_position: 2, subject_type: 'line',
    user: { id: 3, login: 'maintainer', type: 'User', html_url: 'https://github.test/maintainer' },
    performed_via_github_app: { id: 4, slug: 'review-app', name: 'Review App' },
    reactions: { '+1': 1, '-1': 0, total_count: 1 },
    is_copilot_code_review: false, copilot_code_review_sources: [],
  };
  const raw = {
    ...evidence, url: 'https://api.github.test/comments/21', node_id: 'opaque-comment-id',
    pull_request_url: 'https://api.github.test/pulls/61', _links: { self: { href: 'api-url' } },
    user: { ...evidence.user, avatar_url: 'avatar-url', followers_url: 'followers-url', node_id: 'opaque-user-id' },
    performed_via_github_app: { ...evidence.performed_via_github_app, description: '应用介绍', owner: { avatar_url: 'avatar-url' } },
  };
  const review = { id: 8, body: '当前方案已确认，未运行测试。', state: 'COMMENTED',
    submitted_at: '2026-10-28T02:00:00Z', commit_id: 'b'.repeat(40), user: null };
  const initial = await readDiscussion('owner/repo', '61', fixture({
    inline: [[raw]], reviews: [[{ ...review, _links: { html: 'review-url' } }]],
  }).run);
  assert.deepEqual(initial.discussion.inline_comments, [evidence]);
  assert.deepEqual(initial.discussion.reviews, [review]);

  const metadataOnly = await readDiscussion('owner/repo', '61', fixture({
    inline: [[{ ...raw, user: { ...raw.user, avatar_url: 'new-avatar-url' } }]],
    reviews: [[review]],
  }).run, initial.baseline);
  assert.deepEqual(metadataOnly.discussion.inline_comments, []);
  assert.deepEqual(metadataOnly.discussion.reviews, []);

  // 正文编辑、定位变更与 Review 状态变化仍能从固定启动基线检出。
  for (const change of [{ body: '撤回之前的确认。' }, { line: 12 }, { commit_id: 'c'.repeat(40) }]) {
    const changed = await readDiscussion('owner/repo', '61', fixture({ inline: [[{ ...raw, ...change }]] }).run, initial.baseline);
    assert.deepEqual(changed.discussion.inline_comments, [{ ...evidence, ...change }]);
  }
  const dismissed = await readDiscussion('owner/repo', '61', fixture({
    reviews: [[{ ...review, state: 'DISMISSED' }]],
  }).run, initial.baseline);
  assert.equal(dismissed.discussion.reviews[0].state, 'DISMISSED');
});

test('删除全部历史 thread 时仍输出删除变化，固定基线支持重复刷新', async () => {
  const initial = await readDiscussion('owner/repo', '587', fixture({
    inline: [[comment(3975642831), comment(3975642841)]],
    threads: [threadPage([thread(3975642831), thread(3975642841)])],
  }).run);
  assert.deepEqual(initial.removed_thread_ids, []);
  const before = JSON.stringify(initial.baseline);
  const deleted = fixture({ issue: [[]], inline: [[]], reviews: [[]], threads: [threadPage([])] });
  for (let attempt = 0; attempt < 2; attempt++) {
    const refresh = await readDiscussion('owner/repo', '587', deleted.run, initial.baseline);
    assert.deepEqual(refresh.discussion, { issue_comments: [], inline_comments: [], reviews: [], threads: [] });
    assert.deepEqual(refresh.removed_thread_ids, ['thread-3975642831', 'thread-3975642841']);
  }
  assert.equal(JSON.stringify(initial.baseline), before);
  assert.equal(deleted.calls.length, 8);
});

test('完整分页后区分删除、未变化、新增和状态变化的 thread', async () => {
  const initial = await readDiscussion('owner/repo', '61', fixture({
    threads: [threadPage([thread(1), thread(2), thread(3)])],
  }).run);
  const refresh = await readDiscussion('owner/repo', '61', fixture({
    threads: [threadPage([thread(3, true)], true), threadPage([thread(2), thread(4)])],
  }).run, initial.baseline);
  assert.deepEqual(refresh.removed_thread_ids, ['thread-1']);
  assert.deepEqual(refresh.discussion.threads.map(record => record.id), ['thread-3', 'thread-4']);
});

test('request failure, partial GraphQL data and unfinished pagination fail instead of returning an empty delta', async () => {
  await assert.rejects(readDiscussion('owner/repo', '61', async () => { throw new Error('HTTP 403'); }), /HTTP 403/);
  for (const threads of [
    [threadPage([], true)],
    [{ ...threadPage([]), errors: [{ message: 'Denied' }] }],
    [{ data: { repository: null } }],
    [],
  ]) await assert.rejects(readDiscussion('owner/repo', '61', fixture({ threads }).run), /thread pages/);
  await assert.rejects(readDiscussion('owner/repo', '61', fixture({ issue: [{}] }).run), /issue_comments pages/);
  const { baseline } = await readDiscussion('owner/repo', '61', fixture().run);
  await assert.rejects(readDiscussion('other/repo', '61', fixture().run, baseline), /baseline/);
});

test('refresh CLI leaves its baseline unchanged on both success and failure', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-discussion-'));
  const originalEnv = { ...process.env };
  try {
    Object.assign(process.env, { REVIEW_WORKSPACE_PATH: directory, REVIEW_REPOSITORY: 'owner/repo', REVIEW_PULL_NUMBER: '61' });
    const baselinePath = path.join(directory, 'discussion-baseline.json');
    await assert.rejects(main(fixture().run), /ENOENT/);
    const baseline = JSON.stringify((await readDiscussion('owner/repo', '61', fixture().run)).baseline);
    writeFileSync(baselinePath, baseline);
    assert.deepEqual(JSON.parse(await main(fixture().run)).inline_comments, []);
    assert.deepEqual(JSON.parse(await main(fixture().run)).removed_thread_ids, []);
    assert.deepEqual(JSON.parse(await main(fixture({ threads: [threadPage([])] }).run)).removed_thread_ids, ['thread-2']);
    await assert.rejects(main(async () => { throw new Error('network failure'); }), /network failure/);
    assert.equal(readFileSync(baselinePath, 'utf8'), baseline);
  } finally {
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});
