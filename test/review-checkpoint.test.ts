import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  findReviewCheckpoint,
  findReviewCheckpointSafely,
  findReviewWorkspaceArtifact,
  findReviewWorkspaceArtifactSafely,
  main,
} from '../scripts/find-review-checkpoint.ts';
import { findLatestReviewWorkspace } from '../scripts/find-review-request.ts';

const current = 'c'.repeat(40);
const cancelled = 'b'.repeat(40);
const reviewed = 'a'.repeat(40);
const base = 'd'.repeat(40);

function check(headSha: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'Agentic Review / audit',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    externalId: `1:7:${base}:${headSha}:automatic:99:1`,
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
            check(reviewed, { externalId: `1:8:${base}:${reviewed}:automatic:98:1` }),
            check(reviewed, { externalId: `1:7:${'e'.repeat(40)}:${reviewed}:automatic:98:1` }),
            check(reviewed),
          ]),
        },
      },
    });
  };

  assert.deepEqual(await find(fetchImpl as typeof fetch), { headSha: reviewed, runId: '99:1' });
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
  }), { headSha: commits.at(-1), runId: '99:1' });
  assert.equal(requests, 2);
});

test('returns no checkpoint when no successful review exists', async () => {
  assert.equal(await find(async () => Response.json({
    data: {
      repository: {
        c0: commit(current),
        c1: commit(cancelled),
        c2: commit(reviewed, [check(reviewed, { externalId: `1:7:${'e'.repeat(40)}:${reviewed}:automatic:99:1` })]),
      },
    },
  })), null);
});

