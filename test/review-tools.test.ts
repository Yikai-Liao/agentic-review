import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import reviewTools from '../.github/pi-extensions/review-tools.ts';

test('replies with details and reopens a resolved historical thread', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-tools-'));
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  try {
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
      INPUT_GITHUB_TOKEN: 'token',
      GITHUB_REPOSITORY: 'owner/repo',
      REVIEW_PULL_NUMBER: '7',
      GITHUB_API_URL: 'https://api.github.test',
    });

    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body) });
      return new Response(
        requests.length === 1
          ? JSON.stringify({ html_url: 'https://github.test/thread#reply' })
          : JSON.stringify({ data: { unresolveReviewThread: { thread: { id: 'thread-id', isResolved: false } } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    let tool: any;
    reviewTools({ registerTool: (definition) => { tool = definition; } });
    const result = await tool.execute(
      'call',
      { root_comment_id: 123, status: 'reintroduced', evidence: '当前改动重新开放了原触发路径。' },
      undefined,
      undefined,
      {},
    );

    assert.equal(requests.length, 2);
    assert.match(requests[0]!.url, /comments\/123\/replies$/);
    assert.match(requests[0]!.body, /问题重现/);
    assert.match(requests[1]!.body, /unresolveReviewThread/);
    assert.deepEqual(result.details, {
      status: 'reintroduced',
      reopened: true,
      url: 'https://github.test/thread#reply',
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});
