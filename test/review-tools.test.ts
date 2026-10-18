import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import reviewTools from '../.github/pi-extensions/review-tools.ts';
import { buildFooter, publishReview } from '../scripts/publish-review.ts';

import { inventoryDigest } from '../scripts/review-coverage.ts';
import { buildReviewRequest } from '../scripts/review-request.ts';
import { parseReviewResult } from '../scripts/review-result.ts';

const headSha = 'b'.repeat(40);
async function assertSubmissionFailed(response: Promise<any>, error: RegExp) {
  const failure = await response;
  assert.equal(failure.details.queued, false);
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, error);
}
const result = {
  body: '## Review 总结\n\n这个 PR 修复了清理行为。',
  comments: [{ path: 'src/gc.ts', line: 42, start_line: 40, body: '**[P1] 仍会误删**\n\n详细证据。' }],
  thread_updates: [{
    root_comment_id: 123,
    status: 'resolved' as const,
    evidence: '当前实现已经恢复 owner token 检查。',
  }],
  request_reply: null,
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
      if (url.includes('/reviews?')) return Response.json([]);
      if (url.endsWith('/pulls/7/comments')) return Response.json({ html_url: 'https://github.test/comment/1' });
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
      if (body.includes('unresolveReviewThread')) return Response.json({ data: { unresolveReviewThread: { thread: { id: 'thread-id' } } } });
      if (body.includes('resolveReviewThread')) return Response.json({ data: { resolveReviewThread: { thread: { id: 'thread-id' } } } });
      throw new Error(`Unexpected request: ${url} ${body}`);
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
    publicationId: 'run-1',
    api: 'https://api.github.test',
    fetchImpl,
  });
}

