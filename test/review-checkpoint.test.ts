import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  findReviewCheckpoint,
  findReviewCheckpointSafely,
  findReviewWorkspaceArtifact,
  findReviewWorkspaceArtifactSafely,
} from '../scripts/find-review-checkpoint.ts';
// @ts-expect-error The workflow helper is plain Node.js so it needs no build step.
import { finalizeReviewFocus } from '../scripts/finalize-review-focus.mjs';

const current = 'c'.repeat(40);
const cancelled = 'b'.repeat(40);
const reviewed = 'a'.repeat(40);
const base = 'd'.repeat(40);

function check(headSha: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'Agentic Review / audit',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    externalId: `1:7:${base}:${headSha}:99`,
    ...overrides,
  };
}

function commit(headSha: string, runs: Record<string, unknown>[] = [], appSlug = 'review-app') {
  return {
    oid: headSha,
    checkSuites: { nodes: runs.length ? [{ app: { slug: appSlug }, checkRuns: { nodes: runs } }] : [] },
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
    graphql: 'https://api.github.test/graphql',
    fetchImpl,
  });
}

test('finds the newest valid checkpoint in one GraphQL request', async () => {
  const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requested.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json({
      data: {
        repository: {
          c0: commit(current, [check(current)], 'another-app'),
          c1: commit(cancelled, [check(cancelled, { conclusion: 'NEUTRAL' })]),
          c2: commit(reviewed, [
            check(reviewed, { externalId: `1:8:${base}:${reviewed}:98` }),
            check(reviewed, { externalId: `1:7:${'e'.repeat(40)}:${reviewed}:98` }),
            check(reviewed),
          ]),
        },
      },
    });
  };

  assert.deepEqual(await find(fetchImpl as typeof fetch), { headSha: reviewed, runId: '99' });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, 'https://api.github.test/graphql');
  assert.match(String(requested[0].body.query), /checkSuites/);
  assert.deepEqual(requested[0].body.variables, {
    owner: 'owner', name: 'repo', oid0: current, oid1: cancelled, oid2: reviewed,
  });
});

test('queries at most 100 commits per GraphQL request', async () => {
  const commits = Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(40, '0'));
  let requests = 0;
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    requests += 1;
    const { variables } = JSON.parse(String(init?.body)) as { variables: Record<string, string> };
    const repository = Object.fromEntries(Object.entries(variables)
      .filter(([key]) => key.startsWith('oid'))
      .map(([key, sha]) => [key.replace('oid', 'c'), commit(
        sha,
        sha === commits.at(-1) ? [check(sha)] : [],
      )]));
    return Response.json({ data: { repository } });
  };

  assert.deepEqual(await findReviewCheckpoint({
    commits,
    repository: 'owner/repo',
    repositoryId: '1',
    pullNumber: '7',
    baseSha: base,
    appSlug: 'review-app',
    token: 'read-token',
    fetchImpl: fetchImpl as typeof fetch,
  }), { headSha: commits.at(-1), runId: '99' });
  assert.equal(requests, 2);
});

test('returns no checkpoint when no successful review exists', async () => {
  assert.equal(await find(async () => Response.json({
    data: {
      repository: {
        c0: commit(current),
        c1: commit(cancelled),
        c2: commit(reviewed, [check(reviewed, { externalId: `1:7:${'e'.repeat(40)}:${reviewed}:99` })]),
      },
    },
  })), null);
});

test('finds the unexpired workspace artifact for the reviewed run', async () => {
  const requested: string[] = [];
  const artifactId = await findReviewWorkspaceArtifact({
    repository: 'control/review',
    runId: '99',
    token: 'control-token',
    api: 'https://api.github.test',
    fetchImpl: (async (input: string | URL | Request) => {
      requested.push(String(input));
      return Response.json({
        artifacts: [
          { id: 1, name: 'review-workspace-98', expired: false },
          { id: 2, name: 'review-workspace-99', expired: true },
          { id: 3, name: 'review-workspace-99', expired: false },
        ],
      });
    }) as typeof fetch,
  });

  assert.equal(artifactId, '3');
  assert.deepEqual(requested, ['https://api.github.test/repos/control/review/actions/runs/99/artifacts?per_page=100']);
});

test('returns no workspace artifact when it is unavailable', async () => {
  assert.equal(await findReviewWorkspaceArtifact({
    repository: 'control/review',
    runId: '99',
    token: 'control-token',
    fetchImpl: (async () => Response.json({
      artifacts: [{ id: 2, name: 'review-workspace-99', expired: true }],
    })) as typeof fetch,
  }), null);
});

test('discards incremental context when workspace lookup fails', async () => {
  const warnings: string[] = [];
  assert.equal(await findReviewWorkspaceArtifactSafely({
    repository: 'control/review',
    runId: '99',
    token: 'control-token',
    fetchImpl: async () => new Response(null, { status: 503 }),
  }, (warning: string) => warnings.push(warning)), undefined);
  assert.deepEqual(warnings, ['Previous review workspace lookup skipped: GitHub artifact lookup failed: 503']);
});

test('continues without a checkpoint when GitHub lookup fails', async () => {
  const warnings: string[] = [];
  assert.equal(await findReviewCheckpointSafely({
    commits: [current],
    repository: 'owner/repo',
    repositoryId: '1',
    pullNumber: '7',
    baseSha: base,
    appSlug: 'review-app',
    token: 'read-token',
    fetchImpl: async () => new Response(null, { status: 500 }),
  }, (warning: string) => warnings.push(warning)), null);
  assert.deepEqual(warnings, ['Review checkpoint lookup skipped: GitHub GraphQL checkpoint lookup failed: 500']);
});

test('uses a checkpoint only after the previous workspace is ready', async () => {
  const workflow = await readFile(new URL('../.github/workflows/agentic-review.yml', import.meta.url), 'utf8');
  assert.match(workflow, /id: previous-workspace-download[\s\S]*?continue-on-error: true/);
  assert.match(workflow, /if: steps\.previous-workspace-download\.outcome == 'success'[\s\S]*?checkpoint_head=\$CHECKPOINT_HEAD/);
  assert.match(workflow, /CHECKPOINT_HEAD: \$\{\{ steps\.previous-review-workspace\.outputs\.checkpoint_head \}\}/);
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
