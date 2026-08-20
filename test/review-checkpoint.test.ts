import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error The workflow helper is plain Node.js so it needs no build step.
import { findReviewCheckpoint } from '../scripts/find-review-checkpoint.mjs';
// @ts-expect-error The workflow helper is plain Node.js so it needs no build step.
import { finalizeReviewFocus } from '../scripts/finalize-review-focus.mjs';

const current = 'c'.repeat(40);
const cancelled = 'b'.repeat(40);
const reviewed = 'a'.repeat(40);
const base = 'd'.repeat(40);

function check(headSha: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'Agentic Review / audit',
    app: { slug: 'review-app' },
    status: 'completed',
    conclusion: 'success',
    head_sha: headSha,
    external_id: `1:7:${base}:${headSha}:99`,
    ...overrides,
  };
}

async function find(fetchImpl: typeof fetch) {
  return findReviewCheckpoint({
    commits: [current, cancelled, reviewed],
    repository: 'owner/repo',
    repositoryId: '1',
    pullNumber: '7',
    baseSha: base,
    appSlug: 'review-app',
    token: 'read-token',
    api: 'https://api.github.test',
    fetchImpl,
  });
}

test('uses only the newest successful check from this app and pull request', async () => {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const sha = /commits\/([0-9a-f]{40})\/check-runs/.exec(url)![1];
    const checkRuns = sha === current
      ? [check(current, { app: { slug: 'another-app' } })]
      : sha === cancelled
        ? [check(cancelled, { conclusion: 'neutral' })]
        : [
          check(reviewed, { external_id: `1:8:${base}:${reviewed}:98` }),
          check(reviewed, { external_id: `1:7:${'e'.repeat(40)}:${reviewed}:98` }),
          check(reviewed),
        ];
    return Response.json({ check_runs: checkRuns });
  };

  assert.equal(await find(fetchImpl as typeof fetch), reviewed);
  assert.equal(requested.length, 3);
  assert.equal(new URL(requested[0]).searchParams.get('check_name'), 'Agentic Review / audit');
});

test('returns no checkpoint when no successful review exists', async () => {
  assert.equal(await find(async () => Response.json({ check_runs: [] })), null);
  assert.equal(await find(async (input) => {
    const sha = /commits\/([0-9a-f]{40})\/check-runs/.exec(String(input))![1];
    return Response.json({ check_runs: [check(sha, { external_id: `1:7:${'e'.repeat(40)}:${sha}:99` })] });
  }), null);
  await assert.rejects(find(async () => new Response(null, { status: 500 })), /check lookup failed: 500/);
});

test('keeps only a distinct non-empty focus diff', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-focus-'));
  const fullDiffPath = path.join(directory, 'full.diff');
  const focusDiffPath = path.join(directory, 'focus.diff');
  try {
    await writeFile(fullDiffPath, 'full');
    assert.equal(await finalizeReviewFocus({ checkpointHead: '', fullDiffPath, focusDiffPath }), 'initial');

    await writeFile(`${focusDiffPath}.tmp`, '');
    assert.equal(await finalizeReviewFocus({ checkpointHead: reviewed, fullDiffPath, focusDiffPath }), 'incremental_unchanged');

    await writeFile(`${focusDiffPath}.tmp`, 'full');
    assert.equal(await finalizeReviewFocus({ checkpointHead: reviewed, fullDiffPath, focusDiffPath }), 'incremental_all');

    await writeFile(`${focusDiffPath}.tmp`, 'focus');
    assert.equal(await finalizeReviewFocus({ checkpointHead: reviewed, fullDiffPath, focusDiffPath }), 'incremental');
    assert.equal(await readFile(focusDiffPath, 'utf8'), 'focus');
    await access(focusDiffPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