async function configureProgress(directory: string, source: 'automatic' | 'pr_comment' | 'thread' = 'automatic') {
  const request = buildReviewRequest({ source, commentId: source === 'automatic' ? '' : '8', rootCommentId: source === 'automatic' ? '' : '8',
    text: '审查请求\r\n保留换行', repository: 'owner/repo', pullNumber: 7, baseSha: 'a'.repeat(40), headSha, runId: '99' });
  process.env.REVIEW_CONTEXT_PATH = path.join(directory, 'review-context.json');
  process.env.REVIEW_PROGRESS_PATH = path.join(directory, 'workspace', 'review-progress.json');
  process.env.REVIEW_INVENTORY_DIGEST = inventoryDigest([]);
  await writeFile(process.env.REVIEW_CONTEXT_PATH, JSON.stringify({ request }));
  await writeFile(process.env.REVIEW_PROGRESS_PATH, JSON.stringify({ ledger: [], scope: {
    mode: 'full', rationale: '完整审查', explicit_text: '',
    ranges: [{ targets: ['complete pull request'], comparison_start: request.comparison_start, comparison_end: request.head_sha }],
  } }));
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
    await configureProgress(directory);
    let tool: any;
    reviewTools({ registerTool: (definition) => { tool = definition; } });

    const response = await tool.execute('call', { path: sourcePath });
    assert.deepEqual(parseReviewResult(await readFile(resultPath, 'utf8')), result);
    assert.deepEqual(response.details, { queued: true, source: sourcePath });
    await assertSubmissionFailed(tool.execute('call', { path: sourcePath }), /already submitted/);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('scope and submission need only model decisions, not machine identity or duplicated batch lists', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-scope-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    await configureProgress(directory, 'pr_comment');
    const progressPath = process.env.REVIEW_PROGRESS_PATH!;
    const originalContext = await readFile(process.env.REVIEW_CONTEXT_PATH!, 'utf8');
    await writeFile(progressPath, JSON.stringify({ ledger: [{ path: 'src/auth.ts', status: 'pending', batches: [] }] }));
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = path.join(directory, 'result.json');
    const tools = new Map<string, any>();
    reviewTools({ registerTool: (definition) => tools.set(definition.name, definition) });
    const resultPath = path.join(workspace, 'result.json');
    const summary = { body: '总结', comments: [], thread_updates: [], request_reply: null };
    await writeFile(resultPath, JSON.stringify(summary));
    await assertSubmissionFailed(tools.get('submit_review').execute('call', { path: resultPath }), /scope must be recorded/);
    await tools.get('set_review_scope').execute('call', {
      mode: 'focused', rationale: '用户明确限定鉴权链路。', explicit_text: '只看 auth',
      ranges: [{ targets: ['src/auth/**'], comparison_start: 'a'.repeat(40), comparison_end: 'b'.repeat(40) }],
    });
    const saved = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['ledger', 'scope']);
    assert.deepEqual(Object.keys(saved.scope).sort(), ['explicit_text', 'mode', 'ranges', 'rationale']);
    assert.deepEqual(saved.ledger, [{ path: 'src/auth.ts', status: 'pending', batches: [] }]);
    process.env.REVIEW_INVENTORY_DIGEST = inventoryDigest(['src/auth.ts']);
    await assertSubmissionFailed(tools.get('submit_review').execute('call', { path: resultPath }), /Incomplete coverage/);
    await assert.rejects(readFile(process.env.REVIEW_RESULT_PATH!), /ENOENT/);
    saved.ledger[0] = { path: 'src/auth.ts', status: 'complete', batches: ['auth'] };
    await mkdir(path.join(workspace, 'batches'));
    await writeFile(path.join(workspace, 'batches/auth.md'), '已核对鉴权调用方和失败路径。');
    await writeFile(progressPath, JSON.stringify(saved));
    await tools.get('submit_review').execute('call', { path: resultPath });
    assert.deepEqual(parseReviewResult(await readFile(process.env.REVIEW_RESULT_PATH!, 'utf8')), summary);
    assert.equal(await readFile(process.env.REVIEW_CONTEXT_PATH!, 'utf8'), originalContext);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('automatic reviews cannot record a focused partial scope', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-auto-scope-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    await configureProgress(directory);
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    let scopeTool: any;
    reviewTools({ registerTool: (definition) => { if (definition.name === 'set_review_scope') scopeTool = definition; } });
    await assert.rejects(scopeTool.execute('call', { mode: 'focused', rationale: '只看一个文件。', explicit_text: '只看 auth', ranges: [{ targets: ['src/auth.ts'], comparison_start: 'a'.repeat(40), comparison_end: 'b'.repeat(40)  }]}), /complete PR scope/);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('submit_review rejects invalid results without sealing and allows correction', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-tools-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    const sourcePath = path.join(workspace, 'final.json');
    const resultPath = path.join(directory, 'result.json');
    await mkdir(workspace);
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = resultPath;
    await configureProgress(directory);
    let tool: any;
    reviewTools({ registerTool: (definition) => { tool = definition; } });

    const invalidResults: Array<[string, RegExp]> = [
      ['{', /JSON/],
      [JSON.stringify({ ...result, version: '1.0.0', private: true }), /Invalid review result fields/],
      [JSON.stringify({ ...result, body: '' }), /Invalid review body/],
      [JSON.stringify({ ...result, comments: [{ ...result.comments[0], start_line: 43 }] }), /start_line/],
      [JSON.stringify({ ...result, thread_updates: [{ ...result.thread_updates[0], status: 'unknown' }] }), /thread status/],
      [JSON.stringify({ ...result, thread_updates: [result.thread_updates[0], result.thread_updates[0]] }), /Duplicate thread update/],
      [JSON.stringify({ ...result, request_reply: '字符串答复' }), /Invalid request reply/],
    ];
    for (const [content, error] of invalidResults) {
      await writeFile(sourcePath, content);
      await assertSubmissionFailed(tool.execute('call', { path: sourcePath }), error);
      await assert.rejects(readFile(resultPath), { code: 'ENOENT' });
    }

    const content = `${JSON.stringify(result)}\n`;
    await writeFile(sourcePath, content);
    await tool.execute('call', { path: sourcePath });
    assert.equal(await readFile(resultPath, 'utf8'), content);
    await assertSubmissionFailed(tool.execute('call', { path: sourcePath }), /already submitted/);
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
    await configureProgress(directory);
    let tool: any;
    reviewTools({ registerTool: (definition) => { tool = definition; } });
    await assertSubmissionFailed(tool.execute('call', { path: outside }), /inside REVIEW_WORKSPACE_PATH/);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('thread submission accepts the documented reply object on its first attempt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-thread-submit-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    await configureProgress(directory, 'thread');
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = path.join(directory, 'result.json');
    const source = path.join(workspace, 'result.json');
    await writeFile(source, JSON.stringify({ ...result, request_reply: { body: '已复核并更新该问题的状态。' } }));
    let tool: any;
    reviewTools({ registerTool: (definition) => { tool = definition; } });
    const response = await tool.execute('call', { path: source });
    assert.equal(response.details.queued, true);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('all complete JSON examples in the central protocol match the submission schema', async () => {
  const protocol = await readFile(new URL('../central/review-result.md', import.meta.url), 'utf8');
  const examples = [...protocol.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => parseReviewResult(match[1]));
  assert.equal(examples.length, 4);
  assert.deepEqual(examples.slice(1).map((example) => example.request_reply === null), [true, true, false]);
});

test('publisher creates one review, updates threads, and appends the footer', async () => {
  const { requests, fetchImpl } = publisherFetch();
  const report = await publish(result, fetchImpl as typeof fetch);
  assert.equal(report.reviewUrl, 'https://github.test/review/1');
  assert.ok(report.operations.every(item => item.status === 'succeeded'), JSON.stringify(report));

  assert.match(requests.find(({ url }) => url.endsWith('/comments/123/replies'))!.body, /已关闭/);
  assert.match(requests.find(({ body }) => body.includes('resolveReviewThread'))!.body, /resolveReviewThread/);
  const review = JSON.parse(requests.find(({ url }) => url.endsWith('/pulls/7/reviews'))!.body);
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.commit_id, headSha);
  assert.match(review.body, /这个 PR 修复了清理行为。/);
  assert.match(review.body, /View action run/);
  const finding = JSON.parse(requests.find(({ url }) => url.endsWith('/pulls/7/comments'))!.body);
  assert.match(finding.body, /agentic-review-publication:/);
  assert.deepEqual({ ...finding, body: result.comments[0].body }, {
    commit_id: headSha,
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
  const summaryOnly = { body: '未发现需要阻止合并的问题。', comments: [], thread_updates: [], request_reply: null };
  await publish(summaryOnly as typeof result, fetchImpl as typeof fetch);
  assert.equal(requests.some(({ url }) => url.includes('/comments?')), false);
  assert.deepEqual(
    JSON.parse(requests.find(({ url }) => url.endsWith('/pulls/7/reviews'))!.body).comments,
    undefined,
  );
});

test('publisher updates findings by conclusion regardless of who created the root', async () => {
  for (const login of ['maintainer', 'other[bot]']) {
    const { requests, fetchImpl } = publisherFetch({
      comments: [{ id: 123, in_reply_to_id: null, body: 'original finding', user: { login } }],
    });
    await publish(result, fetchImpl as typeof fetch);
    assert.ok(requests.some(({ body }) => body.includes('resolveReviewThread')));
  }
});

test('publisher rejects missing roots and reply IDs while publishing independent findings and summary', async () => {
  for (const comments of [[], [{ id: 123, in_reply_to_id: 1, body: 'reply', user: { login: 'maintainer' } }]]) {
    const { requests, fetchImpl } = publisherFetch({ comments });
    const report = await publish(result, fetchImpl as typeof fetch);
    assert.match(report.operations.find(item => item.id === 'thread 123 归属校验')!.error!, /not a root comment in this PR/);
    assert.equal(requests.some(({ url }) => url.endsWith('/replies')), false);
    assert.ok(requests.some(({ url }) => url.endsWith('/reviews')));
    assert.ok(requests.some(({ url }) => url.endsWith('/pulls/7/comments')));
    assert.match(JSON.parse(requests.find(({ url }) => url.endsWith('/reviews'))!.body).body, /发布未全部完成/);
  }
});

test('publisher keeps an older review available to later serial runs', async () => {
  const { requests, fetchImpl } = publisherFetch();
  await publish(result, fetchImpl as typeof fetch);

  assert.equal(requests.some(({ url }) => url.endsWith('/pulls/7')), false);
  assert.equal(JSON.parse(requests.find(({ url }) => url.endsWith('/pulls/7/reviews'))!.body).commit_id, headSha);
  assert.equal(requests.some(({ url }) => url.endsWith('/comments/123/replies')), true);
  assert.equal(requests.some(({ body }) => body.includes('resolveReviewThread')), true);
});

test('thread-only request replies to a human root without changing thread state', async () => {
  const { requests, fetchImpl } = publisherFetch({
    comments: [{ id: 123, in_reply_to_id: null, body: 'human finding', user: { login: 'maintainer' } }],
  });
  await publishReview({
    result: { body: '已复核该问题，结论未变。', comments: [], thread_updates: [], request_reply: { body: '结论未变，当前问题仍需关注。' } },
    repository: 'owner/repo', pullNumber: 7, botLogin: 'review-app[bot]', token: 'write-token', expectedHeadSha: headSha,
    publicationId: 'run-1', footer: 'footer', api: 'https://api.github.test', requestSource: 'thread', requestCommentId: '456', requestRootCommentId: '123', threadReplyOnly: true,
    fetchImpl,
  });
  assert.equal(requests.some(({ url }) => url.endsWith('/pulls/7/reviews')), false);
  assert.equal(requests.some(({ url }) => url.endsWith('/comments/123/replies')), true);
  assert.equal(requests.some(({ body }) => body.includes('resolveReviewThread') || body.includes('unresolveReviewThread')), false);
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
      actionRef: 'shaftoe/pi-coding-agent-action@v2.27.0',
    }),
    '[View action run](https://github.test/run) | [审查工作稿](https://github.test/artifact/1) | Model: openai/gpt-test (thinking: high) | Time: 2m 55s | Tokens: 715.3K | Action v2.27.0',
  );
});

test('production workflow shares the thinking level between Pi and the published footer', async () => {
  type Job = { env?: Record<string, string>; steps: Array<{ id?: string; env?: Record<string, string>; with?: Record<string, unknown> }> };
  const workflow = parse(await readFile(new URL('../.github/workflows/agentic-review.yml', import.meta.url), 'utf8')) as {
    env: Record<string, string>; jobs: { review: Job; publish: Job };
  };
  const agent = workflow.jobs.review.steps.find(step => step.id === 'pi-review')!;
  const publisher = workflow.jobs.publish.steps.find(step => step.id === 'publish-review')!;
  const agentEnv = { ...workflow.env, ...workflow.jobs.review.env, ...agent.env };
  const publishEnv = { ...workflow.env, ...workflow.jobs.publish.env, ...publisher.env };
  const agentLevel = agent.with?.thinking_level === '${{ env.REVIEW_THINKING_LEVEL }}'
    ? agentEnv.REVIEW_THINKING_LEVEL : agent.with?.thinking_level;
  assert.equal(publishEnv.REVIEW_THINKING_LEVEL, agentLevel);
  assert.equal(agentLevel, 'xhigh');
  assert.equal(agent.with?.thinking_level, '${{ env.REVIEW_THINKING_LEVEL }}');
  assert.match(buildFooter({
    runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/artifact/1',
    model: 'openai/gpt-test', thinkingLevel: publishEnv.REVIEW_THINKING_LEVEL,
  }), /\(thinking: xhigh\)/);
});
