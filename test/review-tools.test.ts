import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import reviewTools from '../.github/pi-extensions/review-tools.ts';
import { buildFooter, parseReviewResult, publishReview } from '../scripts/publish-review.ts';

const headSha = 'b'.repeat(40);
const result = {
  body: '## Review 总结\n\n这个 PR 修复了清理行为。',
  comments: [{ path: 'src/gc.ts', line: 42, start_line: 40, body: '**[P1] 仍会误删**\n\n详细证据。' }],
  thread_updates: [{
    root_comment_id: 123,
    status: 'resolved' as const,
    evidence: '当前实现已经恢复 owner token 检查。',
  }],
};

type ReviewComment = {
  id: number;
  in_reply_to_id: number | null;
  body: string;
  user: { login: string };
};

function publisherFetch({
  comments = [{ id: 123, in_reply_to_id: null, body: 'original finding', user: { login: 'review-app[bot]' } }] as ReviewComment[],
  isResolved = false,
}: {
  comments?: ReviewComment[];
  isResolved?: boolean;
} = {}) {
  const requests: Array<{ url: string; body: string }> = [];
  return {
    requests,
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = String(init?.body ?? '');
      requests.push({ url, body });
      if (url.includes('/comments?')) return Response.json(comments);
      if (url.endsWith('/graphql') && body.includes('reviewThreads')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{ id: 'thread-id', comments: { nodes: [{ databaseId: 123 }] } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }
      if (url.endsWith('/graphql') && body.includes('query($thread:ID!)')) {
        return Response.json({ data: { node: { id: 'thread-id', isResolved } } });
      }
      if (url.endsWith('/comments/123/replies')) return Response.json({ html_url: 'https://github.test/thread#reply' });
      if (url.endsWith('/pulls/7/reviews')) return Response.json({ html_url: 'https://github.test/review/1' });
      return Response.json({ data: {} });
    },
  };
}

async function publish(reviewResult: Parameters<typeof publishReview>[0]['result'], fetchImpl: typeof fetch) {
  return publishReview({
    result: reviewResult,
    repository: 'owner/repo',
    pullNumber: 7,
    botLogin: 'review-app[bot]',
    token: 'write-token',
    expectedHeadSha: headSha,
    footer: '[View action run](https://github.test/run) | Model: openai/test',
    api: 'https://api.github.test',
    fetchImpl,
  });
}

