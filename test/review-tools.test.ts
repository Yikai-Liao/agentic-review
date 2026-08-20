import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import reviewTools from '../.github/pi-extensions/review-tools.ts';
// @ts-expect-error The trusted publisher is plain Node.js so the workflow needs no runtime dependency.
import { parseUpdates, publishThreadUpdates } from '../scripts/publish-thread-updates.mjs';

test('queues a validated historical thread update without a GitHub token', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-tools-'));
  const originalEnv = { ...process.env };
  try {
    const updatesPath = path.join(directory, 'updates.ndjson');
    await writeFile(
      path.join(directory, 'threads.ndjson'),
      `${JSON.stringify({ id: 'thread-id', isResolved: true, rootCommentId: 123 })}\n`,
    );
    await writeFile(
      path.join(directory, 'review-comments.ndjson'),
      `${JSON.stringify({ id: 123, inReplyToId: null, body: 'original finding' })}\n`,
    );
    Object.assign(process.env, {
      REVIEW_DISCUSSION_PATH: directory,
      REVIEW_THREAD_UPDATES_PATH: updatesPath,
    });
    delete process.env.INPUT_GITHUB_TOKEN;

    let tool: any;
    reviewTools({ registerTool: (definition) => { tool = definition; } });
    const result = await tool.execute(
      'call',
      { root_comment_id: 123, status: 'reintroduced', evidence: '当前改动重新开放了原触发路径。' },
      undefined,
      undefined,
      {},
    );

    assert.deepEqual(parseUpdates(await readFile(updatesPath, 'utf8')), [{
      root_comment_id: 123,
      status: 'reintroduced',
      evidence: '当前改动重新开放了原触发路径。',
    }]);
    assert.deepEqual(result.details, { status: 'reintroduced', queued: true });
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('trusted publisher replies and reopens a resolved thread', async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const comments: Array<{
    id: number;
    in_reply_to_id: number | null;
    body: string;
    user: { login: string };
  }> = [{
    id: 123,
    in_reply_to_id: null,
    body: 'original finding',
    user: { login: 'review-app[bot]' },
  }];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? '');
    requests.push({ url, body });
    if (url.includes('/comments?')) {
      return Response.json(comments);
    }
    if (url.endsWith('/graphql') && body.includes('reviewThreads')) {
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{
                  id: 'thread-id',
                  isResolved: true,
                  comments: { nodes: [{ databaseId: 123 }] },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    }
    if (url.endsWith('/comments/123/replies')) {
      return Response.json({ html_url: 'https://github.test/thread#reply' });
    }
    return Response.json({
      data: { unresolveReviewThread: { thread: { id: 'thread-id', isResolved: false } } },
    });
  };

  const urls = await publishThreadUpdates({
    updates: [{ root_comment_id: 123, status: 'reintroduced', evidence: '当前改动重新开放了原触发路径。' }],
    repository: 'owner/repo',
    pullNumber: 7,
    botLogin: 'review-app[bot]',
    token: 'write-token',
    api: 'https://api.github.test',
    fetchImpl,
  });

  assert.deepEqual(urls, ['https://github.test/thread#reply']);
  assert.match(requests.find(({ url }) => url.endsWith('/comments/123/replies'))!.body, /问题重现/);
  assert.match(requests.at(-1)!.body, /unresolveReviewThread/);

  await assert.rejects(
    publishThreadUpdates({
      updates: [{ root_comment_id: 123, status: 'severity_increased', evidence: '尝试更新非本 App 创建的 thread。' }],
      repository: 'owner/repo',
      pullNumber: 7,
      botLogin: 'another-app[bot]',
      token: 'write-token',
      api: 'https://api.github.test',
      fetchImpl,
    }),
    /was not created by another-app\[bot\]/,
  );

  comments.push(
    {
      id: 124,
      in_reply_to_id: 123,
      body: '**Pi thread 状态更新：🔁 问题重现**\n\n旧证据',
      user: { login: 'review-app[bot]' },
    },
    {
      id: 125,
      in_reply_to_id: 123,
      body: '人工补充回复',
      user: { login: 'maintainer' },
    },
  );
  await assert.rejects(
    publishThreadUpdates({
      updates: [{ root_comment_id: 123, status: 'reintroduced', evidence: '不得因人工回复而重复同一状态。' }],
      repository: 'owner/repo',
      pullNumber: 7,
      botLogin: 'review-app[bot]',
      token: 'write-token',
      api: 'https://api.github.test',
      fetchImpl,
    }),
    /status has not changed/,
  );
});

test('trusted publisher replies before resolving a fixed thread', async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? '');
    requests.push({ url, body });
    if (url.includes('/comments?')) {
      return Response.json([{
        id: 456,
        in_reply_to_id: null,
        body: 'original finding',
        user: { login: 'review-app[bot]' },
      }]);
    }
    if (url.endsWith('/graphql') && body.includes('reviewThreads')) {
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{
                  id: 'fixed-thread',
                  isResolved: false,
                  comments: { nodes: [{ databaseId: 456 }] },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    }
    if (url.endsWith('/comments/456/replies')) {
      return Response.json({ html_url: 'https://github.test/thread#fixed' });
    }
    return Response.json({
      data: { resolveReviewThread: { thread: { id: 'fixed-thread', isResolved: true } } },
    });
  };

  await publishThreadUpdates({
    updates: [{ root_comment_id: 456, status: 'suggest_resolve', evidence: '已将 GitHub 写操作移到 Pi 结束后的可信步骤。' }],
    repository: 'owner/repo',
    pullNumber: 7,
    botLogin: 'review-app[bot]',
    token: 'write-token',
    api: 'https://api.github.test',
    fetchImpl,
  });

  assert.ok(requests.findIndex(({ url }) => url.endsWith('/comments/456/replies')) < requests.length - 1);
  assert.match(requests.at(-1)!.body, /resolveReviewThread/);
});

test('rejects inherited status names before publication', () => {
  assert.throws(
    () => parseUpdates('{"root_comment_id":123,"status":"__proto__","evidence":"足够长的恶意状态说明"}\n'),
    /Invalid thread status/,
  );
});
