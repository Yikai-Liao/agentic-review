import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateReviewTrigger } from '../scripts/validate-review-trigger.ts';

test('validates a thread comment against its root and PR while retaining the original snapshot', async () => {
  const calls: string[] = [];
  await validateReviewTrigger({
    repository: 'owner/repo', pullNumber: '7', source: 'thread', commentId: '9', commentRootId: '8', body: '@review-app recheck', token: 'token', api: 'https://api.github.test',
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json({ id: 9, body: 'edited after trigger', in_reply_to_id: 8, pull_request_url: 'https://api.github.test/repos/owner/repo/pulls/7' });
    }) as typeof fetch,
  });
  assert.deepEqual(calls, ['https://api.github.test/repos/owner/repo/pulls/comments/9']);
});

test('rejects a trigger comment from another pull request', async () => {
  await assert.rejects(validateReviewTrigger({
    repository: 'owner/repo', pullNumber: '7', source: 'thread', commentId: '9', commentRootId: '8', body: '@review-app recheck', token: 'token', api: 'https://api.github.test',
    fetchImpl: async () => Response.json({ id: 9, body: '@review-app recheck', in_reply_to_id: 8, pull_request_url: 'https://api.github.test/repos/owner/repo/pulls/6' }),
  }), /not on the requested pull request/);
});
