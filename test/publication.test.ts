import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { createPublication, finishPublication } from '../scripts/publication.ts';
import { checkText, coverageNotice, publishReview, sourceReviewedNotice } from '../scripts/publish-review.ts';
import type { ReviewResult } from '../scripts/review-result.ts';

const result: ReviewResult = {
  body: '审查正文；历史问题已修复。',
  comments: [1, 2].map(line => ({ path: 'src/example.ts', line, start_line: null, body: `问题 ${line}` })),
  thread_updates: [123, 456].map(root_comment_id => ({ root_comment_id, status: 'resolved', evidence: '当前代码已恢复鉴权检查，旧路径不再可达。' })),
  request_reply: { body: '已按请求重新核对。' },
};

type Call = { url: string; method: string; body: any };
function fixture() {
  const calls: Call[] = [];
  const comments: any[] = [123, 456].map(id => ({ id, in_reply_to_id: null, body: '旧问题', user: { login: 'maintainer' } }));
  const reviews: any[] = [];
  const resolved = new Set<string>();
  const minimized = new Set<string>();
  const state: {
    calls: Call[]; comments: any[]; reviews: any[]; resolved: Set<string>; minimized: Set<string>;
    fail: (call: Call) => Response | undefined;
    afterWrite: (call: Call) => void;
    fetchImpl: typeof fetch;
  } = {
    calls, comments, reviews, resolved, minimized,
    fail: (_call: Call): Response | undefined => undefined,
    afterWrite: (_call: Call) => {},
    fetchImpl: (async (input, init) => {
      const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const failure = state.fail(call);
      if (failure) return failure;
      const bot = { login: 'review-app[bot]' };
      if (call.method === 'GET' && call.url.includes('/comments?')) return Response.json(comments.slice((Number(new URL(call.url).searchParams.get('page')) - 1) * 100, Number(new URL(call.url).searchParams.get('page')) * 100));
      if (call.method === 'GET' && call.url.includes('/reviews?')) return Response.json(reviews.slice((Number(new URL(call.url).searchParams.get('page')) - 1) * 100, Number(new URL(call.url).searchParams.get('page')) * 100));
      if (call.url.endsWith('/graphql')) {
        const query = call.body.query as string;
        if (query.includes('reviewThreads')) return Response.json({ data: { repository: { pullRequest: {
          reviewThreads: { nodes: [123, 456].map(id => ({ id: `thread-${id}`, isResolved: resolved.has(`thread-${id}`), comments: { nodes: [{ databaseId: id }] } })),
            pageInfo: { hasNextPage: false, endCursor: null } },
        } } } });
        if (query.includes('nodes(ids')) return Response.json({ data: { nodes: call.body.variables.ids.map((id: string) => ({ id, isMinimized: minimized.has(id) })) } });
        if (query.includes('minimizeComment')) {
          assert.match(query, /classifier:OUTDATED/);
          minimized.add(call.body.variables.id);
          state.afterWrite(call);
          return Response.json({ data: { minimizeComment: { minimizedComment: { isMinimized: true } } } });
        }
        const id = call.body.variables.thread;
        assert.ok(query.includes('resolveReviewThread'), `Unexpected GraphQL operation: ${query}`);
        const operation = query.includes('unresolveReviewThread') ? 'unresolveReviewThread' : 'resolveReviewThread';
        if (operation === 'resolveReviewThread') resolved.add(id); else resolved.delete(id);
        state.afterWrite(call);
        return Response.json({ data: { [operation]: { thread: { id } } } });
      }
      if (call.url.endsWith('/reviews') && call.method === 'POST') {
        const review = { ...call.body, id: reviews.length + 1, node_id: `review-${reviews.length + 1}`, user: bot, html_url: `https://github.test/review/${reviews.length + 1}` };
        reviews.push(review);
        state.afterWrite(call);
        return Response.json(review);
      }
      if (call.method === 'PATCH' && call.url.includes('/pulls/comments/')) {
        const comment = comments.find(item => String(item.id) === call.url.split('/').at(-1));
        assert.ok(comment);
        comment.body = call.body.body;
        state.afterWrite(call);
        return Response.json(comment);
      }
      if (call.method === 'PUT' && call.url.includes('/reviews/')) {
        const review = reviews.find(item => String(item.id) === call.url.split('/').at(-1));
        assert.ok(review);
        review.body = call.body.body;
        state.afterWrite(call);
        return Response.json(review);
      }
      if (call.method === 'POST' && (call.url.endsWith('/comments') || call.url.endsWith('/replies'))) {
        const root = call.url.match(/comments\/(\d+)\/replies$/)?.[1];
        const comment = { ...call.body, id: 1000 + comments.length, in_reply_to_id: root ? Number(root) : null,
          user: bot, html_url: `https://github.test/comment/${comments.length}` };
        comments.push(comment);
        state.afterWrite(call);
        return Response.json(comment);
      }
      throw new Error(`Unexpected call ${JSON.stringify(call)}`);
    }) as typeof fetch,
  };
  return state;
}

