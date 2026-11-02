import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveReviewSnapshot } from '../scripts/resolve-review-snapshot.ts';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const pullRequest = { title: '测试标题', body: '测试说明', user: { login: 'maintainer' }, state: 'open', draft: false,
  base: { ref: 'main', sha: baseSha, repo: { id: 1 } }, head: { ref: 'feature', sha: headSha } };
const snapshot = { repository: 'owner/repo', pullNumber: '7', baseSha, headSha,
  metadata: { title: '测试标题', body: '测试说明', author: { login: 'maintainer' },
    baseRefName: 'main', baseRefOid: baseSha, headRefName: 'feature', headRefOid: headSha } };
const options = {
  repository: 'owner/repo', repositoryId: '1', pullNumber: '7', source: 'pr_comment',
  baseSha: '', headSha: '', token: 'read-only',
  fetchImpl: (async () => Response.json(pullRequest)) as typeof fetch,
};

test('queued comments fix the current snapshot independently of webhook-time commits', async () => {
  assert.deepEqual(await resolveReviewSnapshot({ ...options, headSha: 'c'.repeat(40) }), snapshot);
  assert.deepEqual(await resolveReviewSnapshot({ ...options, source: 'thread' }), snapshot);
});

test('accepts an open draft pull request snapshot', async () => {
  const draftOptions = {
    ...options,
    fetchImpl: (async () => Response.json({ ...pullRequest, draft: true })) as typeof fetch,
  };
  assert.deepEqual(await resolveReviewSnapshot(draftOptions), snapshot);
});

test('automatic events reject superseded snapshots and mismatched repositories', async () => {
  await assert.rejects(resolveReviewSnapshot({ ...options, source: 'automatic', baseSha, headSha: 'c'.repeat(40) }), /stale/);
  await assert.rejects(resolveReviewSnapshot({ ...options, repositoryId: '2' }), /eligible/);
  assert.deepEqual(await resolveReviewSnapshot({ ...options, source: 'automatic', baseSha, headSha }), snapshot);
});
