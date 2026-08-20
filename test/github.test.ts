import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { collectDiffSideLines } from '../src/diff.ts';
import { addDiffContext, buildPullRequestReview, publishGitHubReview, validatePullRequestReview } from '../src/github.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

test('trusted publisher rejects undeclared review fields', () => {
  assert.throws(() => validatePullRequestReview({
    body: '## ⚠️ Agentic Review\n\n发现问题。',
    comments: [{ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'Problem', position: 99 }],
  }), /Invalid pull request review/);
});

test('trusted publisher requires an Agentic Review overview', () => {
  assert.deepEqual(validatePullRequestReview({
    body: '## ✅ Agentic Review\n\n未发现需要处理的问题。',
    comments: [],
  }).comments, []);
  assert.throws(() => validatePullRequestReview({ body: '', comments: [] }), /Invalid pull request review/);
  assert.throws(() => validatePullRequestReview({ body: 'No issues.', comments: [] }), /Invalid pull request review/);
  assert.throws(() => validatePullRequestReview({ body: '## ✅ Agentic Review\n   ', comments: [] }), /overview/);
  assert.equal(validatePullRequestReview({
    body: '## ⚠️ Agentic Review\n\n发现问题。',
    comments: Array.from({ length: 31 }, (_, index) => ({ path: `src/${index}.ts`, line: 1, side: 'RIGHT', body: 'Problem' })),
  }).comments.length, 31);
});

test('deterministic Review preserves overview, notes, failures, and every finding field', () => {
  const finding = {
    category: 'authorization',
    path: 'src/a.ts',
    side: 'RIGHT' as const,
    startLine: 1,
    endLine: 1,
    title: '租户过滤被移除',
    evidence: '查询不再使用 tenantId。',
    trigger: '租户 A 查询资源。',
    baseBehavior: '只查询租户 A。',
    headBehavior: '查询所有租户。',
    violatedConstraint: '租户数据必须隔离。',
    impact: '跨租户数据泄漏。',
    suggestedSeverity: 'P1' as const,
  };
  const expected = { overview: '本 PR 调整资源查询。', notes: ['[BUG-7] 相关路径变化但当前行为不变。'], findingGroups: [[finding]], failedReviewers: ['test-quality'] };
  const review = buildPullRequestReview(expected);
  assert.match(review.body, /^## ⚠️ Agentic Review/);
  assert.match(review.body, /本 PR 调整资源查询。/);
  assert.match(review.body, /\[BUG-7\] 相关路径变化但当前行为不变。/);
  assert.match(review.body, /`test-quality` 执行失败，审查范围不完整。/);
  assert.equal(review.comments.length, 1);
  assert.deepEqual(
    { path: review.comments[0]!.path, side: review.comments[0]!.side, startLine: review.comments[0]!.startLine, line: review.comments[0]!.line },
    { path: 'src/a.ts', side: 'RIGHT', startLine: undefined, line: 1 },
  );
  assert.match(review.comments[0]!.body, /\*\*P1 · 租户过滤被移除\*\*/);
  assert.match(review.comments[0]!.body, /\*\*类别：\*\* authorization/);
  assert.match(review.comments[0]!.body, /\*\*证据：\*\* 查询不再使用 tenantId。/);
  assert.match(review.comments[0]!.body, /\*\*触发条件：\*\* 租户 A 查询资源。/);
  assert.match(review.comments[0]!.body, /\*\*Base：\*\* 只查询租户 A。/);
  assert.match(review.comments[0]!.body, /\*\*Head：\*\* 查询所有租户。/);
  assert.match(review.comments[0]!.body, /\*\*违反约束：\*\* 租户数据必须隔离。/);
  assert.match(review.comments[0]!.body, /\*\*影响：\*\* 跨租户数据泄漏。/);
});

test('final Review expands real RIGHT context while LEFT stays on deleted lines', () => {
  const lines = collectDiffSideLines([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -8,3 +8,3 @@',
    ' context-before',
    '-old',
    '+new',
    ' context-after',
  ].join('\n'));
  const expanded = addDiffContext({
    body: '## ⚠️ Agentic Review\n\n发现问题。',
    comments: [
      { path: 'src/a.ts', line: 9, side: 'RIGHT', body: 'Added problem' },
      { path: 'src/a.ts', line: 9, side: 'LEFT', body: 'Deleted guard' },
    ],
  }, lines);
  assert.deepEqual(expanded.comments[0], { path: 'src/a.ts', startLine: 8, line: 10, side: 'RIGHT', body: 'Added problem' });
  assert.deepEqual(expanded.comments[1], { path: 'src/a.ts', line: 9, side: 'LEFT', body: 'Deleted guard' });
});

test('trusted publisher revalidates the current head before posting', async () => {
  const context = await mkdtemp(path.join(tmpdir(), 'agentic-review-publish-'));
  await writeFile(`${context}/changed-files.txt`, 'src/a.ts\n');
  await writeFile(`${context}/pr.diff`, 'diff --git a/src/a.ts b/src/a.ts\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+const value = 1;\n');
  Object.assign(process.env, {
    TARGET_REPOSITORY_TOKEN: 'token',
    GITHUB_TOKEN: 'legacy',
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
      body: '## ⚠️ Agentic Review\n\n发现问题。',
      comments: [{ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'Problem' }],
    });
    assert.equal(message, 'Review created: https://github.com/review/1');
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.url, /\/pulls\/7$/);
    assert.match(calls[1]!.url, /\/pulls\/7\/reviews$/);
    assert.equal((calls[1]!.init?.headers as Record<string, string>).Authorization, 'Bearer token');
    assert.equal(JSON.parse(String(calls[1]!.init?.body)).commit_id, 'head');
  } finally {
    await rm(context, { recursive: true });
  }
});

