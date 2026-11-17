import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../scripts/read-related-pr.ts';

test('A related PR keeps inline confirmations across pages with their questions and thread state', async () => {
  const run = async (command: string, args: string[]) => {
    assert.equal(command, 'gh');
    if (args.includes('view')) return JSON.stringify({ number: 379, title: 'Gate actions by node state', state: 'MERGED' });
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
      [{ id: 1, body: 'Are node actions allowed after the session ends?', path: 'task-node-phase.ts' }],
      [{ id: 2, body: 'Confirmed: the entry is decided only by the current node\'s artifacts.', in_reply_to_id: 1 }],
    ]);
    return JSON.stringify([[{ id: 3, body: route.includes('/reviews?') ? 'Earlier review summary' : 'Plain comment' }]]);
  };
  const result = JSON.parse(await main('owner/repo', '379', run));
  assert.equal(result.repository, 'owner/repo');
  assert.equal(result.number, 379);
  assert.equal(result.metadata.state, 'MERGED');
  assert.equal(result.issue_comments[0].body, 'Plain comment');
  assert.equal(result.reviews[0].body, 'Earlier review summary');
  assert.equal(result.inline_comments.length, 2);
  assert.equal(result.inline_comments[1].in_reply_to_id, result.inline_comments[0].id);
  assert.equal(result.inline_comments[1].body, 'Confirmed: the entry is decided only by the current node\'s artifacts.');
  assert.equal(result.threads[0].root_comment_id, 1);
  assert.equal(result.threads[0].isResolved, true);
  assert.equal(result.threads[0].isOutdated, true);
});

test('A failed related PR query or invalid target never returns an empty discussion', async () => {
  const unavailable = async () => { throw new Error('HTTP 403'); };
  await assert.rejects(main('owner/repo', '379', unavailable), /HTTP 403/);
  await assert.rejects(main('owner/repo', 'invalid', unavailable), /Invalid PR target/);
  await assert.rejects(main('owner/repo/extra', '379', unavailable), /Invalid PR target/);
});
