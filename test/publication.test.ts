import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { createPublication, finishPublication } from '../scripts/publication.ts';
import { buildFooter, checkText, coverageNotice, latestAutomaticRun, publishReview } from '../scripts/publish-review.ts';
import type { ReviewResult } from '../scripts/review-result.ts';
import { reviewCheckMessages } from '../scripts/review-language.ts';

const result: ReviewResult = {
  body: '审查正文；历史问题已修复。',
  comments: [1, 2].map(line => ({ path: 'src/example.ts', line, start_line: null, label: 'P2' as const, title: `问题 ${line}`, body: `问题 ${line} 的场景` })),
  thread_updates: [123, 456].map(root_comment_id => ({ root_comment_id, status: 'resolved', evidence: '当前代码已恢复鉴权检查，旧路径不再可达。' })),
  request_reply: { body: '已按请求重新核对。' },
};
const empty = { ...result, comments: [], thread_updates: [], request_reply: null };

type Call = { url: string; method: string; body: any };
function fixture() {
  const calls: Call[] = [];
  const comments: any[] = [123, 456].map(id => ({ id, in_reply_to_id: null, body: '旧问题', user: { login: 'maintainer' }, html_url: `https://github.test/comment/${id}` }));
  const reviews: any[] = [];
  const resolved = new Set<string>();
  const bot = { login: 'review-app[bot]' };
  const page = (items: any[], url: string) => {
    const number = Number(new URL(url).searchParams.get('page'));
    return Response.json(items.slice((number - 1) * 100, number * 100));
  };
  const state: {
    calls: Call[]; comments: any[]; reviews: any[]; resolved: Set<string>;
    fail: (call: Call) => Response | undefined;
    afterWrite: (call: Call) => void;
    started: Set<number>;
    fetchImpl: typeof fetch;
  } = {
    calls, comments, reviews, resolved,
    fail: (_call: Call): Response | undefined => undefined,
    afterWrite: (_call: Call) => {},
    started: new Set<number>(),
    fetchImpl: (async (input, init) => {
      const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const failure = state.fail(call);
      if (failure) return failure;
      if (call.method === 'GET' && call.url.includes('/comments?')) return page(comments, call.url);
      if (call.method === 'GET' && call.url.includes('/reviews?')) return page(reviews, call.url);
      if (call.url.endsWith('/graphql')) {
        const query = call.body.query as string;
        if (query.includes('reviewThreads')) return Response.json({ data: { repository: { pullRequest: {
          reviewThreads: { nodes: comments.filter(item => item.in_reply_to_id == null)
            .map(item => ({ id: `thread-${item.id}`, isResolved: resolved.has(`thread-${item.id}`), comments: { nodes: [{ databaseId: item.id }] } })),
          pageInfo: { hasNextPage: false, endCursor: null } },
        } } } });
        const id = call.body.variables.thread;
        assert.ok(query.includes('resolveReviewThread'), `Unexpected GraphQL operation: ${query}`);
        const operation = query.includes('unresolveReviewThread') ? 'unresolveReviewThread' : 'resolveReviewThread';
        if (operation === 'resolveReviewThread') resolved.add(id); else resolved.delete(id);
        state.afterWrite(call);
        return Response.json({ data: { [operation]: { thread: { id } } } });
      }
      if (call.url.endsWith('/reviews') && call.method === 'POST') {
        const id = reviews.length + 1;
        const review = { body: call.body.body, commit_id: call.body.commit_id, event: call.body.event, inline: call.body.comments,
          id, user: bot, html_url: `https://github.test/review/${id}` };
        reviews.push(review);
        for (const item of call.body.comments ?? []) {
          const commentId = 1000 + comments.length;
          comments.push({ ...item, id: commentId, in_reply_to_id: null, pull_request_review_id: id, user: bot, html_url: `https://github.test/comment/${commentId}` });
        }
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
      if (call.method === 'POST' && call.url.endsWith('/pulls/7/comments')) {
        const id = 1000 + comments.length;
        const comment = { ...call.body, id, in_reply_to_id: null, user: bot, html_url: `https://github.test/comment/${id}` };
        comments.push(comment);
        state.afterWrite(call);
        return Response.json(comment);
      }
      if (call.method === 'POST' && call.url.endsWith('/replies')) {
        const root = Number(call.url.match(/comments\/(\d+)\/replies$/)![1]);
        const id = 1000 + comments.length;
        const comment = { ...call.body, id, in_reply_to_id: root, user: bot, html_url: `https://github.test/comment/${id}` };
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
  const runId = Number(/\d+$/.exec(override.publicationId ?? 'run-1')![0]);
  if (override.requestSource === 'automatic') state.started.add(runId);
  return publishReview({ result, repository: 'owner/repo', pullNumber: 7, botLogin: 'review-app[bot]', token: 'write-token',
    expectedHeadSha: 'b'.repeat(40), footer: { links: '[运行记录](https://github.test/run) · [审查工作稿](https://github.test/run#artifacts)', details: 'openai/gpt-test' }, runUrl: 'https://github.test/run', publicationId: 'run-1',
    api: 'https://api.github.test', requestSource: 'thread', requestCommentId: '900', requestRootCommentId: '123',
    // 插入顺序表示首次开始执行的先后；重跑沿用原运行号，不改变首次执行位置。
    runId, latestAutomaticRun: async () => [...state.started].at(-1)!, fetchImpl: state.fetchImpl, ...override });
}

test('英文发布覆盖问题、索引和状态；历史英文标签在续审和切换语言后保持原分组', async () => {
  const state = fixture();
  const footer = buildFooter({ language: 'en', runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/workspace', model: 'test' });
  const body = 'The new path needs a decision.\n\n### What was checked\n\nChecked the caller.';
  const englishResult: ReviewResult = { body, comments: [
    { path: 'auth.ts', line: 1, start_line: null, label: '验证缺口', title: 'Unverified caller', body: 'The caller lacks a verified contract.' },
    { path: 'auth.ts', line: 2, start_line: null, label: '需人工确认', title: 'Confirm the new scope', body: 'The new scope needs an explicit decision.' },
  ], thread_updates: [], request_reply: null };
  ok(await publish(state, { language: 'en', footer, requestSource: 'automatic', result: englishResult }));
  const first = state.reviews.at(-1);
  assert.match(first.body, /## Automated review: 1 finding to address; 1 decision needs confirmation/);
  assert.ok(first.body.indexOf('### Confirmation needed') < first.body.indexOf('### What was checked'));
  const gap = state.comments.find(comment => comment.body.includes('> **Verification gap:'));
  assert.ok(gap);
  assert.doesNotMatch(first.body + first.inline.map((item: any) => item.body).join(''), /[\u3400-\u9fff]/);
  ok(await publish(state, { language: 'en', footer, requestSource: 'automatic', publicationId: 'run-2', result: {
    ...empty, body, thread_updates: [{ root_comment_id: gap.id, status: 'resolved', evidence: 'The caller contract is now verified.' }],
  } }));
  const next = state.reviews.at(-1).body;
  assert.match(next, /## Automated review: 1 decision needs confirmation/);
  assert.match(next, /### Confirmation needed\n\n- Confirmation needed: Confirm the new scope/);
  assert.match(next, /### Resolved this round/);
  assert.match(gap.body, /^\*\*✅ Resolved\*\*/);
  assert.doesNotMatch(next + gap.body, /[\u3400-\u9fff]/);
  ok(await publish(state, { language: 'zh-CN', requestSource: 'automatic', publicationId: 'run-3', result: { ...empty, body: '结论。' } }));
  assert.match(state.reviews.at(-1).body, /## 自动审查：1 项需要你确认/);
});

test('中英文发布失败都能在 Check 中读出失败操作与被阻断的后续操作', async () => {
  for (const language of ['en', 'zh-CN'] as const) {
    const state = fixture();
    state.fail = call => call.method === 'GET' && call.url.includes('/comments?')
      ? new Response('unavailable', { status: 503 }) : undefined;
    const report = await publish(state, { language, requestSource: 'automatic', result: empty });
    const text = checkText({ language, operations: report.operations });
    assert.ok(report.operations.some(item => item.status === 'failed'));
    if (language === 'en') {
      assert.match(text, /Failed: Read PR comments/);
      assert.match(text, /Blocked by a failed prerequisite: Review body/);
      assert.doesNotMatch(text, /[\u3400-\u9fff]/);
    } else {
      assert.match(text, /失败：读取 PR 评论/);
      assert.match(text, /前置失败，未执行：Review 正文/);
    }
  }
});

test('英文发布报告保存失败时，覆盖撤回与存储操作仍以英文记录', async () => {
  const publication = createPublication('en');
  let completion: boolean | undefined;
  await finishPublication(publication, {
    saveReport: async () => { throw new Error('storage unavailable'); },
    saveCoverage: async value => { completion = value; },
    writeCheckText: async () => {},
  });
  assert.equal(completion, false);
  const text = checkText({ language: 'en', operations: publication.operations });
  assert.match(text, /Failed: Save publication report/);
  assert.ok(publication.operations.some(item => item.id === 'Revoke coverage completion' && item.status === 'succeeded'));
  assert.doesNotMatch(text, /[\u3400-\u9fff]/);
});

const mutations = (calls: Call[]) => calls.filter(call => call.method !== 'GET' && !call.body?.query?.startsWith('query'));
const ok = (report: Awaited<ReturnType<typeof publishReview>>) =>
  assert.ok(report.operations.every(item => item.status === 'succeeded'), JSON.stringify(report.operations));
// 旧运行重跑：前置校验失败，其后的写入全部未执行。
const stale = (report: Awaited<ReturnType<typeof publishReview>>) => {
  assert.deepEqual(report.operations.filter(item => item.status === 'failed').map(item => item.id), ['确认没有更新的审查']);
  assert.match(report.operations.find(item => item.status === 'failed')!.error!, /has already started reviewing this head/);
};

test('新问题随总评在同一条 Review 中发布，标题行和索引由发布器生成', async () => {
  const state = fixture();
  const findings: ReviewResult['comments'] = [
    { path: 'src/auth.ts', line: 42, start_line: 40, label: 'P1', title: '过期会话仍能删除记录', body: '**什么情况下出错**：……' },
    { path: 'src/auth.ts', line: 50, start_line: null, label: '需人工确认', title: '登录失败时静默跳过审计', body: '**实际行为**：……' },
    { path: 'src/auth.ts', line: 60, start_line: null, label: '改进机会', title: '重复查询可以合并', body: '……' },
  ];
  const body = '结论。\n\n### 合并后的行为\n\n- 行为。\n\n### 核对了什么\n\n- 场景：结论（`src/auth.ts:10`）';
  const report = await publish(state, { requestSource: 'automatic', previousHeadSha: 'a'.repeat(40),
    coverage: { reviewed: 4, total: 4, sourceReviewed: 1 }, result: { ...empty, body, comments: findings } });
  ok(report);
  assert.equal(state.reviews.length, 1);
  const [review] = state.reviews;
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.commit_id, 'b'.repeat(40));
  assert.deepEqual(review.inline.map((item: any) => [item.path, item.line, item.start_line, item.side]),
    [['src/auth.ts', 42, 40, 'RIGHT'], ['src/auth.ts', 50, undefined, 'RIGHT'], ['src/auth.ts', 60, undefined, 'RIGHT']]);
  assert.match(review.inline[0].body, /^> \[!CAUTION\]\n> \*\*P1：过期会话仍能删除记录\*\*\n\n\*\*什么情况下出错\*\*/);
  assert.match(review.inline[1].body, /^> \[!IMPORTANT\]\n> \*\*需人工确认：登录失败时静默跳过审计\*\*/);
  assert.match(review.inline[0].body, /agentic-review-publication:/);
  const lines = review.body.split('\n');
  assert.match(lines[0], /^<!-- agentic-review-publication:[0-9a-f]+ --><!-- agentic-review:automatic-summary -->$/);
  assert.equal(lines[1], '## 自动审查：1 个问题需要修改，1 项需要你确认');
  // 索引位于模型正文的“核对了什么”之前，只列标题。
  assert.ok(review.body.includes('### 合并后的行为\n\n- 行为。\n\n### 需要修改\n\n- 🆕 P1：过期会话仍能删除记录\n\n### 需要你确认\n\n- 🆕 需人工确认：登录失败时静默跳过审计\n\n### 可选改进\n\n- 🆕 改进机会：重复查询可以合并\n\n### 核对了什么'));
  assert.ok(review.body.includes('<!-- agentic-review:run-metadata -->\n[运行记录](https://github.test/run) · [审查工作稿](https://github.test/run#artifacts) · 审至 `bbbbbbb`（上次 `aaaaaaa`） · 已审 4/4 个文件（其中 1 个由来源 PR 审过）\nopenai/gpt-test\n<!-- /agentic-review:run-metadata -->'));
  assert.doesNotMatch(review.body, /发布未全部完成/);
});

test('历史问题：仍未关闭的进入索引，本轮关闭的标注状态并 resolve，不另发回复', async () => {
  const state = fixture();
  const first = await publish(state, { requestSource: 'automatic', result: { ...empty, comments: result.comments } });
  ok(first);
  const [open, closing] = state.comments.filter(item => item.user.login === 'review-app[bot]');
  const report = await publish(state, { requestSource: 'automatic', publicationId: 'run-2', expectedHeadSha: 'c'.repeat(40), result: {
    ...empty, body: '结论。', thread_updates: [{ root_comment_id: closing.id, status: 'resolved', evidence: '新断言覆盖了原触发（`src/example.ts:2`）。' }],
  } });
  ok(report);
  assert.match(closing.body, /^\*\*✅ 已关闭\*\*（`ccccccc`）：新断言覆盖了原触发（`src\/example\.ts:2`）。 <!-- agentic-review-publication:[0-9a-f]+ --><!-- agentic-review:status -->\n\n> \[!WARNING\]\n> \*\*P2：问题 2\*\*/);
  assert.ok(state.resolved.has(`thread-${closing.id}`));
  assert.equal(state.comments.some(item => item.in_reply_to_id === closing.id), false);
  const latest = state.reviews.at(-1).body;
  assert.equal(latest.split('\n')[1], '## 自动审查：1 个问题需要修改');
  assert.ok(latest.includes(`### 需要修改\n\n- P2：问题 1 · [讨论](${open.html_url})\n\n### 本轮关闭\n\n- P2：问题 2 · [讨论](${closing.html_url})`));
  // 状态再次变化时替换原标注，不叠加。
  await publish(state, { requestSource: 'automatic', publicationId: 'run-3', expectedHeadSha: 'd'.repeat(40), result: {
    ...empty, body: '结论。', thread_updates: [{ root_comment_id: closing.id, status: 'reintroduced', evidence: '回退提交再次删除了该断言。' }],
  } });
  assert.match(closing.body, /^\*\*🔁 问题重现\*\*（`ddddddd`）：回退提交再次删除了该断言。 <!-- agentic-review-publication:[0-9a-f]+ --><!-- agentic-review:status -->\n\n> \[!WARNING\]/);
  assert.equal(closing.body.match(/agentic-review:status/g).length, 1);
  // 重现需要通知人：重开讨论并回复。
  assert.equal(state.resolved.has(`thread-${closing.id}`), false);
  assert.match(state.comments.find(item => item.in_reply_to_id === closing.id).body, /^\*\*状态更新：🔁 问题重现\*\*\n\n回退提交/);
  assert.ok(state.reviews.at(-1).body.includes(`- 🔁 P2：问题 2 · [讨论](${closing.html_url})`));
  // 关闭不回复，因此“重现 → 关闭 → 再次重现”时，最后一条回复仍是上次重现；再次重现仍须通知。
  await publish(state, { requestSource: 'automatic', publicationId: 'run-4', expectedHeadSha: 'e'.repeat(40), result: {
    ...empty, body: '结论。', thread_updates: [{ root_comment_id: closing.id, status: 'resolved', evidence: '断言已恢复（`src/example.ts:2`）。' }],
  } });
  const again = { ...empty, body: '结论。', thread_updates: [{ root_comment_id: closing.id, status: 'reintroduced' as const, evidence: '另一次回退又删除了该断言。' }] };
  await publish(state, { requestSource: 'automatic', publicationId: 'run-5', expectedHeadSha: 'f'.repeat(40), result: again });
  const replies = () => state.comments.filter(item => item.in_reply_to_id === closing.id);
  assert.deepEqual(replies().map(item => item.body.split('\n\n')[1]), ['回退提交再次删除了该断言。', '另一次回退又删除了该断言。']);
  // 同一运行重跑不重复回复；状态已是重现时，新运行也不重复。
  await publish(state, { requestSource: 'automatic', publicationId: 'run-5', expectedHeadSha: 'f'.repeat(40), result: again });
  await publish(state, { requestSource: 'automatic', publicationId: 'run-6', expectedHeadSha: 'f'.repeat(40), result: again });
  assert.equal(replies().length, 2);
  // 回复失败而标注已写入时，重跑仍补发回复。
  await publish(state, { requestSource: 'automatic', publicationId: 'run-7', expectedHeadSha: 'a'.repeat(40), result: {
    ...empty, body: '结论。', thread_updates: [{ root_comment_id: closing.id, status: 'resolved', evidence: '断言再次恢复（`src/example.ts:2`）。' }],
  } });
  const third = { ...again, thread_updates: [{ ...again.thread_updates[0], evidence: '第三次回退删除了该断言。' }] };
  state.fail = call => call.url.endsWith(`/comments/${closing.id}/replies`) ? new Response('unavailable', { status: 502 }) : undefined;
  const failed = await publish(state, { requestSource: 'automatic', publicationId: 'run-8', expectedHeadSha: 'b'.repeat(40), result: third });
  assert.deepEqual(failed.operations.filter(item => item.status === 'failed').map(item => item.id), [`thread ${closing.id} 状态回复`]);
  assert.match(closing.body, /^\*\*🔁 问题重现\*\*/);
  state.fail = () => undefined;
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-8', expectedHeadSha: 'b'.repeat(40), result: third }));
  assert.equal(replies().length, 3);
});

test('他人发起的讨论无法改写原文，状态变化以回复记录并只附运行链接', async () => {
  const state = fixture();
  state.comments[1].user.login = 'other[bot]';
  const report = await publish(state, { requestSource: 'automatic', result: { ...result, request_reply: null } });
  ok(report);
  assert.ok(state.resolved.has('thread-123') && state.resolved.has('thread-456'));
  for (const root of [123, 456]) {
    const reply = state.comments.find(comment => comment.in_reply_to_id === root)!.body;
    assert.match(reply, /^\*\*状态更新：✅ 已关闭\*\*\n\n当前代码已恢复鉴权检查/);
    assert.match(reply, /\[运行记录\]\(https:\/\/github\.test\/run\)/);
    assert.doesNotMatch(reply, /Model:/);
    assert.equal(state.comments.find(item => item.id === root).body, '旧问题');
  }
  assert.ok(state.reviews[0].body.includes('### 本轮关闭\n\n- 旧问题 · [讨论](https://github.test/comment/123)\n- 旧问题 · [讨论](https://github.test/comment/456)'));
});

test('新的自动总评收起更早的自动总评，评论请求的答复不收起也不被收起', async () => {
  const state = fixture();
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: { ...empty, comments: [result.comments[0]] } });
  await publish(state, { requestSource: 'pr_comment', publicationId: 'run-2',
    result: { ...empty, body: '<!-- agentic-review:automatic-summary -->\n正文中的同名标记' } });
  const original = state.reviews[0].body;
  const report = await publish(state, { requestSource: 'automatic', publicationId: 'run-3', result: { ...empty, comments: [result.comments[1]] } });
  ok(report);
  const [first, comment, latest] = state.reviews;
  const [tag, pointer, ...rest] = first.body.split('\n');
  assert.equal(tag, original.split('\n')[0]);
  assert.equal(pointer, '> 已被[`bbbbbbb` 的审查](https://github.test/review/3)取代。<!-- agentic-review:superseded -->');
  assert.equal(rest.join('\n'), `\n<details><summary>原总评：自动审查：1 个问题需要修改</summary>\n\n${original.split('\n').slice(1).join('\n')}\n\n</details>`);
  assert.doesNotMatch(comment.body, /superseded/);
  assert.doesNotMatch(latest.body, /superseded/);
  // 重跑不重复收起；更早运行的重跑不会恢复已收起的总评。
  const before = mutations(state.calls).length;
  await publish(state, { requestSource: 'automatic', publicationId: 'run-3', result: { ...empty, comments: [result.comments[1]] } });
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: { ...empty, comments: [result.comments[0]] } });
  assert.equal(mutations(state.calls).length, before);
  assert.equal(state.reviews.length, 3);
});

test('结论不变且没有新问题或状态变化时，就地更新最新总评，不新增 Review', async () => {
  const state = fixture();
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: { ...empty, comments: [result.comments[0]] } });
  const report = await publish(state, { requestSource: 'automatic', publicationId: 'run-2', expectedHeadSha: 'c'.repeat(40),
    previousHeadSha: 'b'.repeat(40), result: { ...empty, body: '只合并了 main，结论不变。' } });
  ok(report);
  assert.equal(state.reviews.length, 1);
  assert.equal(report.reviewUrl, 'https://github.test/review/1');
  assert.match(state.reviews[0].body, /只合并了 main，结论不变。/);
  assert.match(state.reviews[0].body, /审至 `ccccccc`（上次 `bbbbbbb`）/);
  assert.ok(state.reviews[0].body.includes('- P2：问题 1 · [讨论](https://github.test/comment/1002)'));
  // 就地更新保留上一轮的发布标记；旧运行重跑明确失败，既不改写也不重复发布问题。
  const before = mutations(state.calls).length;
  stale(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: { ...empty, comments: [result.comments[0]] } }));
  assert.equal(mutations(state.calls).length, before);
  assert.match(state.reviews[0].body, /只合并了 main，结论不变。/);
  // 执行就地更新的运行重跑时认出自己，不产生写入。
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-2', expectedHeadSha: 'c'.repeat(40),
    previousHeadSha: 'b'.repeat(40), result: { ...empty, body: '只合并了 main，结论不变。' } }));
  assert.equal(mutations(state.calls).length, before);
  // 结论标题变化时发新 Review，旧的收起。
  await publish(state, { requestSource: 'automatic', publicationId: 'run-3', expectedHeadSha: 'd'.repeat(40), result: {
    ...empty, body: '已修复。', thread_updates: [{ root_comment_id: 1002, status: 'resolved', evidence: '修复覆盖了原触发场景。' }],
  } });
  assert.equal(state.reviews.length, 2);
  assert.equal(state.reviews[1].body.split('\n')[1], '## 自动审查：没有需要处理的问题');
  assert.match(state.reviews[0].body.split('\n')[1], /agentic-review:superseded/);
});