function publish(state: ReturnType<typeof fixture>, override: Partial<Parameters<typeof publishReview>[0]> = {}) {
  return publishReview({ result, repository: 'owner/repo', pullNumber: 7, botLogin: 'review-app[bot]', token: 'write-token',
    expectedHeadSha: 'b'.repeat(40), footer: '[运行报告](https://github.test/run)', runUrl: 'https://github.test/run', publicationId: 'run-1',
    api: 'https://api.github.test', requestSource: 'thread', requestCommentId: '900', requestRootCommentId: '123',
    fetchImpl: state.fetchImpl, ...override });
}

const mutations = (calls: Call[]) => calls.filter(call => call.method !== 'GET' && !call.body?.query?.startsWith('query'));

test('发布多行 finding、正文和页脚，按结论同步人类及其他 bot 的 root', async () => {
  const state = fixture();
  state.comments[1].user.login = 'other[bot]';
  const finding = { path: 'src/auth.ts', line: 42, start_line: 40, body: '**[P1] 仍会误删**\n\n详细证据。' };
  const input = { ...result, comments: [finding], request_reply: null };
  const report = await publish(state, { result: input, requestSource: 'automatic' });
  assert.equal(report.reviewUrl, 'https://github.test/review/1');
  assert.ok(report.operations.every(item => item.status === 'succeeded'), JSON.stringify(report));
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].event, 'COMMENT');
  assert.equal(state.reviews[0].commit_id, 'b'.repeat(40));
  assert.ok(state.reviews[0].body.includes(input.body));
  assert.ok(state.reviews[0].body.includes('[运行报告](https://github.test/run)'));
  assert.equal(state.calls.some(call => call.url.endsWith('/pulls/7')), false);
  const posted = state.calls.find(call => call.method === 'POST' && call.url.endsWith('/comments'))!.body;
  assert.match(posted.body, /agentic-review-publication:/);
  assert.deepEqual({ ...posted, body: finding.body }, {
    ...finding, commit_id: 'b'.repeat(40), side: 'RIGHT', start_side: 'RIGHT',
  });
  assert.deepEqual([...state.resolved].sort(), ['thread-123', 'thread-456']);
  // 全部成功时不加执行说明；thread 回复只链接运行，不重复总评的运行信息。
  assert.doesNotMatch(state.reviews[0].body, /下文为审查判断|运行报告。/);
  for (const root of [123, 456]) {
    const reply = state.comments.find(comment => comment.in_reply_to_id === root)!.body;
    assert.match(reply, /^\*\*状态更新：✅ 已关闭\*\*/);
    assert.match(reply, /\[View action run\]\(https:\/\/github\.test\/run\)/);
    assert.doesNotMatch(reply, /运行报告/);
  }
});

