// 修改 Pi 请求恢复或摘要边界时运行；SDK 隔离安装，命令见部署说明。
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const sdkDirectory = process.env.PI_SDK_DIRECTORY;
if (!sdkDirectory) throw new Error('Set PI_SDK_DIRECTORY to the isolated @earendil-works/pi-coding-agent package directory');
const sdkPackage = JSON.parse(await readFile(path.join(sdkDirectory, 'package.json'), 'utf8'));
assert.equal(sdkPackage.version, '1.3.0', '验证 SDK 必须与 Action v2.30.1 的内置版本一致');
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(path.join(sdkDirectory, 'dist/index.js')).href);
const workflow = parse(await readFile(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));
const settings = JSON.parse(workflow.jobs.review.steps.find((step: any) => step.name === 'Configure Pi runtime').run
  .match(/settings\.json" <<'JSON'\n([\s\S]*?)\nJSON/)[1]);
assert.deepEqual(SettingsManager.inMemory(settings).getRetrySettings(), {
  enabled: true, maxRetries: 3, baseDelayMs: 15000, maxAgentDelayMs: 60000,
});
const extension = fileURLToPath(new URL('../.github/pi-extensions/review-runtime.ts', import.meta.url));
assert.ok(workflow.jobs.review.steps.find((step: any) => step.id === 'pi-review').with.extensions.includes('control/.github/pi-extensions/review-runtime.ts'));
const tpm = 'Rate limit reached for gpt-test on tokens per min (TPM): Limit 1000000, Used 808641, Requested 269328.';

function stream(response: ServerResponse, error?: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_mock', status: 'in_progress' } })}\n\n`);
  const terminal = error
    ? { type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: error } } }
    : { type: 'response.completed', response: { id: 'resp_mock', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } };
  response.end(`data: ${JSON.stringify(terminal)}\n\n`);
}