test('无法绑定 diff 行的问题先于总评发布为文件级讨论，计入标题、索引和下一轮状态', async () => {
  const state = fixture();
  const fileLevel: ReviewResult['comments'][number] = {
    path: 'docs/deploy.md', line: null, start_line: null, label: 'P2', title: '部署文档漏掉新增的权限', body: '**什么情况下出错**：……',
  };
  const run = () => publish(state, { requestSource: 'automatic', publicationId: 'run-1',
    result: { ...empty, body: '结论。', comments: [fileLevel, result.comments[0]] } });
  ok(await run());
  const [review] = state.reviews;
  assert.deepEqual(review.inline.map((item: any) => item.path), ['src/example.ts']);
  assert.equal(review.body.split('\n')[1], '## 自动审查：2 个问题需要修改');
  assert.ok(review.body.includes('- 🆕 P2：部署文档漏掉新增的权限'));
  const posted = mutations(state.calls).filter(call => call.url.endsWith('/pulls/7/comments'));
  assert.equal(posted.length, 1);
  assert.deepEqual([posted[0].body.path, posted[0].body.subject_type, posted[0].body.commit_id], ['docs/deploy.md', 'file', 'b'.repeat(40)]);
  assert.match(posted[0].body.body, /^> \[!WARNING\]\n> \*\*P2：部署文档漏掉新增的权限\*\*\n\n\*\*什么情况下出错\*\*/);
  const order = mutations(state.calls).map(call => call.url);
  assert.ok(order.findIndex(url => url.endsWith('/pulls/7/comments')) < order.findIndex(url => url.endsWith('/pulls/7/reviews')));
  // 重跑不重复发布。
  const before = mutations(state.calls).length;
  ok(await run());
  assert.equal(mutations(state.calls).length, before);
  // 下一轮没有新问题时，文件级讨论仍作为未解决问题留在标题和索引中。
  await publish(state, { requestSource: 'automatic', publicationId: 'run-2', expectedHeadSha: 'c'.repeat(40), result: { ...empty, body: '结论不变。' } });
  assert.equal(state.reviews[0].body.split('\n')[1], '## 自动审查：2 个问题需要修改');
  const thread = state.comments.find(item => item.subject_type === 'file');
  assert.ok(state.reviews[0].body.includes(`- P2：部署文档漏掉新增的权限 · [讨论](${thread.html_url})`));
});

