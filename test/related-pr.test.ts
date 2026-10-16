import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../scripts/read-related-pr.ts';

test('关联 PR 完整保留跨页行内确认及其问题和 thread 状态', () => {
  const calls: string[][] = [];
  const run = (command: string, args: string[]) => {
    assert.equal(command, 'gh');
    calls.push(args);
    if (args.includes('view')) return JSON.stringify({ number: 379, title: '按节点状态控制操作', state: 'MERGED' });
    assert.ok(args.includes('--paginate'));
    assert.ok(args.includes('--slurp'));
    if (args.includes('graphql')) return JSON.stringify([{ data: { repository: { pullRequest: {
      reviewThreads: {
        nodes: [{ id: 'thread-1', isResolved: true, isOutdated: true,
          resolvedBy: { login: 'maintainer' }, comments: { nodes: [{ databaseId: 1 }] } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    } } } }]);
    const route = args.at(-1)!;
    if (route.includes('/pulls/379/comments?')) return JSON.stringify([
      [{ id: 1, body: '终止会话是否允许节点操作？', path: 'task-node-phase.ts' }],
      [{ id: 2, body: '已确认：入口仅由当前节点产物判断。', in_reply_to_id: 1 }],
    ]);
    return JSON.stringify([[{ id: 3, body: route.includes('/reviews?') ? '历史总评' : '普通评论' }]]);
  };
  const result = JSON.parse(main('owner/repo', '379', run));
  assert.equal(result.repository, 'owner/repo');
  assert.equal(result.number, 379);
  assert.equal(result.metadata.state, 'MERGED');
  assert.equal(result.issue_comments[0].body, '普通评论');
  assert.equal(result.reviews[0].body, '历史总评');
  assert.equal(result.inline_comments.length, 2);
  assert.equal(result.inline_comments[1].in_reply_to_id, result.inline_comments[0].id);
  assert.equal(result.inline_comments[1].body, '已确认：入口仅由当前节点产物判断。');
  assert.equal(result.threads[0].root_comment_id, 1);
  assert.equal(result.threads[0].isResolved, true);
  assert.equal(result.threads[0].isOutdated, true);
  assert.equal(calls.length, 5);
});

test('关联 PR 查询失败或目标无效时不能返回空讨论', () => {
  const unavailable = () => { throw new Error('HTTP 403'); };
  assert.throws(() => main('owner/repo', '379', unavailable), /HTTP 403/);
  assert.throws(() => main('owner/repo', 'invalid', unavailable), /Invalid PR target/);
  assert.throws(() => main('owner/repo/extra', '379', unavailable), /Invalid PR target/);
});
