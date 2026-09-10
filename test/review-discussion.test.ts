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
  return { calls, run: (command: string, args: string[]) => {
    assert.equal(command, 'gh');
    assert.ok(args.includes('--paginate'));
    assert.ok(args.includes('--slurp'));
    calls.push(args);
    if (args.includes('graphql')) return JSON.stringify(threads);
    const route = args.at(-1)!;
    return JSON.stringify(route.includes('/issues/') ? issue : route.includes('/reviews?') ? reviews : inline);
  } };
}

test('startup snapshot and fixed-baseline delta include all comment kinds and thread-only changes', () => {
  const initial = readDiscussion('owner/repo', '61', fixture().run);
  const unchanged = readDiscussion('owner/repo', '61', fixture().run, initial.baseline);
  assert.deepEqual(unchanged.discussion, { issue_comments: [], inline_comments: [], reviews: [], threads: [] });
  const changed = fixture({
    issue: [[comment(1, '编辑后的明确决定')], [comment(4, '新增决定')]],
    inline: [[comment(2)], [{ ...comment(5, '新增回复'), in_reply_to_id: 2,
      diff_hunk: '@@ -1 +1 @@', original_line: 1, commit_id: 'b'.repeat(40) }]],
    reviews: [[comment(3, '编辑后的 Review')], [comment(6, '新增 Review')]],
    threads: [threadPage([thread(2, true)], true), threadPage([thread(7)])],
  });
  const before = JSON.stringify(initial.baseline);
  const delta = readDiscussion('owner/repo', '61', changed.run, initial.baseline).discussion;
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
  assert.deepEqual(readDiscussion('owner/repo', '61', changed.run, initial.baseline).discussion, delta);
});

test('timestamp boundary overlaps and newly visible records are not filtered by creation time', () => {
  const before = Date.now();
  const { baseline } = readDiscussion('owner/repo', '61', fixture().run);
  assert.ok(Date.parse(baseline.since) <= before - 1000);
  assert.ok(Date.parse(baseline.since) > before - 2000);
  const { discussion } = readDiscussion('owner/repo', '61', fixture({
    inline: [[comment(2), { ...comment(10), created_at: '2026-09-01T00:00:00Z' }]],
  }).run, baseline);
  assert.deepEqual(discussion.inline_comments.map(x => x.id), [10]);
});

test('删除全部历史 thread 时仍输出删除变化，固定基线支持重复刷新', () => {
  const initial = readDiscussion('owner/repo', '587', fixture({
    inline: [[comment(3975642831), comment(3975642841)]],
    threads: [threadPage([thread(3975642831), thread(3975642841)])],
  }).run);
  assert.deepEqual(initial.removed_thread_ids, []);
  const before = JSON.stringify(initial.baseline);
  const deleted = fixture({ issue: [[]], inline: [[]], reviews: [[]], threads: [threadPage([])] });
  for (let attempt = 0; attempt < 2; attempt++) {
    const refresh = readDiscussion('owner/repo', '587', deleted.run, initial.baseline);
    assert.deepEqual(refresh.discussion, { issue_comments: [], inline_comments: [], reviews: [], threads: [] });
    assert.deepEqual(refresh.removed_thread_ids, ['thread-3975642831', 'thread-3975642841']);
  }
  assert.equal(JSON.stringify(initial.baseline), before);
  assert.equal(deleted.calls.length, 8);
});

test('完整分页后区分删除、未变化、新增和状态变化的 thread', () => {
  const initial = readDiscussion('owner/repo', '61', fixture({
    threads: [threadPage([thread(1), thread(2), thread(3)])],
  }).run);
  const refresh = readDiscussion('owner/repo', '61', fixture({
    threads: [threadPage([thread(3, true)], true), threadPage([thread(2), thread(4)])],
  }).run, initial.baseline);
  assert.deepEqual(refresh.removed_thread_ids, ['thread-1']);
  assert.deepEqual(refresh.discussion.threads.map(record => record.id), ['thread-3', 'thread-4']);
});

test('request failure, partial GraphQL data and unfinished pagination fail instead of returning an empty delta', () => {
  assert.throws(() => readDiscussion('owner/repo', '61', () => { throw new Error('HTTP 403'); }), /HTTP 403/);
  for (const threads of [
    [threadPage([], true)],
    [{ ...threadPage([]), errors: [{ message: 'Denied' }] }],
    [{ data: { repository: null } }],
    [],
  ]) assert.throws(() => readDiscussion('owner/repo', '61', fixture({ threads }).run), /thread pages/);
  assert.throws(() => readDiscussion('owner/repo', '61', fixture({ issue: [{}] }).run), /issue_comments pages/);
  const { baseline } = readDiscussion('owner/repo', '61', fixture().run);
  assert.throws(() => readDiscussion('other/repo', '61', fixture().run, baseline), /baseline/);
});

test('refresh CLI leaves its baseline unchanged on both success and failure', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-discussion-'));
  const originalEnv = { ...process.env };
  try {
    Object.assign(process.env, { REVIEW_WORKSPACE_PATH: directory, REVIEW_REPOSITORY: 'owner/repo', REVIEW_PULL_NUMBER: '61' });
    const baselinePath = path.join(directory, 'discussion-baseline.json');
    assert.throws(() => main(fixture().run), /ENOENT/);
    const baseline = JSON.stringify(readDiscussion('owner/repo', '61', fixture().run).baseline);
    writeFileSync(baselinePath, baseline);
    assert.deepEqual(JSON.parse(main(fixture().run)).inline_comments, []);
    assert.deepEqual(JSON.parse(main(fixture().run)).removed_thread_ids, []);
    assert.deepEqual(JSON.parse(main(fixture({ threads: [threadPage([])] }).run)).removed_thread_ids, ['thread-2']);
    assert.throws(() => main(() => { throw new Error('network failure'); }), /network failure/);
    assert.equal(readFileSync(baselinePath, 'utf8'), baseline);
  } finally {
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});
