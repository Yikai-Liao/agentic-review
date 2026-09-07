import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readReviewThreads } from '../scripts/read-review-threads.ts';

test('refresh joins all thread and reply pages and rejects incomplete snapshots', async () => {
  const originalEnv = { ...process.env };
  process.env.REVIEW_REPOSITORY = 'owner/repo';
  process.env.REVIEW_PULL_NUMBER = '60';
  try {
    const page = (root: number) => ({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [{ id: `thread-${root}`, isResolved: true, isOutdated: false, resolvedBy: { login: 'maintainer' }, comments: { nodes: [{ databaseId: root }] } }],
    } } } } });
    const commands: string[][] = [];
    const run = async (args: string[]) => {
      commands.push(args);
      return JSON.stringify(args.includes('graphql') ? [page(1), page(2)] : [
        [{ id: 1, body: 'root 1' }, { id: 2, body: 'root 2' }],
        [{ id: 3, in_reply_to_id: 1, body: '快照之后的明确确认' }],
      ]);
    };
    const threads = await readReviewThreads(run);
    assert.equal(threads.length, 2);
    assert.deepEqual(threads[0].comments.map((c: any) => c.body), ['root 1', '快照之后的明确确认']);
    assert.equal(threads[0].isResolved, true);
    assert.equal(threads[1].comments.length, 1);
    for (const args of commands) {
      assert.ok(args.includes('--paginate'));
      assert.ok(args.includes('--slurp'));
    }
    assert.ok(commands[0].some((arg) => arg.includes('after:$endCursor')));
    await assert.rejects(readReviewThreads(async (args) =>
      JSON.stringify(args.includes('graphql') ? [page(1)] : [[]])), /Incomplete review thread snapshot/);
    await assert.rejects(readReviewThreads(async (args) =>
      JSON.stringify(args.includes('graphql') ? [{ errors: [{ message: 'denied' }] }] : [[]])), /query failed/);
    await assert.rejects(readReviewThreads(async () => { throw new Error('API unavailable'); }), /API unavailable/);
  } finally {
    process.env = originalEnv;
  }
});