test('实际 workflow 配置注册目录外模型，并使用原模型名调用 Responses API', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-custom-model-'));
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    stream(response);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    await mkdir(path.join(directory, 'control/scripts'), { recursive: true });
    await copyFile(new URL('../scripts/configure-review-fast-mode.ts', import.meta.url),
      path.join(directory, 'control/scripts/configure-review-fast-mode.ts'));
    const configure = workflow.jobs.review.steps.find((step: any) => step.name === 'Configure Pi runtime');
    for (const id of ['deepseek-flash', 'gateway/opus-custom-alias']) {
      await promisify(execFile)('bash', ['-e', '-c', configure.run.replaceAll('$HOME', '$REVIEW_RUNTIME_HOME')], {
        cwd: directory, env: { PATH: process.env.PATH, REVIEW_RUNTIME_HOME: directory,
          REVIEW_AGENT_MODEL: id, REVIEW_AGENT_BASE_URL: baseUrl, REVIEW_EXPLICIT_PROMPT_CACHE: 'false',
          REVIEW_FAST_MODE: 'false', REVIEW_WORKSPACE_PATH: path.join(directory, 'workspace') },
      });
      const agentDir = path.join(directory, '.pi/agent');
      const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'),
        modelsPath: path.join(agentDir, 'models.json'), refreshOnCreate: false });
      await runtime.setRuntimeApiKey('openai', 'test-key');
      // 与 Action 相同：设置网关后按 provider/model 查找，不能依靠测试额外注册模型。
      runtime.registerProvider('openai', { baseUrl });
      const model = runtime.getModel('openai', id);
      assert.ok(model, `Model not found: openai/${id}`);
      assert.equal(model.api, 'openai-responses');
      assert.equal(model.contextWindow, 272000);
      assert.equal(model.maxTokens, 25000);
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off' });
      const loader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        noContextFiles: true, systemPrompt: 'Loopback model verification.' });
      await loader.reload();
      const { session } = await createAgentSession({ cwd: directory, agentDir, modelRuntime: runtime, model,
        resourceLoader: loader, tools: [], settingsManager, sessionManager: SessionManager.inMemory(directory) });
      try {
        await session.prompt('Reply with OK.');
        assert.equal(session.agent.state.messages.at(-1).stopReason, 'stop');
        assert.equal(requests.at(-1).model, id);
      } finally {
        session.dispose();
      }
    }
    assert.equal(requests.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

async function run(compact: boolean, reply: (response: ServerResponse, attempt: number) => void,
  verify: (result: { requests: any[]; events: any[]; session: any; sessionLog: any[] }) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-runtime-'));
  const requests: any[] = [], events: any[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ body: JSON.parse(body), time: performance.now() });
    reply(response, requests.length);
  });
  let session: any;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider('openai', { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-responses',
      models: [{ id: 'gpt-test', name: 'test', reasoning: false, input: ['text'], contextWindow: compact ? 2048 : 272000, maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const manager = SessionManager.create(directory, path.join(directory, 'sessions'));
    if (compact) {
      for (const content of ['Long prior review investigation. '.repeat(1500), 'Recent question.']) {
        manager.appendMessage({ role: 'user', content, timestamp: Date.now() });
        manager.appendMessage({ role: 'assistant', provider: 'openai', model: 'gpt-test', api: 'openai-responses',
          content: [{ type: 'text', text: 'Completed investigation.' }], stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 1800, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1810,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      }
    }
    // 验收缩短时间尺度；生产配置在上方独立核对，重试仍完全由 SDK 执行。
    const settingsManager = SettingsManager.inMemory({ ...settings, retry: { ...settings.retry, baseDelayMs: 20 }, cacheWarming: 'off',
      compaction: { enabled: compact, reserveTokens: 512, keepRecentTokens: 1 } });
    const agentDir = path.join(directory, 'agent');
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager,
      additionalExtensionPaths: [extension], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      noContextFiles: true, systemPrompt: 'Loopback Review verification.' });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: directory, agentDir, modelRuntime: runtime,
      model: runtime.getModel('openai', 'gpt-test'), resourceLoader: loader, tools: [], settingsManager, sessionManager: manager }));
    session.subscribe((event: any) => events.push(event));
    await session.prompt('Continue the review.');
    const sessionLog = (await readFile(manager.getSessionFile(), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(sessionLog[0].type, 'session');
    assert.ok(sessionLog.some(entry => entry.type === 'message'), '失败时也必须保留已落盘的会话');
    verify({ requests, events, session, sessionLog });
  } finally {
    session?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [name, retryAfter] of [['持续 HTTP 503', '0.001'], ['Retry-After: 121', '121']] as const) {
  test(`实际自动压缩：${name} 使用 Pi 默认预算，最终失败后中止 Review`, async () => {
    await run(true, response => {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': retryAfter });
      response.end(JSON.stringify({ error: { type: 'server_error', message: 'Temporary service unavailable' } }));
    }, ({ requests, events }) => {
      assert.equal(requests.length, 4);
      assert.ok(requests.every(request => JSON.stringify(request.body).includes('context summarization assistant')));
      assert.ok(events.some(event => event.type === 'compaction_start' && event.reason === 'threshold'));
      assert.deepEqual(events.filter(event => event.type === 'summarization_retry_scheduled').map(event => event.delayMs), [20, 40, 80]);
      assert.ok(events.some(event => event.type === 'agent_settled' && event.aborted), '压缩失败必须中止 Review');
    });
  });
}

test('实际普通回合：Pi 原生重试按配置指数等待并原样继续', async () => {
  const hints = [0.08, 0.01, 0.005];
  await run(false, (response, attempt) => stream(response, attempt <= hints.length
    ? `${tpm} Please try again in ${hints[attempt - 1]}s.` : undefined),
  ({ requests, events, session, sessionLog }) => {
    assert.equal(requests.length, 4);
    for (const [index, minimum] of [[1, 15], [2, 35], [3, 75]]) {
      assert.ok(requests[index].time - requests[index - 1].time >= minimum, `第 ${index} 次恢复不得缩短指数退避`);
      assert.deepEqual(requests[index].body.input, requests[0].body.input);
    }
    assert.deepEqual(events.filter(event => event.type === 'auto_retry_start').map(event => event.delayMs), [20, 40, 80]);
    assert.equal(events.filter(event => event.type === 'entry_appended' && event.entry.type === 'context_edit').length, 3);
    assert.equal(session.agent.state.messages.at(-1).stopReason, 'stop');
    assert.ok(sessionLog.some(entry => entry.type === 'message' && entry.message.stopReason === 'error'));
    assert.ok(sessionLog.some(entry => entry.type === 'context_edit'), '归档须保留省略失败消息的原始记录');
  });
});

test('实际错误：Pi 默认把 billing 帮助链接归为不可重试，保留原始失败', async () => {
  const error = `${tpm} Please try again in 7.296s. You can increase your rate limit at https://platform.openai.com/account/billing.`;
  await run(false, response => stream(response, error), ({ requests, events, session, sessionLog }) => {
    assert.equal(requests.length, 1, '原生分类的限制必须如实保留，不能伪造恢复成功');
    assert.ok(!events.some(event => event.type === 'auto_retry_start'));
    const providerError = `rate_limit_exceeded: ${error}`;
    assert.equal(session.agent.state.messages.at(-1).errorMessage, providerError);
    assert.ok(sessionLog.some(entry => entry.message?.errorMessage === providerError));
  });
});

for (const explicitCache of [false, true]) {
  test(`实际自动压缩：显式缓存${explicitCache ? '开启' : '关闭'}时均能完成，费用沿用 SDK`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-cache-'));
    const previousWorkspace = process.env.REVIEW_WORKSPACE_PATH;
    process.env.REVIEW_WORKSPACE_PATH = directory;
    const requests: any[] = [], events: any[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests.push(payload);
      if (!explicitCache && (payload.prompt_cache_options !== undefined || JSON.stringify(payload.input).includes('prompt_cache_breakpoint'))) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'unsupported_parameter', message: 'prompt_cache_breakpoint is not supported on this model' } }));
        return;
      }
      const attempt = requests.length;
      const item = attempt === 1
        ? { type: 'function_call', id: 'fc_inspect', call_id: 'call_inspect', name: 'inspect', arguments: '{}' }
        : { type: 'message', id: `msg_${attempt}`, role: 'assistant',
          content: [{ type: 'output_text', text: attempt === 2 ? 'Review evidence summarized.' : 'Review complete.' }] };
      const writes = attempt === 1 ? 1700 : 90;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`);
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
        id: `resp_${attempt}`, status: 'completed', output: [item], usage: {
          input_tokens: attempt === 1 ? 1800 : 100, output_tokens: attempt === 1 ? 10 : 1,
          total_tokens: attempt === 1 ? 1810 : 101,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: writes },
        },
      } })}\n\n`);
    });
    let session: any;
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as { port: number };
      const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider('openai', { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-responses',
        models: [{ id: 'gpt-test', name: 'test', reasoning: false, input: ['text'], contextWindow: 2048, maxTokens: 100,
          compat: { supportsExplicitPromptCacheMode: explicitCache }, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }] });
      const manager = SessionManager.create(directory, path.join(directory, 'sessions'));
      const settingsManager = SettingsManager.inMemory({ ...settings, cacheWarming: 'off',
        compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } });
      const agentDir = path.join(directory, 'agent');
      const loader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager,
        additionalExtensionPaths: [extension, fileURLToPath(new URL('../.github/pi-extensions/review-cost.ts', import.meta.url))],
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        noContextFiles: true, systemPrompt: 'Loopback Review verification.' });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({ cwd: directory, agentDir, modelRuntime: runtime,
        model: runtime.getModel('openai', 'gpt-test'), resourceLoader: loader, tools: ['inspect'], settingsManager, sessionManager: manager,
        customTools: [{ name: 'inspect', label: 'inspect', description: 'Return review evidence.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: async () => ({ content: [{ type: 'text', text: 'Evidence. '.repeat(300) }], details: {} }) }] }));
      session.subscribe((event: any) => events.push(event));
      await session.prompt('Fixed review rules.');

      assert.equal(requests.length, 3, '应依次完成工具回合、自动摘要和压缩后的普通回合');
      assert.ok(events.some(event => event.type === 'tool_execution_end' && event.toolName === 'inspect' && !event.isError));
      assert.ok(events.some(event => event.type === 'compaction_end' && event.result && !event.aborted));
      assert.ok(JSON.stringify(requests[1]).includes('context summarization assistant'));
      if (explicitCache) assert.ok(JSON.stringify(requests[0]).includes('"ttl":"12h"'));
      else for (const payload of requests) {
        assert.ok(!JSON.stringify(payload).includes('prompt_cache_breakpoint'));
        assert.equal(payload.prompt_cache_options, undefined);
      }
      assert.ok(!JSON.stringify(requests[2]).includes('Fixed review rules.'), '用例必须实际移除原固定规则消息');
      assert.ok(!JSON.stringify(requests[2]).includes('"ttl":"12h"'), '不得为压缩后的动态上下文新增长期断点');
      assert.deepEqual(requests[2].prompt_cache_options, explicitCache ? { mode: 'implicit', ttl: '30m' } : undefined);
      assert.equal(session.agent.state.messages.at(-1).stopReason, 'stop');
      assert.ok(!events.some(event => event.type === 'extension_error'));
      const usage = JSON.parse(await readFile(path.join(directory, 'review-usage.json'), 'utf8'));
      assert.equal(usage.turns, 2);
      assert.equal(usage.total.cacheWrite, 1790);
      assert.ok(Math.abs(usage.total.cost.total - 0.0023695) < 1e-12);
      const sessionLog = (await readFile(manager.getSessionFile(), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.ok(sessionLog.some(entry => entry.type === 'compaction'));
      assert.equal(sessionLog.at(-1).message.usage.cacheWrite, 90);
      assert.ok(Math.abs(sessionLog.at(-1).message.usage.cost.total - 0.0001245) < 1e-12);
    } finally {
      session?.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousWorkspace === undefined) delete process.env.REVIEW_WORKSPACE_PATH;
      else process.env.REVIEW_WORKSPACE_PATH = previousWorkspace;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
