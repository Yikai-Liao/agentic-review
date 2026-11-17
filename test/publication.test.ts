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
    // Insertion order is the order of first execution; reruns keep the original run number and do not move that position.
    runId, latestAutomaticRun: async () => [...state.started].at(-1)!, fetchImpl: state.fetchImpl, ...override });
}

test('English publication covers findings, index, and status; earlier English labels keep their grouping across re-reviews and language switches', async () => {
  const state = fixture();
  const footer = buildFooter({ language: 'en', runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/workspace', model: 'test' });
  const body = 'The new path needs a decision.\n\n### What was checked\n\nChecked the caller.';
  const englishResult: ReviewResult = { body, comments: [
    { path: 'auth.ts', line: 1, start_line: null, label: 'verification-gap', title: 'Unverified caller', body: 'The caller lacks a verified contract.' },
    { path: 'auth.ts', line: 2, start_line: null, label: 'confirmation', title: 'Confirm the new scope', body: 'The new scope needs an explicit decision.' },
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

test('Chinese and English publication failures both show the failed and blocked operations in the Check', async () => {
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

test('When saving an English publication report fails, coverage rollback and storage operations are still recorded in English', async () => {
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
// Rerun of an old run: the precondition fails and no later write runs.
const stale = (report: Awaited<ReturnType<typeof publishReview>>) => {
  assert.deepEqual(report.operations.filter(item => item.status === 'failed').map(item => item.id), ['确认没有更新的审查']);
  assert.match(report.operations.find(item => item.status === 'failed')!.error!, /has already started reviewing this head/);
};

test('New findings publish with the summary in one review, and the publisher generates the title line and index', async () => {
  const state = fixture();
  const findings: ReviewResult['comments'] = [
    { path: 'src/auth.ts', line: 42, start_line: 40, label: 'P1', title: '过期会话仍能删除记录', body: '**什么情况下出错**：……' },
    { path: 'src/auth.ts', line: 50, start_line: null, label: 'confirmation', title: '登录失败时静默跳过审计', body: '**实际行为**：……' },
    { path: 'src/auth.ts', line: 60, start_line: null, label: 'improvement', title: '重复查询可以合并', body: '……' },
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
  // The index sits before the model body's "what was checked" section and lists titles only.
  assert.ok(review.body.includes('### 合并后的行为\n\n- 行为。\n\n### 需要修改\n\n- 🆕 P1：过期会话仍能删除记录\n\n### 需要你确认\n\n- 🆕 需人工确认：登录失败时静默跳过审计\n\n### 可选改进\n\n- 🆕 改进机会：重复查询可以合并\n\n### 核对了什么'));
  assert.ok(review.body.includes('<!-- agentic-review:run-metadata -->\n[运行记录](https://github.test/run) · [审查工作稿](https://github.test/run#artifacts) · 审至 `bbbbbbb`（上次 `aaaaaaa`） · 已审 4/4 个文件（其中 1 个由来源 PR 审过）\nopenai/gpt-test\n<!-- /agentic-review:run-metadata -->'));
  assert.doesNotMatch(review.body, /发布未全部完成/);
});

test('Earlier findings: open ones enter the index, ones closed this round get a status note and are resolved without a reply', async () => {
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
  // A later status change replaces the note instead of stacking.
  await publish(state, { requestSource: 'automatic', publicationId: 'run-3', expectedHeadSha: 'd'.repeat(40), result: {
    ...empty, body: '结论。', thread_updates: [{ root_comment_id: closing.id, status: 'reintroduced', evidence: '回退提交再次删除了该断言。' }],
  } });
  assert.match(closing.body, /^\*\*🔁 问题重现\*\*（`ddddddd`）：回退提交再次删除了该断言。 <!-- agentic-review-publication:[0-9a-f]+ --><!-- agentic-review:status -->\n\n> \[!WARNING\]/);
  assert.equal(closing.body.match(/agentic-review:status/g).length, 1);
  // A recurrence needs to notify people: reopen the discussion and reply.
  assert.equal(state.resolved.has(`thread-${closing.id}`), false);
  assert.match(state.comments.find(item => item.in_reply_to_id === closing.id).body, /^\*\*状态更新：🔁 问题重现\*\*\n\n回退提交/);
  assert.ok(state.reviews.at(-1).body.includes(`- 🔁 P2：问题 2 · [讨论](${closing.html_url})`));
  // Closing does not reply, so for recur → close → recur the last reply is still the earlier recurrence; the new recurrence must still notify.
  await publish(state, { requestSource: 'automatic', publicationId: 'run-4', expectedHeadSha: 'e'.repeat(40), result: {
    ...empty, body: '结论。', thread_updates: [{ root_comment_id: closing.id, status: 'resolved', evidence: '断言已恢复（`src/example.ts:2`）。' }],
  } });
  const again = { ...empty, body: '结论。', thread_updates: [{ root_comment_id: closing.id, status: 'reintroduced' as const, evidence: '另一次回退又删除了该断言。' }] };
  await publish(state, { requestSource: 'automatic', publicationId: 'run-5', expectedHeadSha: 'f'.repeat(40), result: again });
  const replies = () => state.comments.filter(item => item.in_reply_to_id === closing.id);
  assert.deepEqual(replies().map(item => item.body.split('\n\n')[1]), ['回退提交再次删除了该断言。', '另一次回退又删除了该断言。']);
  // A rerun of the same run does not reply again, nor does a new run when the status is already recurred.
  await publish(state, { requestSource: 'automatic', publicationId: 'run-5', expectedHeadSha: 'f'.repeat(40), result: again });
  await publish(state, { requestSource: 'automatic', publicationId: 'run-6', expectedHeadSha: 'f'.repeat(40), result: again });
  assert.equal(replies().length, 2);
  // When the reply failed but the note was written, a rerun still sends the reply.
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

test('Discussions started by others cannot be edited, so status changes are recorded as replies with only the run link', async () => {
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

test('A new automatic summary collapses earlier automatic summaries; comment request replies neither collapse nor get collapsed', async () => {
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
  // Reruns do not collapse again; a rerun of an earlier run does not restore a collapsed summary.
  const before = mutations(state.calls).length;
  await publish(state, { requestSource: 'automatic', publicationId: 'run-3', result: { ...empty, comments: [result.comments[1]] } });
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: { ...empty, comments: [result.comments[0]] } });
  assert.equal(mutations(state.calls).length, before);
  assert.equal(state.reviews.length, 3);
});

test('With an unchanged conclusion and no new findings or status changes, the latest summary is updated in place without a new review', async () => {
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
  // An in-place update keeps the previous publication marker; a rerun of the old run fails explicitly without rewriting or republishing findings.
  const before = mutations(state.calls).length;
  stale(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: { ...empty, comments: [result.comments[0]] } }));
  assert.equal(mutations(state.calls).length, before);
  assert.match(state.reviews[0].body, /只合并了 main，结论不变。/);
  // A rerun of the run that did the in-place update recognizes itself and writes nothing.
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-2', expectedHeadSha: 'c'.repeat(40),
    previousHeadSha: 'b'.repeat(40), result: { ...empty, body: '只合并了 main，结论不变。' } }));
  assert.equal(mutations(state.calls).length, before);
  // When the conclusion title changes, a new review is posted and the old one collapsed.
  await publish(state, { requestSource: 'automatic', publicationId: 'run-3', expectedHeadSha: 'd'.repeat(40), result: {
    ...empty, body: '已修复。', thread_updates: [{ root_comment_id: 1002, status: 'resolved', evidence: '修复覆盖了原触发场景。' }],
  } });
  assert.equal(state.reviews.length, 2);
  assert.equal(state.reviews[1].body.split('\n')[1], '## 自动审查：没有需要处理的问题');
  assert.match(state.reviews[0].body.split('\n')[1], /agentic-review:superseded/);
});

test('Findings that cannot bind to a diff line publish as file-level discussions before the summary and count toward the title, index, and next-round status', async () => {
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
  // Reruns do not publish again.
  const before = mutations(state.calls).length;
  ok(await run());
  assert.equal(mutations(state.calls).length, before);
  // When the next round has no new findings, file-level discussions stay in the title and index as unresolved.
  await publish(state, { requestSource: 'automatic', publicationId: 'run-2', expectedHeadSha: 'c'.repeat(40), result: { ...empty, body: '结论不变。' } });
  assert.equal(state.reviews[0].body.split('\n')[1], '## 自动审查：2 个问题需要修改');
  const thread = state.comments.find(item => item.subject_type === 'file');
  assert.ok(state.reviews[0].body.includes(`- P2：部署文档漏掉新增的权限 · [讨论](${thread.html_url})`));
});

test('When a file-level discussion fails, no summary is published; after a later run publishes, a rerun of the original run writes nothing', async () => {
  const state = fixture();
  const fileLevel: ReviewResult['comments'][number] = {
    path: 'docs/deploy.md', line: null, start_line: null, label: 'P2', title: '部署文档漏掉新增的权限', body: '……',
  };
  // Reruns use the same sealed result; run-1 closed discussion 123 started by someone else.
  const first = { ...empty, body: '结论。', comments: [fileLevel],
    thread_updates: [{ root_comment_id: 123, status: 'resolved' as const, evidence: '鉴权检查已恢复（`src/auth.ts:3`）。' }] };
  state.fail = call => call.method === 'POST' && call.url.endsWith('/pulls/7/comments') ? new Response('unavailable', { status: 502 }) : undefined;
  const failed = await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first });
  assert.deepEqual(failed.operations.filter(item => item.status !== 'succeeded').map(item => `${item.id} ${item.status}`),
    ['finding 1 (docs/deploy.md:file) failed', 'Review 正文 blocked']);
  assert.equal(state.reviews.length, 0);
  state.fail = () => undefined;
  // run-2, started later on the same head, judges 123 recurred from new evidence and publishes a summary.
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: { ...empty, body: '结论。',
    thread_updates: [{ root_comment_id: 123, status: 'reintroduced', evidence: '回退提交再次跳过了鉴权检查。' }] } }));
  assert.equal(state.resolved.has('thread-123'), false);
  // run-1 rerun: it does not post the discussion, close 123, or publish or collapse a summary; run-2's conclusion stays current.
  const before = mutations(state.calls).length;
  stale(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first }));
  assert.equal(mutations(state.calls).length, before);
  assert.equal(state.reviews.length, 1);
  assert.doesNotMatch(state.reviews[0].body.split('\n')[1], /agentic-review:superseded/);
  assert.equal(state.resolved.has('thread-123'), false);
});

test('After a file-level discussion fails with no newer run, a rerun posts the discussion and summary, and another rerun does not repeat them', async () => {
  const state = fixture();
  const fileLevel: ReviewResult['comments'][number] = {
    path: 'docs/deploy.md', line: null, start_line: null, label: 'P2', title: '部署文档漏掉新增的权限', body: '……',
  };
  const first = { ...empty, body: '结论。', comments: [fileLevel] };
  // The first POST took effect but its response was lost; the rerun recognizes it by marker and does not create it again.
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

test('When a newer run changed only discussion status and posted no summary, a rerun of the old run still stops writing', async () => {
  const state = fixture();
  const fileLevel: ReviewResult['comments'][number] = {
    path: 'docs/deploy.md', line: null, start_line: null, label: 'P2', title: '部署文档漏掉新增的权限', body: '……',
  };
  const first = { ...empty, body: '结论。',
    thread_updates: [{ root_comment_id: 123, status: 'resolved' as const, evidence: '鉴权检查已恢复（`src/auth.ts:3`）。' }] };
  // run-1's summary was published, but syncing the closed status of 123 failed.
  state.fail = call => call.body?.query?.startsWith('mutation') ? new Response('unavailable', { status: 503 }) : undefined;
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first });
  // run-2 wrote the reply that 123 recurred; its file-level discussion failed and no summary was posted.
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

test('After a comment request replaces a newer run\'s only write, a rerun of the old run still stops writing and new runs update status as usual', async () => {
  const state = fixture();
  const fileLevel: ReviewResult['comments'][number] = {
    path: 'docs/deploy.md', line: null, start_line: null, label: 'P2', title: '部署文档漏掉新增的权限', body: '……',
  };
  const first = { ...empty, body: '结论。', comments: [result.comments[0]] };
  // run-1 publishes finding X, but syncing the closed status of 456 fails (456 was started by someone else).
  const firstWithUpdate = { ...first, thread_updates: [{ root_comment_id: 456, status: 'resolved' as const, evidence: '已修复（`src/a.ts:1`）。' }] };
  state.fail = call => call.body?.query?.startsWith('mutation') ? new Response('unavailable', { status: 503 }) : undefined;
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: firstWithUpdate });
  const x = state.comments.find(item => item.user.login === 'review-app[bot]' && item.line != null)!;
  // run-2 only writes the note closing X; its file-level discussion fails and no summary is posted.
  state.fail = call => call.method === 'POST' && call.url.endsWith('/pulls/7/comments') ? new Response('unavailable', { status: 502 }) : undefined;
  await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: { ...empty, body: '结论。', comments: [fileLevel],
    thread_updates: [{ root_comment_id: x.id, status: 'resolved', evidence: '修复覆盖了原触发（`src/example.ts:2`）。' }] } });
  state.fail = () => undefined;
  // run-3's comment request judges X recurred and replaces run-2's note.
  ok(await publish(state, { requestSource: 'pr_comment', publicationId: 'run-3', requestCommentId: '900', requestRootCommentId: '',
    result: { ...empty, body: '按请求复核。', thread_updates: [{ root_comment_id: x.id, status: 'reintroduced', evidence: '回退提交再次引入了原问题。' }] } }));
  assert.match(x.body, /^\*\*🔁 问题重现\*\*/);
  // run-1 rerun: it does not close 456 or rewrite X.
  const before = mutations(state.calls).length;
  stale(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: firstWithUpdate }));
  assert.equal(mutations(state.calls).length, before);
  assert.equal(state.resolved.has('thread-456'), false);
  // Later new runs update status as usual.
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-4', expectedHeadSha: 'c'.repeat(40), result: {
    ...empty, body: '结论。', thread_updates: [{ root_comment_id: x.id, status: 'resolved', evidence: '再次修复（`src/example.ts:2`）。' }] } }));
  assert.ok(state.resolved.has(`thread-${x.id}`));
});