test('文件级讨论发布失败时不发布总评；后续运行发布后，原运行重跑不再写入任何内容', async () => {
  const state = fixture();
  const fileLevel: ReviewResult['comments'][number] = {
    path: 'docs/deploy.md', line: null, start_line: null, label: 'P2', title: '部署文档漏掉新增的权限', body: '……',
  };
  // 重跑使用封存的同一结果；run-1 关闭了他人发起的讨论 123。
  const first = { ...empty, body: '结论。', comments: [fileLevel],
    thread_updates: [{ root_comment_id: 123, status: 'resolved' as const, evidence: '鉴权检查已恢复（`src/auth.ts:3`）。' }] };
  state.fail = call => call.method === 'POST' && call.url.endsWith('/pulls/7/comments') ? new Response('unavailable', { status: 502 }) : undefined;
  const failed = await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first });
  assert.deepEqual(failed.operations.filter(item => item.status !== 'succeeded').map(item => `${item.id} ${item.status}`),
    ['finding 1 (docs/deploy.md:file) failed', 'Review 正文 blocked']);
  assert.equal(state.reviews.length, 0);
  state.fail = () => undefined;
  // 同一 head 上更晚启动的 run-2 依据新证据判定 123 重现，并发布总评。
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: { ...empty, body: '结论。',
    thread_updates: [{ root_comment_id: 123, status: 'reintroduced', evidence: '回退提交再次跳过了鉴权检查。' }] } }));
  assert.equal(state.resolved.has('thread-123'), false);
  // run-1 重跑：不补发讨论、不关闭 123、不发布或收起总评；run-2 的结论保持为当前结论。
  const before = mutations(state.calls).length;
  stale(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first }));
  assert.equal(mutations(state.calls).length, before);
  assert.equal(state.reviews.length, 1);
  assert.doesNotMatch(state.reviews[0].body.split('\n')[1], /agentic-review:superseded/);
  assert.equal(state.resolved.has('thread-123'), false);
});

