import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import reviewTools from '../.github/pi-extensions/review-tools.ts';
// @ts-expect-error The trusted publisher is plain Node.js so the workflow needs no runtime dependency.
import { parseUpdates, publishThreadUpdates } from '../scripts/publish-thread-updates.mjs';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const update = {
  root_comment_id: 123,
  status: 'reintroduced',
  evidence: '当前改动重新开放了原触发路径。',
};

type ReviewComment = {
  id: number;
  in_reply_to_id: number | null;
  body: string;
  user: { login: string };
};

function publisherFetch({
  comments = [{ id: 123, in_reply_to_id: null, body: 'original finding', user: { login: 'review-app[bot]' } }] as ReviewComment[],
  isResolved = true,
  currentHead = headSha,
} = {}) {
  const requests: Array<{ url: string; body: string }> = [];
  return {
    requests,
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = String(init?.body ?? '');
      requests.push({ url, body });
      if (url.endsWith('/pulls/7')) return Response.json({ base: { sha: baseSha }, head: { sha: currentHead } });
      if (url.includes('/comments?')) return Response.json(comments);
      if (url.endsWith('/graphql') && body.includes('reviewThreads')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{
                    id: 'thread-id',
                    isResolved,
                    comments: { nodes: [{ databaseId: 123 }] },
                  }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }
      if (url.endsWith('/comments/123/replies')) return Response.json({ html_url: 'https://github.test/thread#reply' });
      return Response.json({ data: {} });
    },
  };
}

async function publish(updates: typeof update[], fetchImpl: typeof fetch) {
  return publishThreadUpdates({
    updates,
    repository: 'owner/repo',
    pullNumber: 7,
    botLogin: 'review-app[bot]',
    token: 'write-token',
    expectedBaseSha: baseSha,
    expectedHeadSha: headSha,
    api: 'https://api.github.test',
    fetchImpl,
  });
}

test('queues one update without a GitHub snapshot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-tools-'));
  const originalEnv = { ...process.env };
  try {
    const updatesPath = path.join(directory, 'updates.ndjson');
    process.env.REVIEW_THREAD_UPDATES_PATH = updatesPath;
    let tool: any;
    reviewTools({ registerTool: (definition) => { tool = definition; } });

    const result = await tool.execute('call', update);
    assert.deepEqual(parseUpdates(await readFile(updatesPath, 'utf8')), [update]);
    assert.deepEqual(result.details, { status: 'reintroduced', queued: true });
    await assert.rejects(tool.execute('call', update), /already updated/);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('publisher replies, reopens, and rejects another bot root', async () => {
  const { requests, fetchImpl } = publisherFetch({
    comments: [
      { id: 123, in_reply_to_id: null, body: 'original finding', user: { login: 'review-app[bot]' } },
      { id: 124, in_reply_to_id: 123, body: '**Pi thread 状态更新：🔁 问题重现**\n\n旧证据', user: { login: 'review-app[bot]' } },
      { id: 125, in_reply_to_id: 123, body: '**Pi thread 状态更新：✅ 建议关闭**\n\n旧证据', user: { login: 'review-app[bot]' } },
    ],
  });
  assert.deepEqual(await publish([update], fetchImpl as typeof fetch), ['https://github.test/thread#reply']);
  assert.match(requests.find(({ url }) => url.endsWith('/comments/123/replies'))!.body, /问题重现/);
  assert.match(requests.at(-1)!.body, /unresolveReviewThread/);

  await assert.rejects(
    publishThreadUpdates({
      updates: [update],
      repository: 'owner/repo',
      pullNumber: 7,
      botLogin: 'another-app[bot]',
      token: 'write-token',
      expectedBaseSha: baseSha,
      expectedHeadSha: headSha,
      api: 'https://api.github.test',
      fetchImpl: fetchImpl as typeof fetch,
    }),
    /was not created by another-app\[bot\]/,
  );
});

test('publisher resolves a fixed thread and retries a missing transition without another reply', async () => {
  const resolved = { ...update, status: 'suggest_resolve' };
  const first = publisherFetch({ isResolved: false });
  await publish([resolved], first.fetchImpl as typeof fetch);
  assert.match(first.requests.at(-1)!.body, /resolveReviewThread/);


  const { requests, fetchImpl } = publisherFetch({
    comments: [
      { id: 123, in_reply_to_id: null, body: 'original finding', user: { login: 'review-app[bot]' } },
      { id: 124, in_reply_to_id: 123, body: '**Pi thread 状态更新：🔁 问题重现**\n\n旧证据', user: { login: 'review-app[bot]' } },
    ],
  });
  assert.deepEqual(await publish([update], fetchImpl as typeof fetch), []);
  assert.equal(requests.some(({ url }) => url.endsWith('/comments/123/replies')), false);
  assert.match(requests.at(-1)!.body, /unresolveReviewThread/);
});

test('publisher rejects a changed PR snapshot', async () => {
  const { requests, fetchImpl } = publisherFetch({ currentHead: 'c'.repeat(40) });
  await assert.rejects(publish([update], fetchImpl as typeof fetch), /changed since review started/);
  assert.equal(requests.some(({ url }) => url.endsWith('/comments/123/replies')), false);
});

test('rejects inherited status names before publication', () => {
  assert.throws(
    () => parseUpdates('{"root_comment_id":123,"status":"__proto__","evidence":"足够长的恶意状态说明"}\n'),
    /Invalid thread status/,
  );
});
