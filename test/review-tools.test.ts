import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import reviewTools from '../.github/pi-extensions/review-tools.ts';
import { buildFooter } from '../scripts/publish-review.ts';
import { commentableRanges } from '../scripts/review-diff-lines.ts';

import { inventoryDigest } from '../scripts/review-coverage.ts';
import { buildReviewRequest } from '../scripts/review-request.ts';
import { parseReviewResult } from '../scripts/review-result.ts';

process.env.REVIEW_TIME_BUDGET_SECONDS = '540';
// 新问题的行号在提交时按真实 PR diff 校验：base 有 60 行，head 改写第 40-42 行。
const target = await mkdtemp(path.join(tmpdir(), 'review-target-'));
const git = (...args: string[]) => execFileSync('git', ['-C', target, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
git('init', '-q');
await mkdir(path.join(target, 'src'));
const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
await writeFile(path.join(target, 'src/auth.ts'), `${lines.join('\n')}\n`);
git('add', '.');
git('commit', '-qm', 'base');
const baseSha = git('rev-parse', 'HEAD');
await writeFile(path.join(target, 'src/auth.ts'), `${lines.map((line, index) => index >= 39 && index <= 41 ? `${line} changed` : line).join('\n')}\n`);
git('commit', '-qam', 'head');
const headSha = git('rev-parse', 'HEAD');
process.on('exit', () => execFileSync('rm', ['-rf', target]));
async function assertSubmissionFailed(response: Promise<any>, error: RegExp) {
  const failure = await response;
  assert.equal(failure.details.queued, false);
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, error);
}
const result = {
  body: '## Review 总结\n\n这个 PR 修复了清理行为。',
  comments: [{ path: 'src/auth.ts', line: 42, start_line: 40, label: 'P1' as const, title: '过期会话仍能删除记录', body: '详细证据。' }],
  thread_updates: [{
    root_comment_id: 123,
    status: 'resolved' as const,
    evidence: '当前实现已经恢复 owner token 检查。',
  }],
  request_reply: null,
};

async function configureProgress(directory: string, source: 'automatic' | 'pr_comment' | 'thread' = 'automatic') {
  const request = buildReviewRequest({ source, commentId: source === 'automatic' ? '' : '8', rootCommentId: source === 'automatic' ? '' : '8',
    text: '审查请求\r\n保留换行', repository: 'owner/repo', pullNumber: 7, baseSha, headSha, runId: '99' });
  process.env.REVIEW_TARGET_PATH = target;
  process.env.REVIEW_CONTEXT_PATH = path.join(directory, 'review-context.json');
  process.env.REVIEW_PROGRESS_PATH = path.join(directory, 'workspace', 'review-progress.json');
  process.env.REVIEW_INVENTORY_DIGEST = inventoryDigest(['src/auth.ts']);
  await writeFile(process.env.REVIEW_CONTEXT_PATH, JSON.stringify({ request, source_reviewed: [] }));
  await writeFile(process.env.REVIEW_PROGRESS_PATH, JSON.stringify({ ledger: [{ path: 'src/auth.ts', status: 'complete' }], scope: {
    mode: 'full', rationale: '完整审查', explicit_text: '',
    ranges: [{ targets: ['complete pull request'], comparison_start: request.comparison_start, comparison_end: request.head_sha }],
  } }));
}

test('submit_review 直接接收结果对象，保存工作稿副本并封存一次', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-tools-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    const resultPath = path.join(directory, 'review-result.json');
    await mkdir(workspace);
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = resultPath;
    await configureProgress(directory);
    let tool: any;
    reviewTools({ on: () => {}, registerTool: (definition) => { tool = definition; } });

    const response = await tool.execute('call', result);
    assert.deepEqual(parseReviewResult(await readFile(resultPath, 'utf8')), result);
    assert.deepEqual(response.details, { queued: true });
    const savedPath = path.join(workspace, 'review-result.json');
    assert.deepEqual(parseReviewResult(await readFile(savedPath, 'utf8')), result);
    await writeFile(savedPath, '修改工作稿副本');
    assert.deepEqual(parseReviewResult(await readFile(resultPath, 'utf8')), result);
    await assertSubmissionFailed(tool.execute('call', result), /already submitted/);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('范围与提交只需要模型判断和文件进度，不搬运请求身份', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-scope-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    await configureProgress(directory, 'pr_comment');
    const progressPath = process.env.REVIEW_PROGRESS_PATH!;
    const originalContext = await readFile(process.env.REVIEW_CONTEXT_PATH!, 'utf8');
    await writeFile(progressPath, JSON.stringify({ ledger: [{ path: 'src/auth.ts', status: 'pending' }] }));
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = path.join(directory, 'result.json');
    const tools = new Map<string, any>();
    reviewTools({ on: () => {}, registerTool: (definition) => tools.set(definition.name, definition) });
    const summary = { body: '总结', comments: [], thread_updates: [], request_reply: null };
    await assertSubmissionFailed(tools.get('submit_review').execute('call', summary), /scope must be recorded/);
    await tools.get('set_review_scope').execute('call', {
      mode: 'focused', rationale: '用户明确限定鉴权链路。', explicit_text: '只看 auth',
      ranges: [{ targets: ['src/auth/**'], comparison_start: baseSha, comparison_end: headSha }],
    });
    const saved = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['ledger', 'scope']);
    assert.deepEqual(Object.keys(saved.scope).sort(), ['explicit_text', 'mode', 'ranges', 'rationale']);
    assert.deepEqual(saved.ledger, [{ path: 'src/auth.ts', status: 'pending' }]);
    process.env.REVIEW_INVENTORY_DIGEST = inventoryDigest(['src/auth.ts']);
    await assertSubmissionFailed(tools.get('submit_review').execute('call', summary), /Incomplete coverage/);
    await assert.rejects(readFile(process.env.REVIEW_RESULT_PATH!), /ENOENT/);
    saved.ledger[0] = { path: 'src/auth.ts', status: 'complete' };
    await writeFile(progressPath, JSON.stringify(saved));
    await tools.get('submit_review').execute('call', summary);
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
    reviewTools({ on: () => {}, registerTool: (definition) => { if (definition.name === 'set_review_scope') scopeTool = definition; } });
    await assert.rejects(scopeTool.execute('call', { mode: 'focused', rationale: '只看一个文件。', explicit_text: '只看 auth', ranges: [{ targets: ['src/auth.ts'], comparison_start: baseSha, comparison_end: headSha  }]}), /complete PR scope/);
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
    const resultPath = path.join(directory, 'result.json');
    await mkdir(workspace);
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = resultPath;
    await configureProgress(directory);
    let tool: any;
    reviewTools({ on: () => {}, registerTool: (definition) => { tool = definition; } });

    const invalidResults: Array<[unknown, RegExp]> = [
      [null, /Invalid review result/],
      [{ ...result, version: '1.0.0', private: true }, /Invalid review result fields/],
      [{ ...result, body: '' }, /Invalid review body/],
      [{ ...result, body: '中'.repeat(400_000) }, /too large/],
      [{ ...result, comments: [{ ...result.comments[0], path: '../secret' }] }, /comment path/],
      [{ ...result, comments: [{ ...result.comments[0], start_line: 43 }] }, /start_line/],
      [{ ...result, comments: [{ ...result.comments[0], label: 'P3' }] }, /comment label; use one of P0, P1/],
      [{ ...result, comments: [{ ...result.comments[0], title: '两行\n标题' }] }, /comment title/],
      [{ ...result, comments: [{ ...result.comments[0], start_line: null, line: 10 }] }, /src\/auth\.ts:10 is outside the PR diff\. Commentable line ranges in this file: 37-45/],
      [{ ...result, comments: [{ ...result.comments[0], path: 'src/other.ts' }] }, /no commentable lines/],
      [{ ...result, comments: [{ ...result.comments[0], line: null, start_line: 40 }] }, /start_line/],
      [{ ...result, comments: [{ ...result.comments[0], path: 'docs/missing.md', line: null, start_line: null }] }, /docs\/missing\.md is not changed in the PR/],
      [{ ...result, thread_updates: [{ ...result.thread_updates[0], evidence: '第一行\n第二行原因' }] }, /thread evidence/],
      [{ ...result, thread_updates: [{ ...result.thread_updates[0], status: 'unknown' }] }, /thread status/],
      [{ ...result, thread_updates: [result.thread_updates[0], result.thread_updates[0]] }, /Duplicate thread update/],
      [{ ...result, request_reply: '字符串答复' }, /Invalid request reply/],
      [{ ...result, request_reply: { body: '非 thread 请求不能提交原 thread 答复。' } }, /does not match request source/],
    ];
    for (const [input, error] of invalidResults) {
      await assertSubmissionFailed(tool.execute('call', input), error);
      await assert.rejects(readFile(resultPath), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(workspace, 'review-result.json')), { code: 'ENOENT' });
    }

    // 无法绑定 diff 行的问题作为 PR 改动文件上的文件级讨论，不校验行号。
    const accepted = { ...result, comments: [...result.comments, { ...result.comments[0], line: null, start_line: null }] };
    await tool.execute('call', accepted);
    assert.deepEqual(parseReviewResult(await readFile(resultPath, 'utf8')), accepted);
    await assertSubmissionFailed(tool.execute('call', result), /already submitted/);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('submit_review 不接受文件路径，不把外部文件内容当作结果', async () => {
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
    reviewTools({ on: () => {}, registerTool: (definition) => { tool = definition; } });
    await assertSubmissionFailed(tool.execute('call', { path: outside }), /Invalid review result fields/);
    await assert.rejects(readFile(process.env.REVIEW_RESULT_PATH!), { code: 'ENOENT' });
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('thread 请求必须提供答复，修正后可以提交', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-thread-submit-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    await configureProgress(directory, 'thread');
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = path.join(directory, 'result.json');
    let tool: any;
    reviewTools({ on: () => {}, registerTool: (definition) => { tool = definition; } });
    await assertSubmissionFailed(tool.execute('call', result), /does not match request source/);
    const response = await tool.execute('call', { ...result, request_reply: { body: '已复核并更新该问题的状态。' } });
    assert.equal(response.details.queued, true);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('封存写入失败不能返回完成，修复后可重试且不能覆盖已有封存结果', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-seal-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    const sealed = path.join(directory, 'sealed.json');
    await mkdir(workspace);
    await mkdir(sealed);
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = sealed;
    await configureProgress(directory);
    const tools = new Map<string, any>();
    reviewTools({ on: () => {}, registerTool: definition => tools.set(definition.name, definition) });
    const submit = tools.get('submit_review');
    await assertSubmissionFailed(submit.execute('call', result), /EEXIST/);
    await rm(sealed, { recursive: true });
    assert.equal((await submit.execute('call', result)).details.queued, true);
    await assert.rejects(tools.get('set_review_scope').execute('call', {}), /already submitted/);

    // 新扩展实例也不能覆盖已封存的结果。
    reviewTools({ on: () => {}, registerTool: definition => tools.set(definition.name, definition) });
    await assertSubmissionFailed(tools.get('submit_review').execute('call', { ...result, body: '另一份结果' }), /EEXIST/);
    assert.deepEqual(parseReviewResult(await readFile(sealed, 'utf8')), result);
    assert.deepEqual(parseReviewResult(await readFile(path.join(workspace, 'review-result.json'), 'utf8')), result);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('并发提交不同结果时，只有成功封存的调用能保存工作稿副本', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-concurrent-submit-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    const sealed = path.join(directory, 'sealed.json');
    await mkdir(workspace);
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = sealed;
    await configureProgress(directory);
    const submitters: any[] = [];
    for (let i = 0; i < 2; i++) {
      reviewTools({ on: () => {}, registerTool: definition => { if (definition.name === 'submit_review') submitters.push(definition); } });
    }
    const results = [result, { ...result, body: '另一份结果' }];
    const responses = await Promise.all(submitters.map((tool, i) => tool.execute(`call-${i}`, results[i])));
    const winner = responses.findIndex(response => response.details.queued);
    assert.notEqual(winner, -1);
    assert.equal(responses.filter(response => response.details.queued).length, 1);
    assert.equal(responses[1 - winner].isError, true);
    assert.match(responses[1 - winner].details.error, /EEXIST/);
    const content = await readFile(sealed, 'utf8');
    assert.deepEqual(parseReviewResult(content), results[winner]);
    assert.equal(await readFile(path.join(workspace, 'review-result.json'), 'utf8'), content);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('工作稿副本写入失败时撤销封存占位，修复后可重试', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-copy-failure-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    const saved = path.join(workspace, 'review-result.json');
    const sealed = path.join(directory, 'sealed.json');
    await mkdir(saved, { recursive: true });
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = sealed;
    await configureProgress(directory);
    let submit: any;
    reviewTools({ on: () => {}, registerTool: definition => { if (definition.name === 'submit_review') submit = definition; } });
    await assertSubmissionFailed(submit.execute('call', result), /EISDIR/);
    await assert.rejects(readFile(sealed), { code: 'ENOENT' });
    await rm(saved, { recursive: true });
    assert.equal((await submit.execute('call', result)).details.queued, true);
    assert.equal(await readFile(saved, 'utf8'), await readFile(sealed, 'utf8'));
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('关闭封存句柄失败也撤销占位，修复后可重试', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-close-failure-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    const sealed = path.join(directory, 'sealed.json');
    await mkdir(workspace);
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = sealed;
    await configureProgress(directory);
    let submit: any;
    reviewTools({ on: () => {}, registerTool: definition => { if (definition.name === 'submit_review') submit = definition; } });

    // 用真实文件完成写入，只在该句柄关闭时注入故障。
    const probe = await open(path.join(directory, 'probe'), 'wx');
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const write = prototype.writeFile;
    const injected = t.mock.method(prototype, 'writeFile', async function (this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
      await write.apply(this, args);
      const close = this.close.bind(this);
      this.close = async () => {
        await close();
        throw new Error('Injected close failure');
      };
    });
    await assertSubmissionFailed(submit.execute('call', result), /Injected close failure/);
    await assert.rejects(readFile(sealed), { code: 'ENOENT' });
    injected.mock.restore();
    assert.equal((await submit.execute('call', result)).details.queued, true);
    assert.equal(await readFile(path.join(workspace, 'review-result.json'), 'utf8'), await readFile(sealed, 'utf8'));
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('时间预算由扩展执行：预算内拒绝提前结束和部分提交，收尾后接受部分结论', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-budget-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = path.join(directory, 'review-result.json');
    await configureProgress(directory);
    const progress = JSON.parse(await readFile(process.env.REVIEW_PROGRESS_PATH!, 'utf8'));
    progress.ledger[0].status = 'pending';
    await writeFile(process.env.REVIEW_PROGRESS_PATH!, JSON.stringify(progress));
    let clock = 0;
    const handlers = new Map<string, (event?: any) => any>();
    let submit: any;
    reviewTools({ on: (event: string, handler: any) => handlers.set(event, handler),
      registerTool: definition => { if (definition.name === 'submit_review') submit = definition; } }, () => clock);
    const settle = () => handlers.get('agent_before_settle')!({ outcome: 'completed' });
    const turnEnd = () => handlers.get('turn_end')!({ outcome: 'completed' });
    const call = (toolName: string) => handlers.get('tool_call')!({ toolName });
    handlers.get('agent_start')!();

    // 调查阶段：不能自行结束，也不能以部分覆盖提交。
    clock = 359_000;
    assert.equal(turnEnd(), undefined);
    assert.match(settle().entries[0].content, /仍有 pending 文件.*不能以范围大、时间不足或未完成为由结束/);
    await assertSubmissionFailed(submit.execute('call', result), /1 files still pending.*only after the wrap-up notice/);

    // 收尾阶段：只通知一次，未提交就结束时再次要求收尾，并接受部分结论。
    clock = 360_000;
    assert.match(turnEnd().entries[0].content, /时间预算已进入收尾阶段/);
    assert.equal(turnEnd(), undefined);
    assert.match(settle().entries[0].content, /时间预算已进入收尾阶段/);
    assert.equal(call('bash'), undefined);

    // 到期后只允许提交；仍不提交时只再提醒一次，随后如实结束。
    clock = 540_000;
    assert.match(call('bash').reason, /除 `submit_review` 外的工具都会被拒绝/);
    assert.equal(call('submit_review'), undefined);
    assert.match(settle().entries[0].content, /时间预算已用尽/);
    assert.equal(settle(), undefined);
    assert.deepEqual((await submit.execute('call', result)).details, { queued: true });
    assert.equal(call('bash'), undefined);
    assert.equal(settle(), undefined);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('小 PR 全部完成后立即提交，不等待收尾阶段', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-budget-small-'));
  const originalEnv = { ...process.env };
  try {
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    process.env.REVIEW_WORKSPACE_PATH = workspace;
    process.env.REVIEW_RESULT_PATH = path.join(directory, 'review-result.json');
    await configureProgress(directory);
    let clock = 0;
    const handlers = new Map<string, (event?: any) => any>();
    let submit: any;
    reviewTools({ on: (event: string, handler: any) => handlers.set(event, handler),
      registerTool: definition => { if (definition.name === 'submit_review') submit = definition; } }, () => clock);
    handlers.get('agent_start')!();
    clock = 10_000;
    assert.equal(handlers.get('turn_end')!({ outcome: 'completed' }), undefined);
    assert.deepEqual((await submit.execute('call', result)).details, { queued: true });
    assert.equal(handlers.get('agent_before_settle')!({ outcome: 'completed' }), undefined);
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('时间预算必须显式配置且大于收尾预留', async () => {
  const { reviewBudgetSeconds, reviewPhase } = await import('../scripts/review-budget.ts');
  for (const value of [undefined, '', '180', '600.5', 'abc']) assert.throws(() => reviewBudgetSeconds(value), /REVIEW_TIME_BUDGET_SECONDS/);
  assert.equal(reviewBudgetSeconds('540'), 540);
  assert.equal(reviewPhase(undefined, 10_000_000, 540), 'investigate');
  assert.equal(reviewPhase(0, 359_999, 540), 'investigate');
  assert.equal(reviewPhase(0, 360_000, 540), 'wrap_up');
  assert.equal(reviewPhase(0, 540_000, 540), 'submit_only');
});

test('页脚展示费用估算，省略 Action 版本与审查范围', () => {
  assert.deepEqual(
    buildFooter({
      runUrl: 'https://github.test/run',
      workspaceUrl: 'https://github.test/artifact/1',
      model: 'openai/gpt-test',
      thinkingLevel: 'high',
      durationSeconds: 175,
      inputTokens: 700_000,
      outputTokens: 15_300,
      cost: 0.00424,
    }),
    { links: '[运行记录](https://github.test/run) · [审查工作稿](https://github.test/artifact/1)',
      details: 'openai/gpt-test（推理 high） · 用时 2 分 55 秒 · 715.3K token · 费用约 $0.0042' },
  );
});

test('production workflow shares the thinking level between Pi and the published footer', async () => {
  type Job = { env?: Record<string, string>; steps: Array<{ id?: string; env?: Record<string, string>; with?: Record<string, unknown> }> };
  const workflow = parse(await readFile(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8')) as {
    env: Record<string, string>; jobs: { review: Job };
  };
  const agent = workflow.jobs.review.steps.find(step => step.id === 'pi-review')!;
  const publisher = workflow.jobs.review.steps.find(step => step.id === 'publish-review')!;
  const agentEnv = { ...workflow.env, ...workflow.jobs.review.env, ...agent.env };
  const publishEnv = { ...workflow.env, ...workflow.jobs.review.env, ...publisher.env };
  const agentLevel = agent.with?.thinking_level === '${{ env.REVIEW_THINKING_LEVEL }}'
    ? agentEnv.REVIEW_THINKING_LEVEL : agent.with?.thinking_level;
  assert.equal(publishEnv.REVIEW_THINKING_LEVEL, agentLevel);
  assert.equal(agentLevel, '${{ vars.REVIEW_THINKING_LEVEL }}');
  assert.equal(agent.with?.thinking_level, '${{ env.REVIEW_THINKING_LEVEL }}');
  for (const level of ['low', 'xhigh']) {
    assert.ok(buildFooter({
      runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/artifact/1',
      model: 'openai/gpt-test', thinkingLevel: level,
    }).details.includes(`（推理 ${level}）`));
  }
});

test('可评论行按 GitHub 的三行上下文与改名识别计算，删除的文件没有可评论行', () => {
  const ranges = commentableRanges([
    'diff --git a/old name.ts b/new name.ts', 'similarity index 90%', 'rename from old name.ts', 'rename to new name.ts',
    '--- a/old name.ts\t', '+++ b/new name.ts\t', '@@ -10,7 +10,8 @@ fn', ' a', '+b',
    'diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@',
    'diff --git a/one.ts b/one.ts', '--- a/one.ts', '+++ b/one.ts', '@@ -1 +1 @@', '@@ -5,0 +6,0 @@',
    // 以 `++ ` 开头的新增内容在 hunk 中显示为 `+++ `，后续 hunk 仍属于同一文件。
    'diff --git a/plus.md b/plus.md', '--- a/plus.md', '+++ b/plus.md', '@@ -1,2 +1,3 @@', ' a', '+++ b', '--- c', '@@ -20,3 +21,4 @@', ' d',
    // 含双引号、反斜杠或控制字符的路径带 C 风格引号；core.quotePath=false 时非 ASCII 字符原样输出。
    'diff --git "a/q\\"\\\\\\t中.ts" "b/q\\"\\\\\\t中.ts"', '--- "a/q\\"\\\\\\t中.ts"', '+++ "b/q\\"\\\\\\t中.ts"', '@@ -1 +1 @@',
    'diff --git a/x b/x', '--- a/x', '+++ "b/\\303\\251.ts"', '@@ -1 +1 @@',
  ].join('\n'));
  assert.deepEqual([...ranges], [['new name.ts', [[10, 17]]], ['one.ts', [[1, 1]]], ['plus.md', [[1, 3], [21, 24]]],
    ['q"\\\t中.ts', [[1, 1]]], ['é.ts', [[1, 1]]]]);
});