test('The latest automatic review follows first Check creation order, ignoring run number size, reruns, and comment requests', async () => {
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

test('A smaller run number that first runs after a larger one can still publish, and a later rerun of the old review is still blocked', async () => {
  const state = fixture();
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: empty }));
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: empty }));
  const before = mutations(state.calls).length;
  stale(await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: empty }));
  assert.equal(mutations(state.calls).length, before);
});

for (const failReply of [false, true]) {
  test(`Scoped request failure=${failReply} does not supersede the full review, and the automatic review keeps the latest discussion status after rechecking`, async () => {
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

test('A comment request\'s first run keeps its reply even when a review with a larger run number already ran', async () => {
  const state = fixture();
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-9', result: empty }));
  for (const requestSource of ['pr_comment', 'thread']) {
    ok(await publish(state, { requestSource, publicationId: 'run-1' }));
  }
  assert.ok(state.comments.some(item => item.body.includes('已按请求重新核对。')));
});

test('A rerun after a newer run collapsed its summary does not change discussion status', async () => {
  const state = fixture();
  const first = { ...empty, body: '结论。',
    thread_updates: [{ root_comment_id: 123, status: 'resolved' as const, evidence: '鉴权检查已恢复（`src/auth.ts:3`）。' }] };
  // run-1's summary was published, but syncing thread status failed.
  state.fail = call => call.body?.query?.startsWith('mutation') ? new Response('unavailable', { status: 503 }) : undefined;
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first });
  assert.equal(state.reviews.length, 1);
  state.fail = () => undefined;
  ok(await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: { ...empty, body: '结论。',
    thread_updates: [{ root_comment_id: 123, status: 'reintroduced', evidence: '回退提交再次跳过了鉴权检查。' }] } }));
  assert.match(state.reviews[0].body.split('\n')[1], /agentic-review:superseded/);
  // run-1 rerun: the collapsed first line still has run-1's marker, but a newer run's summary exists, so 123 is not closed again.
  const before = mutations(state.calls).length;
  stale(await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: first }));
  assert.equal(mutations(state.calls).length, before);
  assert.equal(state.resolved.has('thread-123'), false);
});