test('新的自动总评折叠更早的自动总评，评论请求的答复不折叠也不被折叠', async () => {
  const state = fixture();
  const automatic = { requestSource: 'automatic', result: { ...result, comments: [], thread_updates: [], request_reply: null } };
  await publish(state, { ...automatic, publicationId: 'run-1' });
  assert.equal(state.minimized.size, 0);
  await publish(state, { requestSource: 'pr_comment', publicationId: 'run-2',
    result: { ...automatic.result, body: '<!-- agentic-review:automatic-summary -->\n正文中的同名标记' } });
  assert.equal(state.minimized.size, 0);
  const report = await publish(state, { ...automatic, publicationId: 'run-3' });
  assert.ok(report.operations.every(item => item.status === 'succeeded'), JSON.stringify(report));
  assert.deepEqual([...state.minimized], ['review-1']);
  // 重跑不重复折叠；更早运行的重跑不会折叠更新的总评。
  const before = mutations(state.calls).length;
  await publish(state, { ...automatic, publicationId: 'run-3' });
  await publish(state, { ...automatic, publicationId: 'run-1' });
  assert.equal(mutations(state.calls).length, before);
  assert.deepEqual([...state.minimized], ['review-1']);
  assert.equal(state.reviews.length, 3);
});

test('折叠失败记为发布失败，不影响已发布的新总评', async () => {
  const state = fixture();
  const automatic = { requestSource: 'automatic', result: { ...result, comments: [], thread_updates: [], request_reply: null } };
  await publish(state, { ...automatic, publicationId: 'run-1' });
  state.fail = call => call.body?.query?.includes('minimizeComment') ? Response.json({ errors: [{ message: 'forbidden' }] }) : undefined;
  const report = await publish(state, { ...automatic, publicationId: 'run-2' });
  assert.equal(report.reviewUrl, 'https://github.test/review/2');
  assert.deepEqual(report.operations.filter(item => item.status !== 'succeeded').map(item => item.id), ['折叠旧 Review 1']);
  assert.equal(state.minimized.size, 0);
});

test('Check 详情汇总运行、结果、覆盖、用量和未成功的发布操作', () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const text = checkText({
    footer: '[View action run](https://github.test/run) | Model: openai/gpt-test', result,
    usage: { turns: 3, priceKnown: true, first: zero, total: zero },
    coverage: { reviewed: 4, total: 5, sourceReviewed: 2 },
    operations: [
      { id: 'Review 正文', status: 'succeeded', dependencies: [] },
      { id: 'finding 1 (src/example.ts:1)', status: 'failed', dependencies: [], error: 'secret API response' },
      { id: '折叠旧 Review 1', status: 'blocked', dependencies: [] },
    ],
  });
  assert.match(text, /Model: openai\/gpt-test/);
  assert.match(text, /新问题 2 条；历史问题状态变化 2 条（✅ 已关闭 2）/);
  assert.match(text, /已审查 4\/5 个文件；来源 PR 已审而未重复审查 2 个/);
  assert.match(text, /3 个审查回合/);
  assert.match(text, /成功 1；失败 1；前置失败，未执行 1/);
  assert.match(text, /- 失败：finding 1 \(src\/example\.ts:1\)/);
  assert.match(text, /- 前置失败，未执行：折叠旧 Review 1/);
  assert.doesNotMatch(text, /secret API response|- 成功/);
  // 发布前校验失败时只有操作记录。
  assert.match(checkText({ operations: [{ id: '发布前校验', status: 'failed', dependencies: [] }] }), /^## 发布操作/);
});

test('风险升高时重开已关闭 thread', async () => {
  const state = fixture();
  state.resolved.add('thread-123');
  await publish(state, { requestSource: 'automatic', result: {
    ...result, comments: [], thread_updates: [{ ...result.thread_updates[0], status: 'severity_increased' }], request_reply: null,
  } });
  assert.equal(state.resolved.has('thread-123'), false);
  assert.ok(state.calls.some(call => call.body?.query?.includes('unresolveReviewThread')));
});

test('仅正文 Review 不读取评论或 thread，也不附带 inline comments', async () => {
  const state = fixture();
  await publish(state, { requestSource: 'automatic', result: {
    body: '未发现需要阻止合并的问题。', comments: [], thread_updates: [], request_reply: null,
  } });
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].comments, undefined);
  assert.equal(state.calls.some(call => call.url.includes('/comments?') || call.url.endsWith('/graphql')), false);
});

test('局部 thread 请求仅回复人类 root，不创建 Review 或改变 thread 状态', async () => {
  const state = fixture();
  await publish(state, { threadReplyOnly: true, result: {
    body: '已复核该问题，结论未变。', comments: [], thread_updates: [], request_reply: { body: '结论未变，当前问题仍需关注。' },
  } });
  assert.equal(state.reviews.length, 0);
  assert.equal(state.calls.some(call => call.url.includes('/reviews')), false);
  assert.equal(state.calls.some(call => call.url.endsWith('/comments/123/replies')), true);
  assert.equal(state.calls.some(call => call.body?.query?.includes('resolveReviewThread')), false);
});