test('文件级讨论发布失败后、没有更新运行时，重跑补发讨论并发布总评，再次重跑不重复', async () => {
  const state = fixture();
  const fileLevel: ReviewResult['comments'][number] = {
    path: 'docs/deploy.md', line: null, start_line: null, label: 'P2', title: '部署文档漏掉新增的权限', body: '……',
  };
  const first = { ...empty, body: '结论。', comments: [fileLevel] };
  // 第一次 POST 实际已生效但响应丢失，重跑按标记识别，不重复创建。
  state.afterWrite = call => { if (call.method === 'POST' && call.url.endsWith('/pulls/7/comments')) throw new Error('response lost'); };
  const failed = await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first });
  assert.deepEqual(failed.operations.filter(item => item.status !== 'succeeded').map(item => `${item.id} ${item.status}`),
    ['finding 1 (docs/deploy.md:file) failed', 'Review 正文 blocked']);
  assert.equal(state.reviews.length, 0);
  state.afterWrite = () => {};
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first }));
  assert.equal(state.comments.filter(item => item.subject_type === 'file').length, 1);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].body.split('\n')[1], '## 自动审查：1 个问题需要修改');
  const before = mutations(state.calls).length;
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first }));
  assert.equal(mutations(state.calls).length, before);
});

test('更新运行只改了讨论状态、总评未发出时，旧运行重跑同样停止写入', async () => {
  const state = fixture();
  const fileLevel: ReviewResult['comments'][number] = {
    path: 'docs/deploy.md', line: null, start_line: null, label: 'P2', title: '部署文档漏掉新增的权限', body: '……',
  };
  const first = { ...empty, body: '结论。',
    thread_updates: [{ root_comment_id: 123, status: 'resolved' as const, evidence: '鉴权检查已恢复（`src/auth.ts:3`）。' }] };
  // run-1 的总评已发布，但关闭 123 的状态同步失败。
  state.fail = call => call.body?.query?.startsWith('mutation') ? new Response('unavailable', { status: 503 }) : undefined;
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first });
  // run-2 写下 123 重现的回复，文件级讨论失败，总评未发出。
  state.fail = call => call.method === 'POST' && call.url.endsWith('/pulls/7/comments') ? new Response('unavailable', { status: 502 }) : undefined;
  await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: { ...empty, body: '结论。', comments: [fileLevel],
    thread_updates: [{ root_comment_id: 123, status: 'reintroduced', evidence: '回退提交再次跳过了鉴权检查。' }] } });
  assert.equal(state.reviews.length, 1);
  state.fail = () => undefined;
  const before = mutations(state.calls).length;
  stale(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first }));
  assert.equal(mutations(state.calls).length, before);
  assert.equal(state.resolved.has('thread-123'), false);
});

