import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { parse } from 'yaml';
import { configureReviewFastMode } from '../scripts/configure-review-fast-mode.ts';

const exec = promisify(execFile);
const options = { enabled: 'true', model: 'gpt-test', baseUrl: 'https://gateway.test/v1/', token: 'test-token', modelsPath: '' };
const modelConfig = { providers: { openai: { modelOverrides: {
  'gpt-test': { contextWindow: 500000, samplingParams: { top_p: 0.9 } },
} } } };

test('启动探测确认 priority/fast 后仅写 Pi 原生模型参数，保留其他配置', async t => {
  t.mock.method(console, 'info', () => {});
  const directory = await mkdtemp(path.join(tmpdir(), 'review-fast-mode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelsPath = path.join(directory, 'models.json');
  for (const tier of ['priority', 'fast']) {
    await writeFile(modelsPath, JSON.stringify(modelConfig));
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls++;
      assert.equal(input, 'https://gateway.test/v1/responses');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
      assert.deepEqual(JSON.parse(init!.body as string), {
        model: 'gpt-test', input: 'Reply with OK.', max_output_tokens: 16, store: false, service_tier: 'priority',
      });
      return Response.json({ status: 'completed', service_tier: tier });
    };
    await configureReviewFastMode({ ...options, modelsPath, fetchImpl });
    assert.equal(calls, 1);
    const expected = structuredClone(modelConfig) as any;
    expected.providers.openai.modelOverrides['gpt-test'].samplingParams.service_tier = 'priority';
    assert.deepEqual(JSON.parse(await readFile(modelsPath, 'utf8')), expected);
  }
});

test('启动时拒绝或未确认 priority 则整轮沿用 API 默认模式，不重试探测', async t => {
  t.mock.method(console, 'info', () => {});
  const directory = await mkdtemp(path.join(tmpdir(), 'review-fast-mode-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelsPath = path.join(directory, 'models.json');
  const original = JSON.stringify(modelConfig);
  await writeFile(modelsPath, original);
  for (const [status, body] of [
    [400, { error: { param: 'service_tier', code: 'unsupported_parameter' } }],
    [422, { error: { message: 'This model does not support priority processing' } }],
    [200, { status: 'completed', service_tier: 'default' }],
    [200, { status: 'completed' }],
  ] as const) {
    let calls = 0;
    await configureReviewFastMode({ ...options, modelsPath, fetchImpl: async () => {
      calls++; return Response.json(body, { status });
    } });
    assert.equal(calls, 1);
    assert.equal(await readFile(modelsPath, 'utf8'), original);
  }
});

test('鉴权、配额、限流、网络和无关参数错误不能降级成成功', async () => {
  for (const [status, error] of [
    [401, { message: 'Invalid API key' }],
    [403, { message: 'priority processing not allowed' }],
    [429, { param: 'service_tier', code: 'unsupported_value' }],
    [500, { message: 'priority processing not available' }],
    [400, { code: 'insufficient_quota', message: 'Priority processing not available: insufficient quota' }],
    [400, { param: 'max_output_tokens', code: 'unsupported_value', message: 'Unsupported value for priority processing' }],
    [400, { message: 'Unsupported model: custom-priority-model' }],
    [400, { param: 'service_tier', code: 'billing_error', message: 'Billing error' }],
  ] as const) {
    let calls = 0;
    await assert.rejects(configureReviewFastMode({ ...options, fetchImpl: async () => {
      calls++; return Response.json({ error }, { status });
    } }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
  const networkError = new Error('connection reset');
  await assert.rejects(configureReviewFastMode({ ...options, fetchImpl: async () => { throw networkError; } }), error => error === networkError);
  for (const body of [null, { error: { message: 'failed' } }, { status: 'failed' }, { status: 'cancelled' }]) {
    await assert.rejects(configureReviewFastMode({ ...options, fetchImpl: async () => Response.json(body) }), /successful response/);
  }
});

test('关闭时不探测、不读取模型配置；非法开关失败', async () => {
  const fetchImpl: typeof fetch = async () => assert.fail('unexpected probe');
  for (const enabled of ['', 'false']) await configureReviewFastMode({ ...options, enabled, token: '', fetchImpl });
  await assert.rejects(configureReviewFastMode({ ...options, enabled: 'yes', fetchImpl }), /REVIEW_FAST_MODE/);
});

test('实际启动步骤只访问模拟网关一次，并把结果写入 Pi 配置，正式请求不加载 fast mode 扩展', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-fast-mode-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'control/scripts'), { recursive: true });
  await symlink(fileURLToPath(new URL('../skills', import.meta.url)), path.join(directory, 'control/skills'), 'dir');
  await copyFile(new URL('../scripts/configure-review-fast-mode.ts', import.meta.url), path.join(directory, 'control/scripts/configure-review-fast-mode.ts'));
  const requests: any[] = [];
  let supported = true;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.headers.authorization, 'Bearer test-token');
    response.writeHead(supported ? 200 : 400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(supported ? { status: 'completed', service_tier: 'priority' }
      : { error: { param: 'service_tier', code: 'unsupported_value' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const workflow = parse(readFileSync(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));
  const runtime = workflow.jobs.review.steps.find((step: any) => step.name === 'Configure Pi runtime');
  const agent = workflow.jobs.review.steps.find((step: any) => step.id === 'pi-review');
  assert.equal(workflow.env.REVIEW_FAST_MODE, '${{ vars.REVIEW_FAST_MODE }}');
  assert.equal(runtime.env.REVIEW_AGENT_API_KEY, '${{ secrets.REVIEW_AGENT_API_KEY }}');
  assert.ok(!agent.with.extensions.includes('fast-mode'));
  for (supported of [true, false]) {
    await exec('/bin/bash', ['--noprofile', '--norc', '-e', '-c', runtime.run.replaceAll('$HOME', '$REVIEW_RUNTIME_HOME')], {
      cwd: directory, env: {
        PATH: process.env.PATH, REVIEW_RUNTIME_HOME: directory, REVIEW_FAST_MODE: 'true', REVIEW_AGENT_MODEL: 'gpt-test',
        REVIEW_AGENT_API_KEY: 'test-token', REVIEW_AGENT_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        REVIEW_WORKSPACE_PATH: path.join(directory, 'workspace'),
      },
    });
    const model = JSON.parse(await readFile(path.join(directory, '.pi/agent/models.json'), 'utf8')).providers.openai.modelOverrides['gpt-test'];
    assert.equal(model.samplingParams?.service_tier, supported ? 'priority' : undefined);
  }
  assert.equal(requests.length, 2);
});

test('非法 fast mode 仓库变量在签发 token 前失败', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.review.steps;
  const mint = steps.findIndex((step: any) => step.uses?.startsWith('actions/create-github-app-token@'));
  const validation = steps.slice(0, mint).find((step: any) => step.run?.includes('REVIEW_FAST_MODE'));
  assert.ok(validation);
  for (const value of ['', 'true', 'false', 'yes']) {
    const result = spawnSync('bash', ['-e', '-c', validation.run], { encoding: 'utf8', env: {
      ...process.env, REVIEW_FAST_MODE: value, REVIEW_THINKING_LEVEL: 'xhigh', REPOSITORY: 'owner/repo',
      REPOSITORY_ID: '1', PULL_NUMBER: '2', TRIGGER_SOURCE: 'automatic', BASE_SHA: '', HEAD_SHA: '', GITHUB_OUTPUT: '/dev/null',
    } });
    assert.equal(result.status, value === 'yes' ? 1 : 0);
  }
});