test('发布前独立读取并行，thread 列表直接提供状态而不逐条重查', { timeout: 5000 }, async () => {
  const state = fixture();
  const originalFetch = state.fetchImpl;
  const started = new Set<string>();
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  state.fetchImpl = (async (input, init) => {
    const url = String(input);
    const query = init?.body ? JSON.parse(String(init.body)).query : undefined;
    const kind = url.includes('/comments?') ? 'comments' : url.includes('/reviews?') ? 'reviews'
      : query?.includes('reviewThreads') ? 'threads' : null;
    if (kind) {
      started.add(kind);
      if (started.size === 3) resolveReady();
      await ready;
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  await publish(state);
  assert.equal(started.size, 3);
  const queries = state.calls.filter(call => call.body?.query?.startsWith('query'));
  assert.equal(queries.length, 1);
  assert.match(queries[0].body.query, /isResolved/);
  assert.equal(state.resolved.size, 2);
});

test('同一 thread 的状态与证据并行，正文等待两项结束并包含失败结果', { timeout: 5000 }, async () => {
  const state = fixture();
  const originalFetch = state.fetchImpl;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let bothStarted!: () => void;
  const ready = new Promise<void>(resolve => { bothStarted = resolve; });
  const started = new Set<string>();
  state.fetchImpl = (async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const kind = body?.query?.startsWith('mutation') ? 'state'
      : String(input).endsWith('/comments/123/replies') ? 'evidence' : null;
    if (kind) {
      started.add(kind);
      if (started.size === 2) bothStarted();
      await gate;
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  state.fail = call => call.body?.query?.startsWith('mutation') ? new Response('unavailable', { status: 503 }) : undefined;
  const pending = publish(state, { requestSource: 'automatic', result: {
    ...result, comments: [], thread_updates: [result.thread_updates[0]], request_reply: null,
  } });
  await ready;
  assert.equal(state.reviews.length, 0);
  release();
  const report = await pending;
  assert.ok(state.comments.some(item => item.body.includes('状态更新：')));
  assert.equal(state.resolved.size, 0);
  assert.equal(report.operations.find(item => item.id === 'thread 123 状态同步')?.status, 'failed');
  assert.equal(report.operations.find(item => item.id === 'thread 123 证据回复')?.status, 'succeeded');
  assert.match(state.reviews[0].body, /发布未全部完成：1 项/);
});

test('统一执行边界收集任意异常，只阻断声明了失败依赖的操作', async () => {
  const publication = createPublication();
  const first = await publication.run('first', [], async () => { throw '未知故障'; });
  let dependentRan = false;
  await publication.run('dependent', [first], async () => { dependentRan = true; });
  const independent = await publication.run('independent', [], async () => 42);
  assert.equal(dependentRan, false);
  assert.equal(independent.value, 42);
  assert.deepEqual(publication.operations.map(item => item.status), ['failed', 'blocked', 'succeeded']);
  assert.equal(publication.operations[0].error, '未知故障');
});

for (const [name, matches] of [
  ['单条 finding', (call: Call) => call.url.endsWith('/comments') && call.body?.line === 1],
  ['Review 正文', (call: Call) => call.url.endsWith('/reviews') && call.method === 'POST'],
  ['请求回复', (call: Call) => call.body?.body?.includes('已按请求重新核对。')],
  ['thread 证据回复', (call: Call) => call.url.endsWith('/comments/123/replies') && call.body?.body?.includes('状态更新：')],
  ['thread 状态同步', (call: Call) => call.body?.query?.startsWith('mutation') && call.body?.variables.thread === 'thread-123'],
] as const) {
  test(`${name} 遇到未预料异常，其余独立写入继续执行`, async () => {
    const state = fixture();
    state.fail = call => { if (matches(call)) throw new Error('未预料的传输故障'); return undefined; };
    const report = await publish(state);
    assert.equal(report.operations.filter(item => item.status === 'failed').length, 1, JSON.stringify(report));
    assert.equal(report.operations.filter(item => item.status === 'blocked').length, 0, JSON.stringify(report));
    assert.ok(state.comments.some(item => item.line === 2));
    assert.ok(state.resolved.has('thread-456'));
    assert.ok(report.operations.some(item => item.id === 'Review 正文'));
  });
}

for (const kind of ['comments', 'threads', 'reviews'] as const) {
  test(`${kind} 查询失败只阻断需要该查询的操作`, async () => {
    const state = fixture();
    state.fail = call => {
      if ((kind === 'comments' && call.url.includes('/comments?')) ||
          (kind === 'reviews' && call.url.includes('/reviews?')) ||
          (kind === 'threads' && call.body?.query?.includes('reviewThreads'))) {
        return new Response('upstream unavailable', { status: 503 });
      }
    };
    const report = await publish(state);
    assert.ok(report.operations.some(item => item.status === 'failed'));
    if (kind === 'comments') {
      assert.equal(state.comments.length, 2);
      assert.equal(state.resolved.size, 0);
      assert.equal(state.reviews.length, 1);
    } else if (kind === 'threads') {
      assert.equal(state.resolved.size, 0);
      assert.ok(state.comments.some(item => item.body.includes('状态更新：')));
      assert.equal(state.reviews.length, 1);
    } else {
      assert.equal(state.reviews.length, 0);
      assert.equal(state.resolved.size, 2);
      assert.ok(state.comments.some(item => item.line === 2));
    }
  });
}

for (const invalidRoot of ['missing', 'reply']) test(`${invalidRoot} root 校验失败不影响独立 finding、其他 thread 和正文`, async () => {
  const state = fixture();
  if (invalidRoot === 'missing') state.comments.shift();
  else state.comments[0].in_reply_to_id = 1;
  state.fail = call => call.body?.line === 1 ? new Response('invalid line', { status: 422 }) : undefined;
  const report = await publish(state);
  assert.equal(report.operations.filter(item => item.status === 'failed').length, 3);
  assert.ok(state.resolved.has('thread-456'));
  assert.ok(state.comments.some(item => item.line === 2));
  assert.equal(state.calls.some(call => call.url.endsWith('/comments/123/replies')), false);
  assert.match(state.reviews[0].body, /发布未全部完成/);
});

test('部分成功后重跑核对远端标记，只补做失败项并更新正文中的发布结果', async () => {
  const state = fixture();
  state.fail = call => call.body?.line === 1 ? new Response('invalid line', { status: 422 }) : undefined;
  await publish(state);
  const firstCount = mutations(state.calls).length;
  state.fail = () => undefined;
  const report = await publish(state);
  assert.ok(report.operations.every(item => item.status === 'succeeded'));
  const retried = mutations(state.calls).slice(firstCount);
  assert.equal(retried.length, 3, JSON.stringify(retried));
  assert.equal(retried[0].body.line, 1);
  assert.equal(retried[1].method, 'PATCH');
  assert.equal(retried[2].method, 'PUT');
  assert.equal(state.reviews.length, 1);
  assert.doesNotMatch(state.reviews[0].body, /发布未全部完成/);
  assert.equal(state.comments.filter(item => item.line === 2).length, 1);
});

test('写入已生效但响应丢失时，本轮不重试；下次从远端识别成功项', async () => {
  const state = fixture();
  state.afterWrite = call => { if (call.body?.line === 1 || call.url.endsWith('/reviews')) throw new Error('response lost'); };
  const first = await publish(state);
  assert.equal(first.operations.filter(item => item.status === 'failed').length, 2);
  assert.equal(state.reviews.length, 1);
  state.afterWrite = () => {};
  const next = await publish(state);
  assert.ok(next.operations.every(item => item.status === 'succeeded'));
  assert.equal(state.comments.filter(item => item.line === 1).length, 1);
  assert.equal(state.reviews.length, 1);
});

test('发布标记必须来自本 bot；相同结果的新运行有独立身份', async () => {
  const state = fixture();
  await publish(state);
  for (const item of [...state.comments, ...state.reviews]) item.user = { login: 'other[bot]' };
  await publish(state);
  assert.equal(state.reviews.length, 2);
  await publish(state, { publicationId: 'run-2' });
  assert.equal(state.reviews.length, 3);
});

test('公共输入无效时不执行任何远端操作', async () => {
  const state = fixture();
  await assert.rejects(publish(state, { repository: '../other' }), /Invalid repository/);
  await assert.rejects(publish(state, { result: { ...result, comments: [{ ...result.comments[0], path: '../secret' }] } }), /Invalid review comment path/);
  assert.deepEqual(state.calls, []);
});


test('重跑读取全部分页，第二页的发布标记仍能阻止重复写入', async () => {
  const state = fixture();
  await publish(state);
  const fillers = Array.from({ length: 100 }, (_, index) => ({ id: 2000 + index, body: '旧记录', user: { login: 'maintainer' } }));
  state.comments.unshift(...fillers);
  state.reviews.unshift(...fillers);
  const before = mutations(state.calls).length;
  const report = await publish(state);
  assert.ok(report.operations.every(item => item.status === 'succeeded'));
  assert.equal(mutations(state.calls).length, before);
  assert.ok(state.calls.some(call => call.url.includes('/comments?per_page=100&page=2')));
  assert.ok(state.calls.some(call => call.url.includes('/reviews?per_page=100&page=2')));
});

test('GraphQL 返回 HTTP 200 的业务错误仍记为失败，证据回复继续', async () => {
  const state = fixture();
  state.fail = call => call.body?.query?.startsWith('mutation')
    ? Response.json({ errors: [{ message: 'forbidden mutation' }] }) : undefined;
  const report = await publish(state);
  assert.equal(report.operations.filter(item => item.status === 'failed').length, 2);
  assert.ok(state.comments.some(item => item.body.includes('状态更新：')));
  assert.equal(state.reviews.length, 1);
});


test('局部 thread 请求重跑更新旧回复中的失败说明，不重复回复', async () => {
  const state = fixture();
  const focused = { threadReplyOnly: true, result: { ...result, comments: [] } };
  state.fail = call => call.body?.query?.startsWith('mutation') && call.body.variables.thread === 'thread-456'
    ? new Response('state unavailable', { status: 500 }) : undefined;
  await publish(state, focused);
  const reply = state.comments.find(item => item.body.includes('已按请求重新核对。'));
  assert.match(reply.body, /发布未全部完成/);
  state.fail = () => undefined;
  const report = await publish(state, focused);
  assert.ok(report.operations.every(item => item.status === 'succeeded'));
  assert.equal(state.comments.filter(item => item.body.includes('已按请求重新核对。')).length, 1);
  assert.doesNotMatch(reply.body, /发布未全部完成/);
  assert.equal(state.reviews.length, 0);
});


test('部分覆盖只回复 thread 时，未审文件列在回复中；同时发布正文时只列在正文', async () => {
  const notice = coverageNotice(['auth.ts'], 3);
  const replyOnly = fixture();
  await publish(replyOnly, { threadReplyOnly: true, coverageNotice: notice, result: { ...result, comments: [] } });
  assert.equal(replyOnly.reviews.length, 0);
  assert.ok(replyOnly.comments.find(item => item.body.includes('已按请求重新核对。')).body.includes('- `auth.ts`'));
  const both = fixture();
  await publish(both, { threadReplyOnly: true, coverageNotice: notice, result });
  assert.ok(both.reviews[0].body.includes('- `auth.ts`'));
  assert.ok(!both.comments.find(item => item.body.includes('已按请求重新核对。')).body.includes('- `auth.ts`'));
});


test('workflow 按依赖继续执行；发布或存储失败不能让 Check 成功', async () => {
  const workflow = readFileSync(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8');
  const execution = parse(workflow).jobs.review.steps;
  const steps: Record<string, { outcome: string; outputs: Record<string, string> }> = Object.fromEntries([
    'pi-review', 'review-context', 'review-check', 'review-workspace',
    'publication-token', 'publish-review', 'diagnostic-workspace',
  ].map(id => [id, { outcome: 'success', outputs: {} }]));
  steps['review-check'].outputs.check_id = '1';
  steps['review-context'].outputs.context_digest = 'trusted-digest';
  steps['publish-review'].outputs.workspace_ready = 'true';
  function shouldRun(id: string, cancelled = false) {
    const condition = execution.find((step: { id?: string }) => step.id === id)?.if;
    const expression = condition?.match(/^\$\{\{ (.+) \}\}$/)?.[1];
    assert.ok(expression, `Missing explicit dependency condition for ${id}`);
    // 执行工作流中的条件本身；status 函数必须显式出现，避免 Actions 隐含 success() 阻断独立步骤。
    assert.match(expression, /(?:cancelled|always)\(\)/);
    return runInNewContext(expression.replace(/steps\.([\w-]+)\./g, 'steps["$1"].'), {
      steps, cancelled: () => cancelled, always: () => true, hashFiles: () => 'draft-files',
    });
  }
  steps['pi-review'].outcome = 'failure';
  assert.equal(shouldRun('review-workspace'), true);
  assert.equal(shouldRun('publication-token'), true);
  assert.equal(shouldRun('publish-review'), true);
  assert.equal(shouldRun('complete-check'), true);
  steps['pi-review'].outcome = 'success';
  steps['review-check'].outputs.check_id = '';
  assert.equal(shouldRun('publication-token'), false);
  assert.equal(shouldRun('complete-check'), false);
  steps['review-check'].outputs.check_id = '1';
  steps['review-workspace'].outcome = 'failure';
  assert.equal(shouldRun('diagnostic-workspace'), true);
  assert.equal(shouldRun('publish-review'), true);
  steps['publication-token'].outcome = 'failure';
  assert.equal(shouldRun('publish-review'), true);
  steps['publication-token'].outcome = 'success';
  steps['review-context'].outputs.context_digest = '';
  steps['publish-review'].outputs.workspace_ready = '';
  assert.equal(shouldRun('review-workspace'), false);
  assert.equal(shouldRun('publish-review'), false);
  steps['review-context'].outputs.context_digest = 'trusted-digest';
  steps['review-context'].outcome = 'failure';
  assert.equal(shouldRun('publish-review'), true);
  steps['publish-review'].outputs.workspace_ready = 'true';
  steps['publish-review'].outcome = 'failure';
  assert.equal(shouldRun('review-workspace'), true);
  assert.equal(shouldRun('review-workspace', true), true);
  steps['publish-review'].outcome = 'success';
  assert.equal(shouldRun('review-workspace'), true);
  steps['review-workspace'].outcome = 'success';
  assert.equal(shouldRun('diagnostic-workspace'), false);
  // 可恢复工作区正常运行只归档一次；原始 Pi session 独立归档，不参与范围恢复。
  assert.equal(execution.filter((step: { id: string; uses?: string; if?: string; with?: { path?: string } }) =>
    step.uses?.startsWith('actions/upload-artifact@') && step.with?.path === '${{ github.workspace }}/review-workspace'
    && (!step.if || shouldRun(step.id))).length, 1);
  const archive = execution.find((step: { id?: string }) => step.id === 'review-workspace');
  const prefix = archive.with.name.match(/^\$\{\{ (.+?) \}\}/)[1];
  for (const outcome of ['success', 'failure', 'cancelled', 'skipped']) {
    steps['publish-review'].outcome = outcome;
    assert.equal(runInNewContext(prefix.replace(/steps\.([\w-]+)\./g, 'steps["$1"].'), { steps }),
      outcome === 'success' ? 'review-completed-workspace' : 'review-workspace');
  }

  const completion = workflow.split('      - name: Complete Agentic Review check')[1];
  assert.match(completion, /REVIEW_JOB_STATUS: \$\{\{ job.status \}\}/);
  const script = completion.split('          script: |\n')[1].split('\n').map(line => line.slice(12)).join('\n');
  let payload: any;
  let checkDetails = '## 运行';
  async function conclusion(jobStatus: string, publicationOutcome = 'success', agentOutcome = 'success', archiveOutcome = 'success', pending = '0') {
    await runInNewContext(`(async () => { ${script} })()`, {
      process: { env: { REPOSITORY: 'owner/repo', CHECK_ID: '1', PI_REVIEW_OUTCOME: agentOutcome,
        PUBLISH_REVIEW_OUTCOME: publicationOutcome, COMPLETION_WORKSPACE_OUTCOME: archiveOutcome, REVIEW_JOB_STATUS: jobStatus,
        COVERAGE_PENDING: pending, COVERAGE_TOTAL: '5', CHECK_TEXT: checkDetails } },
      github: { rest: { checks: { update: async (value: any) => { payload = value; } } } },
    });
    return payload.conclusion;
  }
  assert.equal(await conclusion('success'), 'success');
  assert.equal(payload.output.text, '## 运行');
  assert.match(completion, /CHECK_TEXT: \$\{\{ steps\.publish-review\.outputs\.check_text \}\}/);
  checkDetails = '';
  assert.equal(await conclusion('failure'), 'failure');
  assert.equal('text' in payload.output, false);
  checkDetails = '## 运行';
  // 部分覆盖已发布但仍阻止合并；缺失覆盖统计不能当作完整。
  assert.equal(await conclusion('success', 'success', 'success', 'success', '2'), 'action_required');
  assert.match(payload.output.summary, /已审查 3\/5 个文件/);
  assert.equal(await conclusion('success', 'success', 'success', 'success', ''), 'failure');
  assert.equal(await conclusion('failure'), 'failure');
  assert.equal(await conclusion('success', 'failure'), 'failure');
  assert.equal(await conclusion('success', 'success', 'success', 'failure'), 'failure');
  assert.equal(await conclusion('failure', 'skipped', 'failure'), 'failure');
  assert.equal(await conclusion('cancelled', 'skipped', 'cancelled'), 'cancelled');
  assert.equal(await conclusion('cancelled'), 'cancelled');
});


for (const rollbackFails of [false, true]) {
  test(`最终报告存储失败必须撤回完成状态，回写失败=${rollbackFails} 仍明确保留失败`, async () => {
    const publication = createPublication();
    let coverage = false;
    await publication.run('GitHub 写入', [], async () => {});
    await finishPublication(publication, {
      writeSummary: async () => {},
      saveCoverage: async (complete) => {
        if (!complete && rollbackFails) throw new Error('coverage unavailable');
        coverage = complete;
      },
      saveReport: async () => { throw new Error('report unavailable'); },
    });
    assert.equal(coverage, rollbackFails);
    assert.deepEqual(publication.operations.filter(item => item.status === 'failed').map(item => [item.id, item.error]),
      rollbackFails ? [['保存发布报告', 'report unavailable'], ['撤回覆盖完成状态', 'coverage unavailable']]
        : [['保存发布报告', 'report unavailable']]);
    assert.equal(publication.operations.at(-1)?.id, '撤回覆盖完成状态');
  });
}

test('Check 详情最后写入，列出保存失败与覆盖撤回', async () => {
  const publication = createPublication();
  let text = '';
  const coverage: boolean[] = [];
  await publication.run('Review 正文', [], async () => {});
  await finishPublication(publication, {
    saveCoverage: async (complete) => { coverage.push(complete); },
    saveReport: async () => { throw new Error('report unavailable'); },
    writeCheckText: async () => { text = checkText({ operations: publication.operations }); },
  });
  assert.deepEqual(coverage, [true, false]);
  assert.match(text, /成功 3；失败 1；前置失败，未执行 0/);
  assert.match(text, /- 失败：保存发布报告/);
  assert.equal(publication.operations.at(-1)?.id, '写入 Check 详情');
});

test('Check 详情写入失败同样撤回覆盖完成状态，且只撤回一次', async () => {
  for (const reportFails of [false, true]) {
    const publication = createPublication();
    const coverage: boolean[] = [];
    await finishPublication(publication, {
      saveCoverage: async (complete) => { coverage.push(complete); },
      saveReport: async () => { if (reportFails) throw new Error('report unavailable'); },
      writeCheckText: async () => { throw new Error('output unavailable'); },
    });
    assert.deepEqual(coverage, [true, false]);
    assert.equal(publication.operations.filter(item => item.id === '撤回覆盖完成状态').length, 1);
  }
});

test('来源已审的文件数由发布器写入，没有时不输出', () => {
  assert.equal(sourceReviewedNotice(0), '');
  assert.equal(sourceReviewedNotice(508), '> 508 个文件因来源 PR 已审而未重复审查。');
});