test('更新运行的唯一写入被评论请求替换后，旧运行重跑仍停止写入，新运行照常更新状态', async () => {
  const state = fixture();
  const fileLevel: ReviewResult['comments'][number] = {
    path: 'docs/deploy.md', line: null, start_line: null, label: 'P2', title: '部署文档漏掉新增的权限', body: '……',
  };
  const first = { ...empty, body: '结论。', comments: [result.comments[0]] };
  // run-1 发布问题 X，但关闭 456 的状态同步失败（456 是他人发起的讨论）。
  const firstWithUpdate = { ...first, thread_updates: [{ root_comment_id: 456, status: 'resolved' as const, evidence: '已修复（`src/a.ts:1`）。' }] };
  state.fail = call => call.body?.query?.startsWith('mutation') ? new Response('unavailable', { status: 503 }) : undefined;
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: firstWithUpdate });
  const x = state.comments.find(item => item.user.login === 'review-app[bot]' && item.line != null)!;
  // run-2 只写下关闭 X 的状态标注；文件级讨论失败，总评未发出。
  state.fail = call => call.method === 'POST' && call.url.endsWith('/pulls/7/comments') ? new Response('unavailable', { status: 502 }) : undefined;
  await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: { ...empty, body: '结论。', comments: [fileLevel],
    thread_updates: [{ root_comment_id: x.id, status: 'resolved', evidence: '修复覆盖了原触发（`src/example.ts:2`）。' }] } });
  state.fail = () => undefined;
  // run-3 的评论请求判定 X 重现，替换了 run-2 的标注。
  ok(await publish(state, { requestSource: 'pr_comment', publicationId: 'run-3', requestCommentId: '900', requestRootCommentId: '',
    result: { ...empty, body: '按请求复核。', thread_updates: [{ root_comment_id: x.id, status: 'reintroduced', evidence: '回退提交再次引入了原问题。' }] } }));
  assert.match(x.body, /^\*\*🔁 问题重现\*\*/);
  // run-1 重跑：不关闭 456，不改写 X。
  const before = mutations(state.calls).length;
  stale(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: firstWithUpdate }));
  assert.equal(mutations(state.calls).length, before);
  assert.equal(state.resolved.has('thread-456'), false);
  // 之后的新运行照常更新状态。
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-4', expectedHeadSha: 'c'.repeat(40), result: {
    ...empty, body: '结论。', thread_updates: [{ root_comment_id: x.id, status: 'resolved', evidence: '再次修复（`src/example.ts:2`）。' }] } }));
  assert.ok(state.resolved.has(`thread-${x.id}`));
});

