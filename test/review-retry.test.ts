import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import reviewRetry, { maxServerRetryDelayMs } from '../.github/pi-extensions/review-retry.ts';

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
  return { end: (message: unknown) => handlers.get('message_end')!({ message }, ctx),
    request: () => handlers.get('before_provider_request')!({}, ctx) as Promise<void>,
    controller, aborted: () => aborted };
}

test('真实 TPM 错误仅替换账单帮助链接，保留错误正文、响应与用量', () => {
  const hooks = fixture();
  const original = failed(`${tpm} Please try again in 4.678s.${billingHelp}`);
  const result = hooks.end(original).message;
  assert.equal(result.errorMessage, `${tpm} Please try again in 4.678s. You can increase your rate limit by adding a payment method at OpenAI 账单帮助页`);
  assert.equal(result.content, original.content);
  assert.equal(result.usage, original.usage);
  assert.equal(result.responseId, original.responseId);
  assert.ok(original.errorMessage.includes('/billing'), '不得修改原始错误对象');
  assert.equal(hooks.aborted(), false);
});

test('下一次请求补足提示的剩余等待，等待不会叠加完整服务端时长', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  t.mock.method(console, 'info', () => {});
  const hooks = fixture();
  hooks.end(failed(`${tpm} Please try again in 4.678s.`));
  t.mock.timers.tick(2000); // Pi 原生首次指数退避。
  let completed = false;
  const request = hooks.request().then(() => { completed = true; });
  t.mock.timers.tick(2677);
  await Promise.resolve();
  assert.equal(completed, false);
  t.mock.timers.tick(1);
  await request;
  assert.equal(completed, true);
  await hooks.request(); // 同一提示只消费一次。
  assert.equal(hooks.aborted(), false);
});

test('原生退避已等满提示时不再等待；无提示的瞬时错误仍交给 Pi', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const hooks = fixture();
  hooks.end(failed(`${tpm} Please try again in 1.731s.`));
  t.mock.timers.tick(2000);
  await hooks.request();
  assert.equal(hooks.end(failed('server_is_overloaded')), undefined);
  await hooks.request();
  assert.equal(hooks.aborted(), false);
});

test('取消服务端等待会同时中止 Pi 请求，不留下后续等待', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  t.mock.method(console, 'info', () => {});
  const hooks = fixture();
  hooks.end(failed(`${tpm} Please try again in 4.678s.`));
  const request = hooks.request();
  hooks.controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(hooks.aborted(), true);
  await hooks.request();
});

test('HTTP 重试耗尽或服务端等待超过上限时保留失败，不提前重试', async () => {
  for (const error of ['OpenAI API error (429): rate_limit_exceeded', 'OpenAI API error (503): service unavailable',
    'Server requested 121s retry delay (max: 120s). Rate limit reached',
    `${tpm} Please try again in 120.001s.`]) {
    const hooks = fixture();
    const original = failed(error);
    assert.equal(hooks.end(original), undefined);
    assert.equal(hooks.aborted(), true);
    await hooks.request();
    assert.equal(original.errorMessage, error);
  }
});

test('凭据、配额、账单与其他消息不被改写成可重试错误', async () => {
  for (const message of [failed('OpenAI API error (401): invalid_api_key'), failed('429 insufficient_quota'),
    failed('billing account is inactive'), failed('quota exceeded'),
    { ...failed(`${tpm} Please try again in 4.678s.${billingHelp}`), provider: 'other' },
    { ...failed(`${tpm} Please try again in 4.678s.${billingHelp}`), role: 'user' },
    { ...failed(`${tpm} Please try again in 4.678s.${billingHelp}`), stopReason: 'stop' }]) {
    const hooks = fixture();
    assert.equal(hooks.end(message), undefined);
    await hooks.request();
  }
});

test('可信 workflow 加载等待钩子，HTTP 与流内等待上限一致', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.review.steps;
  assert.ok(steps.find((step: any) => step.id === 'pi-review').with.extensions.trim().split(/\s+/)
    .includes('control/.github/pi-extensions/review-retry.ts'));
  const settings = JSON.parse(steps.find((step: any) => step.name === 'Configure Pi runtime').run
    .match(/settings\.json" <<'JSON'\n([\s\S]*?)\nJSON/)[1]);
  assert.equal(settings.retry.provider.maxRetryDelayMs, maxServerRetryDelayMs);
});
