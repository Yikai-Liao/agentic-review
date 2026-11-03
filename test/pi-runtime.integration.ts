// 修改 Pi 请求恢复或摘要边界时运行；SDK 隔离安装，命令见部署说明。
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
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
const extension = fileURLToPath(new URL('../.github/pi-extensions/review-retry.ts', import.meta.url));
const tpm = 'Rate limit reached for gpt-test on tokens per min (TPM): Limit 1000000, Used 808641, Requested 269328.';

function stream(response: ServerResponse, error?: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_mock', status: 'in_progress' } })}\n\n`);
  const terminal = error
    ? { type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: error } } }
    : { type: 'response.completed', response: { id: 'resp_mock', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } };
  response.end(`data: ${JSON.stringify(terminal)}\n\n`);
}

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
    const settingsManager = SettingsManager.inMemory({ ...settings, cacheWarming: 'off',
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

for (const [name, retryAfter, expected] of [['持续 HTTP 503', '0.001', 4], ['Retry-After: 121', '121', 1]] as const) {
  test(`实际自动压缩：${name} 不复制预算或提前重发`, async () => {
    await run(true, response => {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': retryAfter });
      response.end(JSON.stringify({ error: { type: 'server_error', message: 'Temporary service unavailable' } }));
    }, ({ requests, events }) => {
      assert.equal(requests.length, expected);
      assert.ok(requests.every(request => JSON.stringify(request.body).includes('context summarization assistant')));
      assert.ok(events.some(event => event.type === 'compaction_start' && event.reason === 'threshold'));
      assert.equal(events.filter(event => event.type === 'summarization_retry_scheduled').length, 0);
      assert.ok(events.some(event => event.type === 'agent_settled' && event.aborted), '压缩失败必须中止 Review');
    });
  });
}

test('实际普通回合：带账单帮助链接的流内 TPM 错误等满提示后原样继续', async () => {
  await run(false, (response, attempt) => stream(response, attempt === 1
    ? `${tpm} Please try again in 0.08s. See https://platform.openai.com/account/billing.` : undefined),
  ({ requests, events, session, sessionLog }) => {
    assert.equal(requests.length, 2);
    assert.ok(requests[1].time - requests[0].time >= 75);
    assert.deepEqual(requests[1].body.input, requests[0].body.input);
    assert.equal(events.filter(event => event.type === 'entry_appended' && event.entry.type === 'context_edit').length, 1);
    assert.equal(session.agent.state.messages.at(-1).stopReason, 'stop');
    assert.ok(sessionLog.some(entry => entry.type === 'message' && entry.message.stopReason === 'error'));
    assert.ok(sessionLog.some(entry => entry.type === 'context_edit'), '归档须保留省略失败消息的原始记录');
  });
});