test('A merged fix keeps the trusted review baseline, while conflict resolutions still enter the incremental diff', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-checkpoint-'));
  const originalEnv = { ...process.env };
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git('init', '-b', 'review');
    git('config', 'user.name', 'Review Test');
    git('config', 'user.email', 'review@example.test');
    git('config', 'commit.gpgsign', 'false');
    const source = path.join(directory, 'limit.ts');
    const commitSource = (value: number) => {
      writeFileSync(source, `export const limit = ${value};\n`);
      git('add', 'limit.ts');
      git('commit', '-m', `Set limit ${value}`);
      return git('rev-parse', 'HEAD');
    };
    const baseSha = commitSource(1);
    // A reviewed commit on the same base that is not merged into the current head must not become a candidate.
    git('checkout', '-b', 'unmerged');
    const unrelatedSha = commitSource(99);
    git('checkout', 'review');
    const reviewedSha = commitSource(2);
    git('checkout', '-b', 'fix');
    commitSource(3);
    git('checkout', 'review');
    git('merge', '--no-ff', 'fix', '-m', 'Merge small fix');
    const mergedSha = git('rev-parse', 'HEAD');

    git('checkout', '-b', 'conflicting-fix');
    commitSource(4);
    git('checkout', 'review');
    commitSource(5);
    assert.throws(() => git('merge', '--no-ff', 'conflicting-fix', '-m', 'Merge conflicting fix'));
    const resolvedSha = commitSource(6);
    let expired = false;
    let reviewedBase = baseSha;
    const queried = new Set<string>();
    const artifactRequests: string[] = [];
    Object.assign(process.env, {
      REVIEW_TARGET_PATH: directory, REPOSITORY: 'owner/repo', REPOSITORY_ID: '1',
      PULL_NUMBER: '7', BASE_SHA: baseSha, REVIEW_APP_SLUG: 'review-app', GH_TOKEN: 'read-token',
      CONTROL_REPOSITORY: 'control/review', CONTROL_TOKEN: 'control-token',
      GITHUB_GRAPHQL_URL: 'https://api.github.test/graphql', GITHUB_API_URL: 'https://api.github.test',
    });
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === process.env.GITHUB_GRAPHQL_URL) {
        const { variables } = JSON.parse(String(init?.body)) as { variables: Record<string, string> };
        const repository = Object.fromEntries(Object.entries(variables)
          .filter(([key]) => key.startsWith('oid'))
          .map(([key, sha]) => {
            queried.add(sha);
            return [key.replace('oid', 'c'), commit(sha, [reviewedSha, unrelatedSha].includes(sha)
              ? [check(sha, { externalId: `1:7:${reviewedBase}:${sha}:automatic:99:1` })] : [])];
          }));
        return Response.json({ data: { repository } });
      }
      artifactRequests.push(String(input));
      return Response.json({ artifacts: [{ id: 3, name: 'review-completed-workspace-1-7-automatic-99-1', expired }] });
    });
    const resolve = async (headSha: string) => {
      process.env.HEAD_SHA = headSha;
      return main();
    };

    for (const [name, headSha, value] of [
      ['plain merge', mergedSha, 3], ['conflict resolution', resolvedSha, 6],
    ] as const) {
      await t.test(name, async () => {
        assert.deepEqual(await resolve(headSha), { headSha: reviewedSha, runId: '99', runAttempt: '1', artifactId: '3' });
        const focus = git('diff', `${reviewedSha}..${headSha}`, '--', 'limit.ts');
        assert.ok(focus.includes(`+export const limit = ${value};`));
      });
    }
    assert.ok(queried.has(reviewedSha));
    assert.ok(!queried.has(unrelatedSha));
    assert.deepEqual(artifactRequests, Array(2).fill('https://api.github.test/repos/control/review/actions/runs/99/artifacts?per_page=100'));

    await t.test('A stale working draft is not adopted as baseline', async () => {
      expired = true;
      assert.equal(await resolve(resolvedSha), null);
    });
    await t.test('Completion records from a different base are not reused', async () => {
      expired = false;
      reviewedBase = 'e'.repeat(40);
      artifactRequests.length = 0;
      assert.equal(await resolve(resolvedSha), null);
      assert.deepEqual(artifactRequests, []);
    });
  } finally {
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('finds the unexpired workspace artifact for the reviewed run', async () => {
  const requested: string[] = [];
  const artifactId = await findReviewWorkspaceArtifact({
    repository: 'control/review',
    repositoryId: '1',
    pullNumber: '7',
    source: 'automatic',
    runId: '99',
    runAttempt: '1',
    token: 'control-token',
    api: 'https://api.github.test',
    fetchImpl: (async (input: string | URL | Request) => {
      requested.push(String(input));
      return Response.json({
        artifacts: [
          { id: 1, name: 'review-workspace-98', expired: false },
          { id: 2, name: 'review-workspace-99', expired: true },
          { id: 3, name: 'review-completed-workspace-1-7-automatic-99-1', expired: false },
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
    repositoryId: '1',
    pullNumber: '7',
    source: 'automatic',
    runId: '99',
    runAttempt: '1',
    token: 'control-token',
    fetchImpl: (async () => Response.json({
      artifacts: [{ id: 2, name: 'review-completed-workspace-1-7-automatic-99-1', expired: true }],
    })) as typeof fetch,
  }), null);
});

test('discards incremental context when workspace lookup fails', async () => {
  const warnings: string[] = [];
  assert.equal(await findReviewWorkspaceArtifactSafely({
    repository: 'control/review',
    repositoryId: '1',
    pullNumber: '7',
    source: 'automatic',
    runId: '99',
    runAttempt: '1',
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

test('finds the newest PR workspace artifact independently of the current commit history', async () => {
  const pages: string[] = [];
  const found = await findLatestReviewWorkspace({
    repositoryId: '1', pullNumber: '7', controlRepository: 'control/review', token: 'token', currentRun: '300:2', api: 'https://api.github.test',
    fetchImpl: (async (input: string | URL | Request) => {
      pages.push(String(input));
      return Response.json({ artifacts: [
        { id: 10, name: 'review-workspace-1-7-pr_comment-100-1', expired: false, created_at: '2026-01-01T00:00:00Z' },
        { id: 11, name: 'review-completed-workspace-1-7-automatic-300-2', expired: false, created_at: '2026-01-02T00:00:00Z' },
        { id: 12, name: 'review-workspace-1-7-thread-400-1', expired: false, created_at: '2026-01-03T00:00:00Z' },
      ] });
    }) as typeof fetch,
  });
  assert.deepEqual(found, { artifactId: '10', runId: '100', runAttempt: '1', source: 'pr_comment', published: false, createdAt: '2026-01-01T00:00:00Z' });
  assert.deepEqual(pages, ['https://api.github.test/repos/control/review/actions/artifacts?per_page=100&page=1']);
});