test('按首次 Check 创建顺序取最新自动审查，忽略运行号大小、重跑及评论请求', async () => {
  const head = 'b'.repeat(40);
  let checkId = 0;
  const check = (external_id: string | null, slug = 'review-app') => ({ id: ++checkId, external_id, app: { slug } });
  const pages = [
    [...Array.from({ length: 98 }, () => check(null)), check(`1:7:${'a'.repeat(40)}:${head}:automatic:30:1`), check(`1:7:base:${head}:pr_comment:35:2`)],
    [check(`1:7:base:${head}:automatic:20:1`), check(`1:7:base:${head}:automatic:90:1`, 'other-app'), check(`1:8:base:${head}:automatic:80:1`),
      check(`2:7:base:${head}:automatic:70:1`), check(`1:7:base:${'c'.repeat(40)}:automatic:60:1`), check('1:7:base:x'),
      check(`1:7:base:${head}:automatic:30:2`), check(`1:7:base:${head}:thread:99:1`)],
  ];
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    return Response.json({ check_runs: pages[Number(new URL(url).searchParams.get('page')) - 1] });
  }) as typeof fetch;
  assert.equal(await latestAutomaticRun({ api: 'https://api.github.test', token: 't', repository: 'owner/repo', repositoryId: '1',
    pullNumber: 7, headSha: head, appSlug: 'review-app', fetchImpl }), 20);
  assert.deepEqual(requested.map(url => new URL(url).pathname + new URL(url).search),
    [`/repos/owner/repo/commits/${head}/check-runs?filter=all&per_page=100&page=1`, `/repos/owner/repo/commits/${head}/check-runs?filter=all&per_page=100&page=2`]);
});

test('较小运行号在较大运行号后首次执行时仍能发布，随后重跑旧审查仍被阻止', async () => {
  const state = fixture();
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: empty }));
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: empty }));
  const before = mutations(state.calls).length;
  stale(await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: empty }));
  assert.equal(mutations(state.calls).length, before);
});

for (const failReply of [false, true]) {
  test(`局部请求失败=${failReply} 不取代完整审查，自动审查重新核对后保留最新讨论状态`, async () => {
    const state = fixture();
    state.fail = call => call.body?.query?.startsWith('mutation') ? new Response('unavailable', { status: 503 }) : undefined;
    await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: {
      ...empty, thread_updates: [result.thread_updates[0]],
    } });
    state.fail = call => failReply && call.url.endsWith('/replies') ? new Response('unavailable', { status: 503 }) : undefined;
    await publish(state, { requestSource: 'thread', publicationId: 'run-2', threadReplyOnly: true, result: {
      ...result, comments: [], thread_updates: [{ root_comment_id: 123, status: 'reintroduced', evidence: '评论请求确认原触发仍然存在。' }],
    } });
    state.fail = () => undefined;
    ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: {
      ...empty, body: '重新核对当前讨论后，保留评论请求确认的问题状态。',
    } }));
    assert.equal(state.resolved.has('thread-123'), false);
  });
}

test('评论请求首次执行不因较大运行号的审查已经执行而失去答复', async () => {
  const state = fixture();
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-9', result: empty }));
  for (const requestSource of ['pr_comment', 'thread']) {
    ok(await publish(state, { requestSource, publicationId: 'run-1' }));
  }
  assert.ok(state.comments.some(item => item.body.includes('已按请求重新核对。')));
});

