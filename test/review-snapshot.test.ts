import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveReviewSnapshot } from '../scripts/resolve-review-snapshot.ts';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const options = {
  repository: 'owner/repo', repositoryId: '1', pullNumber: '7', source: 'pr_comment',
  baseSha: '', headSha: '', token: 'read-only',
  fetchImpl: (async () => Response.json({ state: 'open', draft: false, base: { sha: baseSha, repo: { id: 1 } }, head: { sha: headSha } })) as typeof fetch,
};

test('queued comments fix the current snapshot independently of webhook-time commits', async () => {
  assert.deepEqual(await resolveReviewSnapshot({ ...options, headSha: 'c'.repeat(40) }), { baseSha, headSha });
  assert.deepEqual(await resolveReviewSnapshot({ ...options, source: 'thread' }), { baseSha, headSha });
});

test('accepts an open draft pull request snapshot', async () => {
  const draftOptions = {
    ...options,
    fetchImpl: (async () => Response.json({ state: 'open', draft: true, base: { sha: baseSha, repo: { id: 1 } }, head: { sha: headSha } })) as typeof fetch,
  };
  assert.deepEqual(await resolveReviewSnapshot(draftOptions), { baseSha, headSha });
});

test('automatic events reject superseded snapshots and mismatched repositories', async () => {
  await assert.rejects(resolveReviewSnapshot({ ...options, source: 'automatic', baseSha, headSha: 'c'.repeat(40) }), /stale/);
  await assert.rejects(resolveReviewSnapshot({ ...options, repositoryId: '2' }), /eligible/);
  assert.deepEqual(await resolveReviewSnapshot({ ...options, source: 'automatic', baseSha, headSha }), { baseSha, headSha });
});