test('With partial coverage, the title says the review is unfinished and the unreviewed file list precedes the body', async () => {
  const state = fixture();
  await publish(state, { requestSource: 'automatic', coverage: { reviewed: 2, total: 3, sourceReviewed: 0 },
    coverageNotice: coverageNotice(['auth.ts'], 3), result: { ...empty, body: '结论。' } });
  const body = state.reviews[0].body;
  assert.equal(body.split('\n')[1], '## 自动审查：未审完（已审 2/3 个文件），已审部分没有需要处理的问题');
  assert.ok(body.indexOf('- `auth.ts`') < body.indexOf('结论。'));
});

test('A failed collapse counts as a publication failure without affecting the newly published summary', async () => {
  const state = fixture();
  await publish(state, { requestSource: 'automatic', publicationId: 'run-1', result: { ...empty, comments: [result.comments[0]] } });
  state.fail = call => call.method === 'PUT' ? new Response('forbidden', { status: 403 }) : undefined;
  const report = await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: { ...empty, comments: [result.comments[1]] } });
  assert.equal(report.reviewUrl, 'https://github.test/review/2');
  assert.deepEqual(report.operations.filter(item => item.status !== 'succeeded').map(item => item.id), ['收起旧 Review 1']);
  // A rerun reuses the published new summary and only redoes the failed collapse.
  state.fail = () => undefined;
  const rerun = await publish(state, { requestSource: 'automatic', publicationId: 'run-2', result: { ...empty, comments: [result.comments[1]] } });
  ok(rerun);
  assert.equal(state.reviews.length, 2);
  assert.match(state.reviews[0].body.split('\n')[1], /agentic-review:superseded/);
  assert.doesNotMatch(state.reviews[1].body, /superseded/);
});