test('总评已被更新运行收起后重跑，不改动讨论状态', async () => {
  const state = fixture();
  const first = { ...empty, body: '结论。',
    thread_updates: [{ root_comment_id: 123, status: 'resolved' as const, evidence: '鉴权检查已恢复（`src/auth.ts:3`）。' }] };
  // run-1 总评已发布，但 thread 状态同步失败。
  state.fail = call => call.body?.query?.startsWith('mutation') ? new Response('unavailable', { status: 503 }) : undefined;
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first });
  assert.equal(state.reviews.length, 1);
  state.fail = () => undefined;
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: { ...empty, body: '结论。',
    thread_updates: [{ root_comment_id: 123, status: 'reintroduced', evidence: '回退提交再次跳过了鉴权检查。' }] } }));
  assert.match(state.reviews[0].body.split('\n')[1], /agentic-review:superseded/);
  // run-1 重跑：收起后的首行仍保留 run-1 的标记，但已有更新运行的总评，不把 123 重新关闭。
  const before = mutations(state.calls).length;
  stale(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first }));
  assert.equal(mutations(state.calls).length, before);
  assert.equal(state.resolved.has('thread-123'), false);
});

test('部分覆盖时标题写明未审完，未审文件清单在正文前', async () => {
  const state = fixture();
  await publish(state, { requestSource: 'automatic', coverage: { reviewed: 2, total: 3, sourceReviewed: 0 },
    coverageNotice: coverageNotice(['auth.ts'], 3), result: { ...empty, body: '结论。' } });
  const body = state.reviews[0].body;
  assert.equal(body.split('\n')[1], '## 自动审查：未审完（已审 2/3 个文件），已审部分没有需要处理的问题');
  assert.ok(body.indexOf('- `auth.ts`') < body.indexOf('结论。'));
});

test('收起失败记为发布失败，不影响已发布的新总评', async () => {
  const state = fixture();
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: { ...empty, comments: [result.comments[0]] } });
  state.fail = call => call.method === 'PUT' ? new Response('forbidden', { status: 403 }) : undefined;
  const report = await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: { ...empty, comments: [result.comments[1]] } });
  assert.equal(report.reviewUrl, 'https://github.test/review/2');
  assert.deepEqual(report.operations.filter(item => item.status !== 'succeeded').map(item => item.id), ['收起旧 Review 1']);
  // 重跑复用已发布的新总评，只补做失败的收起。
  state.fail = () => undefined;
  const rerun = await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: { ...empty, comments: [result.comments[1]] } });
  ok(rerun);
  assert.equal(state.reviews.length, 2);
  assert.match(state.reviews[0].body.split('\n')[1], /agentic-review:superseded/);
  assert.doesNotMatch(state.reviews[1].body, /superseded/);
});

test('Check 详情汇总运行、结果、覆盖、用量和未成功的发布操作', () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const text = checkText({
    footer: { links: '[运行记录](https://github.test/run)', details: 'openai/gpt-test' }, result,
    usage: { turns: 3, priceKnown: true, first: zero, total: zero },
    coverage: { reviewed: 4, total: 5, sourceReviewed: 2 },
    operations: [
      { id: 'Review 正文', status: 'succeeded', dependencies: [] },
      { id: 'thread 123 状态同步', status: 'failed', dependencies: [], error: 'secret API response' },
      { id: '收起旧 Review 1', status: 'blocked', dependencies: [] },
    ],
  });
  assert.match(text, /## 运行\n\n\[运行记录\]\(https:\/\/github\.test\/run\)\n\nopenai\/gpt-test\n/);
  assert.match(text, /新问题 2 条；历史问题状态变化 2 条（✅ 已关闭 2）/);
  assert.match(text, /已审查 4\/5 个文件；来源 PR 已审而未重复审查 2 个/);
  assert.match(text, /3 个审查回合/);
  assert.match(text, /成功 1；失败 1；前置失败，未执行 1/);
  assert.match(text, /- 失败：thread 123 状态同步/);
  assert.match(text, /- 前置失败，未执行：收起旧 Review 1/);
  assert.doesNotMatch(text, /secret API response|- 成功/);
  // 发布前校验失败时只有操作记录。
  assert.match(checkText({ operations: [{ id: '发布前校验', status: 'failed', dependencies: [] }] }), /^## 发布操作/);
});

test('风险升高时重开已关闭 thread', async () => {
  const state = fixture();
  state.resolved.add('thread-123');
  await publish(state, { requestSource: 'automatic', result: {
    ...empty, thread_updates: [{ ...result.thread_updates[0], status: 'severity_increased' }],
  } });
  assert.equal(state.resolved.has('thread-123'), false);
  assert.ok(state.calls.some(call => call.body?.query?.includes('unresolveReviewThread')));
});

test('仅正文 Review 不附带 inline comments', async () => {
  const state = fixture();
  await publish(state, { requestSource: 'automatic', result: { ...empty, body: '未发现需要处理的问题。' } });
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].inline, undefined);
  assert.equal(state.reviews[0].body.split('\n')[1], '## 自动审查：没有需要处理的问题');
});

test('局部 thread 请求仅回复人类 root，不创建 Review 或改变 thread 状态', async () => {
  const state = fixture();
  await publish(state, { threadReplyOnly: true, result: {
    body: '已复核该问题，结论未变。', comments: [], thread_updates: [], request_reply: { body: '结论未变，当前问题仍需关注。' },
  } });
  assert.equal(state.reviews.length, 0);
  assert.equal(state.calls.some(call => call.url.includes('/reviews')), false);
  const reply = state.comments.find(item => item.in_reply_to_id === 123).body;
  assert.match(reply, /^结论未变，当前问题仍需关注。\n\n<!-- agentic-review:run-metadata -->\n\[运行记录\]/);
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
  assert.ok(state.resolved.has('thread-123') && state.resolved.has('thread-456'));
});

