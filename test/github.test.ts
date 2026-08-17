import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { publishGitHubReview, validatePullRequestReview } from '../src/github.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

test('trusted publisher rejects undeclared review fields', () => {
  assert.throws(() => validatePullRequestReview({
    body: 'Review findings',
    comments: [{ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'Problem', position: 99 }],
  }), /Invalid pull request review/);
});

test('trusted publisher accepts a clean overview without inline comments', () => {
  assert.deepEqual(validatePullRequestReview({
    body: '## ✅ Agentic Review\n\n未发现需要处理的问题。',
    comments: [],
  }).comments, []);
});

test('trusted publisher revalidates the current head before posting', async () => {
  const context = await mkdtemp(path.join(tmpdir(), 'agentic-review-publish-'));
  await writeFile(`${context}/changed-files.txt`, 'src/a.ts\n');
  await writeFile(`${context}/pr.diff`, 'diff --git a/src/a.ts b/src/a.ts\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+const value = 1;\n');
  Object.assign(process.env, {
    GITHUB_TOKEN: 'token',
    GITHUB_REPOSITORY: 'Qiyin-Tech/example',
    REVIEW_PULL_NUMBER: '7',
    REVIEW_HEAD_SHA: 'head',
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (!init?.method) return Response.json({ head: { sha: 'head' } });
    return Response.json({ html_url: 'https://github.com/review/1' });
  };

  try {
    const message = await publishGitHubReview(context, {
      body: 'Review findings',
      comments: [{ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'Problem' }],
    });
    assert.equal(message, 'Review created: https://github.com/review/1');
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.url, /\/pulls\/7$/);
    assert.match(calls[1]!.url, /\/pulls\/7\/reviews$/);
    assert.equal(JSON.parse(String(calls[1]!.init?.body)).commit_id, 'head');
  } finally {
    await rm(context, { recursive: true });
  }
});

test('trusted publisher rejects a stale review without posting', async () => {
  const context = await mkdtemp(path.join(tmpdir(), 'agentic-review-stale-'));
  await writeFile(`${context}/changed-files.txt`, 'src/a.ts\n');
  await writeFile(`${context}/pr.diff`, 'diff --git a/src/a.ts b/src/a.ts\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+const value = 1;\n');
  Object.assign(process.env, {
    GITHUB_TOKEN: 'token',
    GITHUB_REPOSITORY: 'Qiyin-Tech/example',
    REVIEW_PULL_NUMBER: '7',
    REVIEW_HEAD_SHA: 'old',
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ head: { sha: 'new' } });
  };

  try {
    await assert.rejects(
      publishGitHubReview(context, {
        body: 'Review findings',
        comments: [{ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'Problem' }],
      }),
      /stale review head/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(context, { recursive: true });
  }
});