test('Check details summarize the run, result, coverage, usage, and unsuccessful publication operations', () => {
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
  // When validation before publication fails, there is only the operation record.
  assert.match(checkText({ operations: [{ id: '发布前校验', status: 'failed', dependencies: [] }] }), /^## 发布操作/);
});

test('A closed thread is reopened when risk increases', async () => {
  const state = fixture();
  state.resolved.add('thread-123');
  await publish(state, { requestSource: 'automatic', result: {
    ...empty, thread_updates: [{ ...result.thread_updates[0], status: 'severity_increased' }],
  } });
  assert.equal(state.resolved.has('thread-123'), false);
  assert.ok(state.calls.some(call => call.body?.query?.includes('unresolveReviewThread')));
});

test('A body-only review carries no inline comments', async () => {
  const state = fixture();
  await publish(state, { requestSource: 'automatic', result: { ...empty, body: '未发现需要处理的问题。' } });
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].inline, undefined);
  assert.equal(state.reviews[0].body.split('\n')[1], '## 自动审查：没有需要处理的问题');
});

test('A scoped thread request only replies to the human root, without creating a review or changing thread status', async () => {
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

test('Independent reads before publication run in parallel, and the thread list provides status without per-thread queries', { timeout: 5000 }, async () => {
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

test('Status and reply for one thread run in parallel, and the body waits for both and includes failures', { timeout: 5000 }, async () => {
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

test('The shared execution boundary collects any exception and blocks only operations that declare the failed dependency', async () => {
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
  test(`${name} hits an unexpected exception and the other independent writes still run`, async () => {
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
  test(`A failed ${kind} query blocks only operations that need it`, async () => {
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
    // The summary index needs three reads; if any fails, no summary is published.
    assert.equal(state.reviews.length, 0);
    if (kind === 'comments') {
      assert.equal(state.resolved.size, 0);
      assert.equal(state.comments.length, 2);
    } else if (kind === 'threads') {
      assert.equal(state.resolved.size, 0);
      assert.ok(state.comments.some(item => item.body.includes('状态更新：')));
    } else {
      // Discussion status does not depend on the review list, so its read failure blocks only the summary.
      assert.equal(state.resolved.size, 2);
    }
  });
}

for (const invalidRoot of ['missing', 'reply']) test(`A failed ${invalidRoot} root check does not affect other threads or the body`, async () => {
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

test('After partial success, a rerun checks remote markers, redoes only failed items, and updates the publication results in the body', async () => {
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

test('When a write took effect but its response was lost, this round does not retry; the next run recognizes successes remotely', async () => {
  const state = fixture();
  state.afterWrite = call => { if (call.url.endsWith('/comments/123/replies') || call.url.endsWith('/reviews')) throw new Error('response lost'); };
  const first = await publish(state);
  // The status reply and request reply both go under root 123; together with the summary, three responses are lost.
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

test('Publication markers must come from this bot, and a new run with the same result has its own identity', async () => {
  const state = fixture();
  await publish(state);
  for (const item of [...state.comments, ...state.reviews]) item.user = { login: 'other[bot]' };
  await publish(state);
  assert.equal(state.reviews.length, 2);
  await publish(state, { publicationId: 'run-2' });
  assert.equal(state.reviews.length, 3);
});

test('Invalid shared input runs no remote operation', async () => {
  const state = fixture();
  await assert.rejects(publish(state, { repository: '../other' }), /Invalid repository/);
  await assert.rejects(publish(state, { result: { ...result, comments: [{ ...result.comments[0], path: '../secret' }] } }), /Invalid review comment path/);
  await assert.rejects(publish(state, { previousHeadSha: 'main' }), /Invalid previous review head/);
  assert.deepEqual(state.calls, []);
});

test('Reruns read every page, so a publication marker on page two still prevents duplicate writes', async () => {
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

test('A GraphQL business error returned with HTTP 200 still counts as failure, and the status reply continues', async () => {
  const state = fixture();
  state.fail = call => call.body?.query?.startsWith('mutation')
    ? Response.json({ errors: [{ message: 'forbidden mutation' }] }) : undefined;
  const report = await publish(state);
  assert.equal(report.operations.filter(item => item.status === 'failed').length, 2);
  assert.ok(state.comments.some(item => item.body.includes('状态更新：')));
  assert.equal(state.reviews.length, 1);
});

test('A rerun of a scoped thread request updates the failure note in the old reply instead of replying again', async () => {
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

test('With partial coverage and only a thread reply, unreviewed files are listed in the reply; when a body is also published, only in the body', async () => {
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

test('The workflow continues by dependency; publication or storage failures never let the Check succeed', async () => {
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
    // Evaluate the workflow conditions themselves; a status function must appear explicitly so the implicit success() of Actions does not block independent steps.
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
  // A normal run archives the recoverable workspace once; the raw Pi session is archived separately and plays no part in scope recovery.
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
  // Partial coverage is published but still blocks merging; missing coverage stats never count as complete.
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
  test(`A failed final report store must roll back completion; with rollback failure=${rollbackFails} the failure is still kept explicitly`, async () => {
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

test('Check details are written last and list save failures and coverage rollback', async () => {
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

test('A failed Check details write also rolls back coverage completion, exactly once', async () => {
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
