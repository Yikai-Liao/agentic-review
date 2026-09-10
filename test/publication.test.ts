import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createPublication } from '../scripts/publication.ts';
import { publishReview } from '../scripts/publish-review.ts';
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
  const state: {
    calls: Call[]; comments: any[]; reviews: any[]; resolved: Set<string>;
    fail: (call: Call) => Response | undefined;
    afterWrite: (call: Call) => void;
    fetchImpl: typeof fetch;
  } = {
    calls, comments, reviews, resolved,
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
          reviewThreads: { nodes: [123, 456].map(id => ({ id: `thread-${id}`, comments: { nodes: [{ databaseId: id }] } })),
            pageInfo: { hasNextPage: false, endCursor: null } },
        } } } });
        const id = call.body.variables.thread;
        if (query.startsWith('query')) return Response.json({ data: { node: { id, isResolved: resolved.has(id) } } });
        const operation = query.includes('unresolveReviewThread') ? 'unresolveReviewThread' : 'resolveReviewThread';
        if (operation === 'resolveReviewThread') resolved.add(id); else resolved.delete(id);
        state.afterWrite(call);
        return Response.json({ data: { [operation]: { thread: { id } } } });
      }
      if (call.url.endsWith('/reviews') && call.method === 'POST') {
        const review = { ...call.body, id: reviews.length + 1, user: bot, html_url: `https://github.test/review/${reviews.length + 1}` };
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
    expectedHeadSha: 'b'.repeat(40), footer: '[运行报告](https://github.test/run)', publicationId: 'run-1',
    api: 'https://api.github.test', requestSource: 'thread', requestCommentId: '900', requestRootCommentId: '123',
    fetchImpl: state.fetchImpl, ...override });
}

const mutations = (calls: Call[]) => calls.filter(call => call.method !== 'GET' && !call.body?.query?.startsWith('query'));

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
  ['thread 证据回复', (call: Call) => call.url.endsWith('/comments/123/replies') && call.body?.body?.includes('Pi thread')],
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
      assert.ok(state.comments.some(item => item.body.includes('Pi thread')));
      assert.equal(state.reviews.length, 1);
    } else {
      assert.equal(state.reviews.length, 0);
      assert.equal(state.resolved.size, 2);
      assert.ok(state.comments.some(item => item.line === 2));
    }
  });
}

test('多个失败全部汇总，删除的 root 不影响另一个 thread 和正文', async () => {
  const state = fixture();
  state.comments.shift();
  state.fail = call => call.body?.line === 1 ? new Response('invalid line', { status: 422 }) : undefined;
  const report = await publish(state);
  assert.equal(report.operations.filter(item => item.status === 'failed').length, 3);
  assert.ok(state.resolved.has('thread-456'));
  assert.ok(state.comments.some(item => item.line === 2));
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
  assert.ok(state.comments.some(item => item.body.includes('Pi thread')));
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


test('workflow 按依赖继续执行；发布或存储失败不能让 Check 成功', async () => {
  const workflow = readFileSync(new URL('../.github/workflows/agentic-review.yml', import.meta.url), 'utf8');
  const steps: Record<string, { outcome: string }> = Object.fromEntries([
    'publisher-checkout', 'publisher-node', 'download-progress', 'download-context', 'assemble-workspace',
    'download-result', 'publication-token', 'publish-review', 'publication-report', 'completion-workspace',
  ].map(id => [id, { outcome: 'success' }]));
  const needs = { review: { outputs: { context_artifact_id: '1', pi_outcome: 'success' } } };
  function shouldRun(id: string, cancelled = false) {
    const block = workflow.split(`        id: ${id}\n`)[1]?.split('\n      - name:')[0];
    const expression = block?.match(/if: \$\{\{ (.+) \}\}/)?.[1];
    assert.ok(expression, `Missing explicit dependency condition for ${id}`);
    // 执行工作流中的条件本身；status 函数必须显式出现，避免 Actions 隐含 success() 阻断独立步骤。
    assert.match(expression, /cancelled\(\)/);
    return runInNewContext(expression.replace(/steps\.([\w-]+)\.outcome/g, 'steps["$1"].outcome'), {
      steps, needs, cancelled: () => cancelled,
    });
  }
  steps['publication-token'].outcome = 'failure';
  assert.equal(shouldRun('publisher-checkout'), true);
  assert.equal(shouldRun('assemble-workspace'), true);
  assert.equal(shouldRun('publish-review'), false);
  steps['publication-token'].outcome = 'success';
  steps['download-context'].outcome = 'failure';
  assert.equal(shouldRun('download-result'), true);
  assert.equal(shouldRun('assemble-workspace'), false);
  steps['assemble-workspace'].outcome = 'skipped';
  assert.equal(shouldRun('publish-review'), false);
  steps['assemble-workspace'].outcome = 'success';
  steps['publish-review'].outcome = 'failure';
  assert.equal(shouldRun('publication-report'), true);
  assert.equal(shouldRun('completion-workspace'), false);
  steps['publish-review'].outcome = 'success';
  steps['publication-report'].outcome = 'failure';
  assert.equal(shouldRun('completion-workspace'), false);
  steps['publication-report'].outcome = 'skipped';
  assert.equal(shouldRun('completion-workspace'), false);
  steps['publication-report'].outcome = 'success';
  assert.equal(shouldRun('completion-workspace'), true);
  assert.equal(shouldRun('completion-workspace', true), false);

  const completion = workflow.split('      - name: Complete Agentic Review check')[1];
  assert.match(completion, /PUBLISH_JOB_STATUS: \$\{\{ job.status \}\}/);
  const script = completion.split('          script: |\n')[1].split('\n').map(line => line.slice(12)).join('\n');
  async function conclusion(jobStatus: string, publicationOutcome = 'success') {
    let payload: any;
    await runInNewContext(`(async () => { ${script} })()`, {
      process: { env: { REPOSITORY: 'owner/repo', CHECK_ID: '1', PI_REVIEW_OUTCOME: 'success',
        PUBLISH_REVIEW_OUTCOME: publicationOutcome, COMPLETION_WORKSPACE_OUTCOME: 'success', PUBLISH_JOB_STATUS: jobStatus } },
      github: { rest: { checks: { update: async (value: any) => { payload = value; } } } },
    });
    return payload.conclusion;
  }
  assert.equal(await conclusion('success'), 'success');
  assert.equal(await conclusion('failure'), 'failure');
  assert.equal(await conclusion('success', 'failure'), 'failure');
  assert.equal(await conclusion('cancelled'), 'cancelled');
});
