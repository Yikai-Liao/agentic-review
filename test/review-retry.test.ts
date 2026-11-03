import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { parse } from 'yaml';
import reviewRetry, { maxServerRetryDelayMs, maxStreamRetries } from '../.github/pi-extensions/review-retry.ts';

const tpm = 'Rate limit reached for gpt-6.1-sol on tokens per min (TPM): Limit 1000000, Used 748125, Requested 280734.';
const billingHelp = ' You can increase your rate limit by adding a payment method at https://platform.openai.com/account/billing.';
const failed = (errorMessage: string) => ({ role: 'assistant', provider: 'openai', stopReason: 'error', errorMessage,
  responseId: 'resp_failed', content: [], usage: { totalTokens: 0 } });

function fixture() {
  const handlers = new Map<string, Function>();
  reviewRetry({ on: (event, handler) => { handlers.set(event, handler); } });
  const controller = new AbortController();
  let aborted = false;
  const ctx = { signal: controller.signal, abort: () => { aborted = true; } };
  return {
    settle: (message: unknown, outcome = 'error', entries: unknown[] = []) => handlers.get('agent_before_settle')!({
      outcome, entries, context: { contextMessages: [message], contextEntries: [{ sourceEntry: { id: 'failed-1' }, messages: [message] }] },
    }),
    end: (message: unknown) => handlers.get('message_end')!({ message }),
    start: () => handlers.get('before_agent_start')!(),
    request: () => handlers.get('before_provider_request')!({}, ctx) as Promise<void>,
    compact: () => handlers.get('session_before_compact')!({ signal: controller.signal }, ctx) as Promise<void>,
    compactionFailed: () => handlers.get('session_compact_failed')!({}, ctx),
    controller, aborted: () => aborted,
  };
}

test('真实 TPM 错误从公开会话边界恢复，仅省略失败响应并保留原错误', () => {
  const hooks = fixture();
  const original = failed(`${tpm} Please try again in 4.678s.${billingHelp}`);
  const saved = structuredClone(original);
  const entries = [{ type: 'custom', customType: 'existing', data: {} }];
  assert.deepEqual(hooks.settle(original, 'error', entries), { continue: true, entries: [...entries,
    { type: 'context_edit', targetId: 'failed-1', replacement: null }] });
  assert.deepEqual(original, saved, '帮助链接、正文、响应与用量均不得被改写');
  assert.equal(hooks.aborted(), false);
});

test('下一次请求仅等待提示的剩余时间，提示只消费一次', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  t.mock.method(console, 'info', () => {});
  const hooks = fixture();
  hooks.settle(failed(`${tpm} Please try again in 4.678s.`));
  t.mock.timers.tick(2000);
  let completed = false;
  const request = hooks.request().then(() => { completed = true; });
  t.mock.timers.tick(2677);
  await Promise.resolve();
  assert.equal(completed, false);
  t.mock.timers.tick(1);
  await request;
  assert.equal(completed, true);
  await hooks.request();
});

test('等待提示也约束继续前的压缩摘要，不依赖摘要的请求回调', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  t.mock.method(console, 'info', () => {});
  const hooks = fixture();
  hooks.settle(failed(`${tpm} Please try again in 1731ms.`));
  let completed = false;
  const compact = hooks.compact().then(() => { completed = true; });
  t.mock.timers.tick(1730);
  await Promise.resolve();
  assert.equal(completed, false);
  t.mock.timers.tick(1);
  await compact;
  await hooks.request();
});

test('无等待提示时采用有上限的 2、4、8 秒退避，成功后重置次数', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  t.mock.method(console, 'info', () => {});
  const hooks = fixture();
  for (const delay of [2000, 4000, 8000]) {
    assert.ok(hooks.settle(failed(tpm))?.continue);
    let completed = false;
    const request = hooks.request().then(() => { completed = true; });
    t.mock.timers.tick(delay - 1);
    await setImmediate(); // 让已经到期的 Promise 完成，避免提前结束被微任务顺序掩盖。
    assert.equal(completed, false, `${delay}ms 退避不得提前完成`);
    t.mock.timers.tick(1);
    await request;
    assert.equal(completed, true, `${delay}ms 到期后应完成`);
  }
  assert.equal(hooks.settle(failed(tpm)), undefined);
  hooks.end({ role: 'assistant', stopReason: 'toolUse' });
  assert.ok(hooks.settle(failed(tpm))?.continue);
});

test('取消普通请求或压缩前的等待时会中止 Pi，不留下后续等待', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  t.mock.method(console, 'info', () => {});
  for (const operation of ['request', 'compact'] as const) {
    const hooks = fixture();
    hooks.settle(failed(`${tpm} Please try again in 4.678s.`));
    const request = hooks[operation]();
    hooks.controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    assert.equal(hooks.aborted(), true);
    await hooks.request();
  }
});

test('HTTP 耗尽、过长提示、永久错误与用户取消均不请求继续', async () => {
  const errors = ['OpenAI API error (429): ' + tpm, 'OpenAI API error (503): service unavailable',
    'Server requested 121s retry delay (max: 120s). Rate limit reached',
    `${tpm} Please try again in 120.001s.`, `${tpm} insufficient_quota`, `${tpm} billing account is inactive`,
    '429 insufficient_quota', 'quota exceeded'];
  for (const message of [...errors.map(failed),
    { ...failed(tpm), provider: 'other' }, { ...failed(tpm), role: 'user' },
    { ...failed(tpm), stopReason: 'stop' }, { ...failed(tpm), stopReason: 'aborted' }]) {
    const hooks = fixture();
    assert.equal(hooks.settle(message), undefined);
    await hooks.request();
  }
  assert.equal(fixture().settle(failed(tpm), 'aborted'), undefined);
});

test('压缩失败停止本轮，不能由普通回合恢复再次启动；新请求重置状态', () => {
  const hooks = fixture();
  hooks.compactionFailed();
  assert.equal(hooks.aborted(), true);
  assert.equal(hooks.settle(failed(tpm)), undefined);
  hooks.start();
  assert.ok(hooks.settle(failed(tpm))?.continue);
});

test('可信 workflow 禁用全局摘要重试，只保留原生 HTTP 预算并加载会话恢复', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.review.steps;
  assert.ok(steps.find((step: any) => step.id === 'pi-review').with.extensions.trim().split(/\s+/)
    .includes('control/.github/pi-extensions/review-retry.ts'));
  const settings = JSON.parse(steps.find((step: any) => step.name === 'Configure Pi runtime').run
    .match(/settings\.json" <<'JSON'\n([\s\S]*?)\nJSON/)[1]);
  assert.equal(settings.retry.enabled, false, 'Pi 的摘要会继承全局开关，必须关闭以隔离预算');
  assert.equal(settings.retry.provider.maxRetries, 3);
  assert.equal(settings.retry.provider.maxRetryDelayMs, maxServerRetryDelayMs);
  assert.equal(maxStreamRetries, 3);
});