test('submit_review seals one JSON file from the review workspace', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-tools-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    const sourcePath = path.join(workspace, 'final.json');
    const resultPath = path.join(directory, 'review-result.json');
    await mkdir(workspace);
    await writeFile(sourcePath, `${JSON.stringify(result)}\n`);
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = resultPath;
    let tool: any;
    reviewTools({ registerTool: (definition) => { tool = definition; } });

    const response = await tool.execute('call', { path: sourcePath });
    assert.deepEqual(parseReviewResult(await readFile(resultPath, 'utf8')), result);
    assert.deepEqual(response.details, { queued: true, source: sourcePath });
    await assert.rejects(tool.execute('call', { path: sourcePath }), /already submitted/);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('submit_review rejects files outside the review workspace', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-tools-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    const outside = path.join(directory, 'outside.json');
    await mkdir(workspace);
    await writeFile(outside, JSON.stringify(result));
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = path.join(directory, 'result.json');
    let tool: any;
    reviewTools({ registerTool: (definition) => { tool = definition; } });
    await assert.rejects(tool.execute('call', { path: outside }), /inside REVIEW_WORKSPACE_PATH/);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('publisher creates one review, updates threads, and appends the footer', async () => {
  const { requests, fetchImpl } = publisherFetch();
  assert.equal(await publish(result, fetchImpl as typeof fetch), 'https://github.test/review/1');

  assert.match(requests.find(({ url }) => url.endsWith('/comments/123/replies'))!.body, /已关闭/);
  assert.match(requests.find(({ body }) => body.includes('resolveReviewThread'))!.body, /resolveReviewThread/);
  const review = JSON.parse(requests.find(({ url }) => url.endsWith('/pulls/7/reviews'))!.body);
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.commit_id, headSha);
  assert.match(review.body, /这个 PR 修复了清理行为。/);
  assert.match(review.body, /View action run/);
  assert.deepEqual(review.comments[0], {
    path: 'src/gc.ts',
    line: 42,
    start_line: 40,
    side: 'RIGHT',
    start_side: 'RIGHT',
    body: '**[P1] 仍会误删**\n\n详细证据。',
  });
});

test('publisher reopens a resolved thread when risk increases', async () => {
  const { requests, fetchImpl } = publisherFetch({ isResolved: true });
  await publish({
    ...result,
    thread_updates: [{ ...result.thread_updates[0], status: 'severity_increased' }],
  }, fetchImpl as typeof fetch);
  assert.match(requests.find(({ body }) => body.includes('unresolveReviewThread'))!.body, /unresolveReviewThread/);
});

test('publisher supports a summary-only review', async () => {
  const { requests, fetchImpl } = publisherFetch();
  const summaryOnly = { body: '未发现需要阻止合并的问题。', comments: [], thread_updates: [] };
  await publish(summaryOnly as typeof result, fetchImpl as typeof fetch);
  assert.equal(requests.some(({ url }) => url.includes('/comments?')), false);
  assert.deepEqual(
    JSON.parse(requests.find(({ url }) => url.endsWith('/pulls/7/reviews'))!.body).comments,
    [],
  );
});

test('publisher rejects a thread owned by another bot', async () => {
  const { requests, fetchImpl } = publisherFetch({
    comments: [{ id: 123, in_reply_to_id: null, body: 'original finding', user: { login: 'other[bot]' } }],
  });
  await assert.rejects(publish(result, fetchImpl as typeof fetch), /was not created by review-app\[bot\]/);
  assert.equal(requests.some(({ url }) => url.endsWith('/pulls/7/reviews')), false);
});

test('publisher keeps an older review available to later serial runs', async () => {
  const { requests, fetchImpl } = publisherFetch();
  await publish(result, fetchImpl as typeof fetch);

  assert.equal(requests.some(({ url }) => url.endsWith('/pulls/7')), false);
  assert.equal(JSON.parse(requests.find(({ url }) => url.endsWith('/pulls/7/reviews'))!.body).commit_id, headSha);
  assert.equal(requests.some(({ url }) => url.endsWith('/comments/123/replies')), true);
  assert.equal(requests.some(({ body }) => body.includes('resolveReviewThread')), true);
});

test('parser rejects duplicate thread updates and invalid comment locations', () => {
  assert.throws(
    () => parseReviewResult(JSON.stringify({ ...result, thread_updates: [result.thread_updates[0], result.thread_updates[0]] })),
    /Duplicate thread update/,
  );
  assert.throws(
    () => parseReviewResult(JSON.stringify({ ...result, comments: [{ ...result.comments[0], start_line: 43 }] })),
    /start_line/,
  );
  assert.throws(
    () => parseReviewResult(JSON.stringify({ ...result, comments: [{ ...result.comments[0], path: '../secret' }] })),
    /path/,
  );
});

test('footer preserves action metadata', () => {
  assert.equal(
    buildFooter({
      runUrl: 'https://github.test/run',
      workspaceUrl: 'https://github.test/artifact/1',
      model: 'openai/gpt-test',
      thinkingLevel: 'high',
      durationSeconds: 175,
      inputTokens: 700_000,
      outputTokens: 15_300,
      cost: 0,
      piVersion: '0.82.1',
      actionVersion: '2.27.0',
    }),
    '[View action run](https://github.test/run) | [审查工作稿](https://github.test/artifact/1) | Model: openai/gpt-test (thinking: high) | Time: 2m 55s | Tokens: 715.3K | Pi SDK v0.82.1 | Action v2.27.0',
  );
});