test('同一 thread 的状态与回复并行，正文等待两项结束并包含失败结果', { timeout: 5000 }, async () => {
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
  const pending = publish(state, { requestSource: 'automatic', result: { ...empty, thread_updates: [result.thread_updates[0]] } });
  await ready;
  assert.equal(state.reviews.length, 0);
  release();
  const report = await pending;
  assert.ok(state.comments.some(item => item.body.includes('状态更新：')));
  assert.equal(state.resolved.size, 0);
  assert.equal(report.operations.find(item => item.id === 'thread 123 状态同步')?.status, 'failed');
  assert.equal(report.operations.find(item => item.id === 'thread 123 状态回复')?.status, 'succeeded');
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
  ['Review 正文', (call: Call) => call.url.endsWith('/reviews') && call.method === 'POST'],
  ['请求回复', (call: Call) => call.body?.body?.includes('已按请求重新核对。')],
  ['thread 状态回复', (call: Call) => call.url.endsWith('/comments/123/replies') && call.body?.body?.includes('状态更新：')],
  ['thread 状态同步', (call: Call) => call.body?.query?.startsWith('mutation') && call.body?.variables.thread === 'thread-123'],
] as const) {
  test(`${name} 遇到未预料异常，其余独立写入继续执行`, async () => {
    const state = fixture();
    state.fail = call => { if (matches(call)) throw new Error('未预料的传输故障'); return undefined; };
    const report = await publish(state);
    assert.equal(report.operations.filter(item => item.status === 'failed').length, 1, JSON.stringify(report));
    assert.equal(report.operations.filter(item => item.status === 'blocked').length, 0, JSON.stringify(report));
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
    const report = await publish(state, { requestSource: 'automatic', result: { ...result, request_reply: null } });
    assert.ok(report.operations.some(item => item.status === 'failed'));
    // 总评索引需要三项读取，任一失败都不发布总评。
    assert.equal(state.reviews.length, 0);
    if (kind === 'comments') {
      assert.equal(state.resolved.size, 0);
      assert.equal(state.comments.length, 2);
    } else if (kind === 'threads') {
      assert.equal(state.resolved.size, 0);
      assert.ok(state.comments.some(item => item.body.includes('状态更新：')));
    } else {
      // 讨论状态不依赖 Review 列表，读取失败只阻断总评。
      assert.equal(state.resolved.size, 2);
    }
  });
}

for (const invalidRoot of ['missing', 'reply']) test(`${invalidRoot} root 校验失败不影响其他 thread 和正文`, async () => {
  const state = fixture();
  if (invalidRoot === 'missing') state.comments.shift();
  else state.comments[0].in_reply_to_id = 1;
  const report = await publish(state, { requestSource: 'automatic', result: { ...result, request_reply: null } });
  assert.deepEqual(report.operations.filter(item => item.status === 'failed').map(item => item.id), ['thread 123 归属校验']);
  assert.equal(report.operations.filter(item => item.status === 'blocked').length, 3);
  assert.ok(state.resolved.has('thread-456'));
  assert.equal(state.calls.some(call => call.url.endsWith('/comments/123/replies')), false);
  assert.match(state.reviews[0].body, /发布未全部完成/);
});

test('部分成功后重跑核对远端标记，只补做失败项并更新正文中的发布结果', async () => {
  const state = fixture();
  state.fail = call => call.body?.query?.startsWith('mutation') && call.body.variables.thread === 'thread-123'
    ? new Response('unavailable', { status: 503 }) : undefined;
  await publish(state);
  const firstCount = mutations(state.calls).length;
  state.fail = () => undefined;
  const report = await publish(state);
  ok(report);
  const retried = mutations(state.calls).slice(firstCount);
  assert.deepEqual(retried.map(call => call.body?.variables?.thread ?? call.method), ['thread-123', 'PATCH', 'PUT']);
  assert.equal(state.reviews.length, 1);
  assert.doesNotMatch(state.reviews[0].body, /发布未全部完成/);
  assert.equal(state.comments.filter(item => item.line === 2).length, 1);
});

test('写入已生效但响应丢失时，本轮不重试；下次从远端识别成功项', async () => {
  const state = fixture();
  state.afterWrite = call => { if (call.url.endsWith('/comments/123/replies') || call.url.endsWith('/reviews')) throw new Error('response lost'); };
  const first = await publish(state);
  // 状态回复、请求回复都写在 root 123 下，连同总评共三项响应丢失。
  assert.equal(first.operations.filter(item => item.status === 'failed').length, 3);
  assert.equal(state.reviews.length, 1);
  state.afterWrite = () => {};
  const next = await publish(state);
  ok(next);
  assert.equal(state.comments.filter(item => item.in_reply_to_id === 123 && item.body.includes('状态更新：')).length, 1);
  assert.equal(state.comments.filter(item => item.body.includes('已按请求重新核对。')).length, 1);
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
  await assert.rejects(publish(state, { previousHeadSha: 'main' }), /Invalid previous review head/);
  assert.deepEqual(state.calls, []);
});

test('重跑读取全部分页，第二页的发布标记仍能阻止重复写入', async () => {
  const state = fixture();
  await publish(state);
  const fillers = Array.from({ length: 100 }, (_, index) => ({ id: 2000 + index, in_reply_to_id: 1, body: '旧记录', user: { login: 'maintainer' } }));
  state.comments.unshift(...fillers);
  state.reviews.unshift(...fillers);
  const before = mutations(state.calls).length;
  const report = await publish(state);
  ok(report);
  assert.equal(mutations(state.calls).length, before);
  assert.ok(state.calls.some(call => call.url.includes('/comments?per_page=100&page=2')));
  assert.ok(state.calls.some(call => call.url.includes('/reviews?per_page=100&page=2')));
});

test('GraphQL 返回 HTTP 200 的业务错误仍记为失败，状态回复继续', async () => {
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
  ok(report);
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
  assert.equal(execution.find((step: { id?: string }) => step.id === 'publish-review').env.REVIEW_REPOSITORY_ID,
    '${{ inputs.repository_id }}');
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
        COVERAGE_PENDING: pending, COVERAGE_TOTAL: '5', CHECK_TEXT: checkDetails,
        REVIEW_CHECK_MESSAGES: JSON.stringify(reviewCheckMessages('zh-CN')) } },
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