test('trusted publisher posts deleted-line ranges on the LEFT side', async () => {
  const context = await mkdtemp(path.join(tmpdir(), 'agentic-review-left-'));
  await writeFile(`${context}/changed-files.txt`, 'src/deleted.ts\n');
  await writeFile(`${context}/pr.diff`, 'diff --git a/src/deleted.ts b/src/deleted.ts\ndeleted file mode 100644\n--- a/src/deleted.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-guard();\n-authorize();\n');
  Object.assign(process.env, {
    TARGET_REPOSITORY_TOKEN: '',
    GITHUB_TOKEN: 'legacy',
    GITHUB_REPOSITORY: 'Qiyin-Tech/example',
    REVIEW_PULL_NUMBER: '7',
    REVIEW_HEAD_SHA: 'head',
  });
  let posted: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    if (!init?.method) return Response.json({ head: { sha: 'head' } });
    posted = JSON.parse(String(init.body));
    return Response.json({ html_url: 'https://github.com/review/left' });
  };
  try {
    await publishGitHubReview(context, {
      body: '## ⚠️ Agentic Review\n\n删除了保护。',
      comments: [{ path: 'src/deleted.ts', startLine: 1, line: 2, side: 'LEFT', body: 'Problem' }],
    });
    assert.deepEqual((posted!.comments as unknown[])[0], {
      path: 'src/deleted.ts', start_line: 1, start_side: 'LEFT', line: 2, side: 'LEFT', body: 'Problem',
    });
  } finally {
    await rm(context, { recursive: true });
  }
});

test('trusted publisher rejects a stale review without posting', async () => {
  const context = await mkdtemp(path.join(tmpdir(), 'agentic-review-stale-'));
  await writeFile(`${context}/changed-files.txt`, 'src/a.ts\n');
  await writeFile(`${context}/pr.diff`, 'diff --git a/src/a.ts b/src/a.ts\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+const value = 1;\n');
  Object.assign(process.env, {
    TARGET_REPOSITORY_TOKEN: 'token',
    GITHUB_TOKEN: '',
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
        body: '## ⚠️ Agentic Review\n\n发现问题。',
        comments: [{ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'Problem' }],
      }),
      /stale review head/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(context, { recursive: true });
  }
});
