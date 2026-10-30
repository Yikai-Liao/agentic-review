import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import fastMode, { createFastModeFetch } from '../.github/pi-extensions/fast-mode.ts';

const endpoint = 'https://gateway.test/v1/responses';
const payload = { model: 'gpt-test', input: [{ role: 'user', content: 'review' }], stream: true };
const request = (signal?: AbortSignal) => new Request(endpoint, {
  method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
  body: JSON.stringify(payload), signal,
});
const rejection = () => Response.json({ error: {
  param: 'service_tier', code: 'unsupported_value', message: 'priority is not supported for this model',
} }, { status: 400 });

test('fast mode 保留请求内容与流式响应，API 自行降级无需重发', async () => {
  for (const tier of ['priority', 'default']) {
    const response = new Response(`data: {"service_tier":"${tier}"}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    let calls = 0;
    const transport: typeof fetch = async input => {
      calls++;
      const sent = input as Request;
      assert.equal(sent.url, endpoint);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.headers.get('authorization'), 'Bearer test-token');
      assert.deepEqual(await sent.json(), { ...payload, service_tier: 'priority' });
      return response;
    };
    const received = await createFastModeFetch()(transport)(request());
    assert.equal(received, response);
    assert.match(await received.text(), new RegExp(tier));
    assert.equal(calls, 1);
  }
});

test('明确不支持时仅重发当前请求，本轮后续调用及不同 transport 均不再请求 priority', async () => {
  const bodies: unknown[] = [];
  const reports: string[] = [];
  const withFastMode = createFastModeFetch(message => reports.push(message));
  const transport: typeof fetch = async input => {
    bodies.push(await (input as Request).json());
    return bodies.length === 1 ? rejection() : new Response('done');
  };
  assert.equal(await (await withFastMode(transport)(request())).text(), 'done');
  assert.equal(await (await withFastMode(transport)(request())).text(), 'done');
  assert.deepEqual(bodies, [{ ...payload, service_tier: 'priority' }, payload, payload]);
  assert.equal(reports.length, 1);
});

test('不同网关的明确参数拒绝可回退，默认请求失败仍交回 Pi', async () => {
  for (const error of [
    { param: 'service_tier', code: 'unsupported_parameter' },
    { message: "Unknown parameter: 'service_tier'" },
    { message: 'This model does not support priority processing' },
    { message: 'Invalid service_tier: priority' },
  ]) {
    let calls = 0;
    const failure = Response.json({ error: { message: 'default also failed' } }, { status: 503 });
    const transport: typeof fetch = async () => ++calls === 1 ? Response.json({ error }, { status: 422 }) : failure;
    assert.equal(await createFastModeFetch(() => {})(transport)(request()), failure);
    assert.equal(calls, 2);
  }
});

test('鉴权、配额、限流、服务器故障与无关参数错误不触发 fast mode 回退', async () => {
  for (const [status, error] of [
    [401, { message: 'Invalid API key for priority' }],
    [403, { message: 'priority not allowed' }],
    [429, { param: 'service_tier', code: 'unsupported_value' }],
    [500, { message: 'priority not available' }],
    [400, { code: 'insufficient_quota', message: 'Insufficient quota for priority' }],
    [400, { code: 'insufficient_quota', message: 'Priority processing not available: insufficient quota' }],
    [400, { param: 'model', code: 'unsupported_value', message: 'Unsupported model' }],
    [400, { message: 'Unsupported model: custom-priority-model' }],
    [400, { param: 'max_output_tokens', code: 'unsupported_value', message: 'Unsupported value for priority processing' }],
    [400, { param: 'service_tier', code: 'billing_error', message: 'Billing error' }],
  ] as const) {
    let calls = 0;
    const response = Response.json({ error }, { status });
    const transport: typeof fetch = async () => { calls++; return response; };
    assert.equal(await createFastModeFetch(() => assert.fail('unexpected fallback'))(transport)(request()), response);
    assert.deepEqual(await response.json(), { error });
    assert.equal(calls, 1);
  }
  const networkError = new Error('connection reset');
  await assert.rejects(createFastModeFetch()(async () => { throw networkError; })(request()), error => error === networkError);
});

test('已取消的请求不会因不支持 priority 而重发', async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; controller.abort(); return rejection(); };
  await assert.rejects(createFastModeFetch(() => {})(transport)(request(controller.signal)), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('扩展按仓库开关包装已解析的 OpenAI provider，保留 Pi 调用选项', async t => {
  t.mock.method(console, 'info', () => {});
  const previous = process.env.REVIEW_FAST_MODE;
  t.after(() => {
    if (previous === undefined) delete process.env.REVIEW_FAST_MODE;
    else process.env.REVIEW_FAST_MODE = previous;
  });
  for (const enabled of ['', 'false', 'true']) {
    process.env.REVIEW_FAST_MODE = enabled;
    let handler: Function | undefined;
    let registrations = 0;
    const token = {};
    const sentinel = {};
    const originalFetch: typeof fetch = async () => new Response('ok');
    const original = { streamSimple(model: unknown, context: unknown, options: any) {
      assert.equal(model, sentinel);
      assert.equal(context, sentinel);
      assert.equal(options.apiKey, token);
      assert.equal(options.maxRetries, 3);
      assert.notEqual(options.fetch, originalFetch);
      return options.fetch(request());
    } };
    let wrapper: typeof original | undefined;
    fastMode({
      on: (event, callback) => { assert.equal(event, 'session_start'); handler = callback; },
      registerProvider: (name, config) => {
        assert.equal(name, 'openai'); assert.equal(config.api, 'openai-responses');
        registrations++; wrapper = config;
      },
    });
    if (enabled !== 'true') { assert.equal(handler, undefined); continue; }
    const context = { modelRegistry: { getProvider: (name: string) => { assert.equal(name, 'openai'); return original; } } };
    handler!(null, context);
    handler!(null, context);
    assert.equal(registrations, 1);
    assert.equal(await (await wrapper!.streamSimple(sentinel, sentinel, { apiKey: token, maxRetries: 3, fetch: originalFetch })).text(), 'ok');
  }
});

test('实际执行 workflow 传递 fast mode 仓库变量，非法值在签发 token 前失败', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));
  const review = workflow.jobs.review;
  const agent = review.steps.find((step: { id?: string }) => step.id === 'pi-review');
  const environment = { ...workflow.env, ...review.env, ...agent.env };
  assert.equal(environment.REVIEW_FAST_MODE, '${{ vars.REVIEW_FAST_MODE }}');
  assert.ok(agent.with.extensions.split(/\s+/).includes('control/.github/pi-extensions/fast-mode.ts'));
  const mint = review.steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/create-github-app-token@'));
  const validation = review.steps.slice(0, mint).find((step: { run?: string }) => step.run?.includes('REVIEW_FAST_MODE'));
  assert.ok(validation);
  for (const value of ['', 'true', 'false', 'yes']) {
    const result = spawnSync('bash', ['-e', '-c', validation.run], { encoding: 'utf8', env: {
      ...process.env, REVIEW_FAST_MODE: value, REVIEW_THINKING_LEVEL: 'xhigh',
      REPOSITORY: 'owner/repo', REPOSITORY_ID: '1', PULL_NUMBER: '2', TRIGGER_SOURCE: 'automatic',
      BASE_SHA: '', HEAD_SHA: '', GITHUB_OUTPUT: '/dev/null',
    } });
    assert.equal(result.status, value === 'yes' ? 1 : 0);
    if (value === 'yes') assert.match(result.stderr, /REVIEW_FAST_MODE/);
  }
});
