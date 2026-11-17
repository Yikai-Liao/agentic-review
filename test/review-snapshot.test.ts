import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveReviewSnapshot } from '../scripts/resolve-review-snapshot.ts';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const pullRequest = { title: 'Test title', body: 'Test description', user: { login: 'maintainer' }, state: 'open', draft: false,
  base: { ref: 'main', sha: baseSha, repo: { id: 1 } }, head: { ref: 'feature', sha: headSha } };
const snapshot = { repository: 'owner/repo', pullNumber: '7', baseSha, headSha,
  metadata: { title: 'Test title', body: 'Test description', author: { login: 'maintainer' },
    state: 'open', merged: false, mergedAt: null,
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

test('After merge and deletion of the source branch or fork, manual dispatch and comments still review the SHAs stored on the PR', async () => {
  const mergedAt = '2026-11-03T06:53:11Z';
  const merged = { ...pullRequest, state: 'closed', merged: true, merged_at: mergedAt,
    head: { ref: 'deleted-feature', sha: headSha, repo: null } };
  const expected = { ...snapshot, metadata: { ...snapshot.metadata,
    state: 'closed', merged: true, mergedAt, headRefName: 'deleted-feature' } };
  for (const source of ['automatic', 'pr_comment', 'thread']) {
    const request = { ...options, source, baseSha, headSha, fetchImpl: async () => Response.json(merged) };
    assert.deepEqual(await resolveReviewSnapshot(request), expected);
  }
  await assert.rejects(resolveReviewSnapshot({ ...options, source: 'automatic', baseSha, headSha: 'c'.repeat(40),
    fetchImpl: async () => Response.json(merged) }), /stale/);
});

test('A closed but unmerged PR is still rejected; closed state alone never admits it', async () => {
  for (const merged of [false, undefined]) {
    await assert.rejects(resolveReviewSnapshot({ ...options,
      fetchImpl: async () => Response.json({ ...pullRequest, state: 'closed', merged }) }), /eligible/);
  }
});
