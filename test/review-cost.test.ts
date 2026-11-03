import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { parse } from 'yaml';
import { buildFooter } from '../scripts/publish-review.ts';
import costExtension from '../.github/pi-extensions/review-cost.ts';
import { loadReviewPrompt } from '../scripts/load-review-prompt.ts';
import { parseReviewUsage, type ModelUsage } from '../scripts/review-usage.ts';

const metadata = { runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/workspace', model: 'openai/gpt-test' };
type Step = { id?: string; name?: string; env?: Record<string, string>; run?: string };
type Workflow = { jobs: { review: { steps: Step[] } } };
const workflowPath = new URL('../.github/workflows/review-execution.yml', import.meta.url);

test('费用估算保留低成本调用，区分零费用、缺失和无效统计', () => {
  for (const [cost, expected] of [
    [0.00424, '$0.0042'], [1.23678, '$1.2368'], [0.000001, '<$0.0001'], [0, '$0.0000'],
  ] as const) assert.ok(buildFooter({ ...metadata, cost }).endsWith(`Cost (est.): ${expected}`));
  assert.ok(buildFooter(metadata).endsWith('Cost (est.): 未提供'));
  for (const cost of [-0.1, NaN, Infinity]) assert.throws(() => buildFooter({ ...metadata, cost }), /Invalid review cost/);
});

test('发布费用直接使用 Pi Action 的统计输出', async () => {
  const workflow = parse(await readFile(workflowPath, 'utf8')) as Workflow;
  const publisher = workflow.jobs.review.steps.find(step => step.id === 'publish-review')!;
  assert.equal(publisher.env?.REVIEW_COST, '${{ steps.pi-review.outputs.cost }}');
  const agent = workflow.jobs.review.steps.find(step => step.id === 'pi-review') as Step & { with: { extensions: string } };
  assert.ok(agent.with.extensions.trim().split(/\s+/).includes('control/.github/pi-extensions/review-cost.ts'));
});

test('不同 Review 共享 OpenAI 缓存分组，输入、服务档位与其他 API 保持原契约', () => {
  const handlers = new Map<string, Function>();
  costExtension({ on: (event, handler) => { handlers.set(event, handler); } });
  const request = handlers.get('before_provider_request')!;
  const input = [{ role: 'user', content: '相同规则；当前 PR 的独立输入' }];
  for (const key of ['session-1', 'session-2']) {
    const original = { model: 'gpt-6.1-sol', input, prompt_cache_key: key, store: false,
      reasoning: { effort: 'high' }, service_tier: 'priority', prompt_cache_options: { ttl: '30m' } };
    const result = request({ payload: original }, { model: { api: 'openai-responses' } });
    assert.deepEqual(result, { ...original, prompt_cache_key: 'agentic-review' });
    assert.equal(result.input, input);
    assert.equal(original.prompt_cache_key, key);
    assert.equal(request({ payload: original }, { model: { api: 'anthropic-messages' } }), undefined);
  }
});

test('固定规则跨 commit 和工具回合使用 12h，动态材料使用 30m implicit 缓存', async t => {
  const prefixes: unknown[] = [];
  t.mock.method(console, 'info', (label: unknown, json: unknown) => {
    if (label === '[review-cache-prefix]' && typeof json === 'string') prefixes.push(JSON.parse(json));
  });
  const handlers = new Map<string, Function>();
  costExtension({ on: (event, handler) => { handlers.set(event, handler); } });
  const prompt = (await loadReviewPrompt(fileURLToPath(new URL('..', import.meta.url)))).trim();
  handlers.get('before_agent_start')!({ prompt });
  const request = handlers.get('before_provider_request')!;
  const ctx = { model: { api: 'openai-responses', compat: { supportsExplicitPromptCacheMode: true } },
    abort: () => assert.fail('正常请求不应中止') };
  const stable = [{ role: 'developer', content: '固定系统提示' },
    { role: 'user', content: [{ type: 'input_text', text: prompt }] }];
  const patched: any[] = [];
  for (const commit of ['head-one', 'head-two']) {
    handlers.get('before_agent_start')!({ prompt });
    const original = { model: 'gpt-6.1-sol', input: [...stable,
      { role: 'user', content: [{ type: 'input_text', text: `本轮材料 ${commit}` }] }],
      tools: [{ type: 'function', name: 'read' }], store: false, reasoning: { effort: 'high' },
      prompt_cache_options: { ttl: '30m' }, prompt_cache_key: commit };
    const saved = structuredClone(original);
    const result = request({ payload: original }, ctx);
    assert.deepEqual(original, saved, '不得就地改写 SDK 的原请求');
    assert.deepEqual(result.input[1].content[0].prompt_cache_breakpoint, { mode: 'explicit', ttl: '12h' });
    const unmarked = structuredClone(result);
    delete unmarked.input[1].content[0].prompt_cache_breakpoint;
    assert.deepEqual(unmarked, { ...original, prompt_cache_key: 'agentic-review',
      prompt_cache_options: { mode: 'implicit', ttl: '30m' } });
    const later = { ...original, input: [...original.input,
      { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: '固定 SHA 的源码' }] };
    const next = request({ payload: later }, ctx);
    assert.deepEqual(next.input[1], result.input[1]);
    assert.deepEqual(next.input.slice(2), later.input.slice(2));
    assert.deepEqual(next.prompt_cache_options, { mode: 'implicit', ttl: '30m' }, '动态内容不得写入 12h 缓存');
    patched.push(result);
  }
  assert.deepEqual(patched[0].input.slice(0, 2), patched[1].input.slice(0, 2));
  assert.equal(prefixes.length, 2);
  assert.deepEqual(prefixes[0], prefixes[1], '新 commit 与增补材料不得改变实际固定前缀的指纹');
  assert.ok(!JSON.stringify(prefixes).includes('固定系统提示'), '诊断不得记录正文');
  const compacted = { input: [{ role: 'user', content: [{ type: 'input_text', text: '压缩后的调查摘要' }] }] };
  assert.deepEqual(request({ payload: compacted }, ctx), { ...compacted, prompt_cache_key: 'agentic-review',
    prompt_cache_options: { mode: 'implicit', ttl: '30m' } }, '压缩移除固定规则后仍须显式请求短期缓存');
  handlers.get('before_agent_start')!({ prompt });
  let aborted = false;
  assert.throws(() => request({ payload: compacted }, { ...ctx, abort: () => { aborted = true; } }), /Fixed review prompt is missing/);
  assert.equal(aborted, true, 'SDK 会吞普通 hook 异常，首次缺规则必须同时中止');
});

test('中转站未返回 TTL 明细时沿用 SDK 费用，分档与服务档位价格保持原样', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-mixed-cache-'));
  const originalWorkspace = process.env.REVIEW_WORKSPACE_PATH;
  process.env.REVIEW_WORKSPACE_PATH = directory;
  t.after(() => {
    if (originalWorkspace === undefined) delete process.env.REVIEW_WORKSPACE_PATH;
    else process.env.REVIEW_WORKSPACE_PATH = originalWorkspace;
    rmSync(directory, { recursive: true, force: true });
  });
  t.mock.method(console, 'info', () => {});
  const handlers = new Map<string, Function>();
  costExtension({ on: (event, handler) => { handlers.set(event, handler); } });
  handlers.get('before_agent_start')!({ prompt: '固定规则' });
  const request = (compacted = false) => handlers.get('before_provider_request')!({ payload: { input: [
    { role: 'user', content: [{ type: 'input_text', text: '固定规则' }] },
    { role: 'user', content: [{ type: 'input_text', text: '动态材料' }] },
  ].slice(compacted ? 1 : 0) } }, { model: { api: 'openai-responses', compat: { supportsExplicitPromptCacheMode: true } } });
  const end = handlers.get('message_end')!;
  const turn = handlers.get('turn_end')!;
  const ctx = { abort: () => assert.fail('有效标准统计不应中止') };
  for (const [turnIndex, writes, sdkWriteCost, stopReason] of [
    [0, 4000, 0.01, 'toolUse'],
    [1, 4000, 0.02, 'error'], // 更高分档或服务档位的目录价格。
    [2, 0, 0, 'stop'],
    [3, 1000, 0.0025, 'stop'], // compaction 后只剩动态上下文。
  ] as const) {
    request(turnIndex === 3);
    const message = { role: 'assistant', provider: 'openai', model: 'gpt-6.1-sol', responseId: `resp_${turnIndex}`, stopReason,
      usage: { input: 0, output: 4, cacheRead: 8000, cacheWrite: writes, totalTokens: 8004 + writes,
        cost: { input: 0, output: 0.00004, cacheRead: 0.0008, cacheWrite: sdkWriteCost, total: sdkWriteCost + 0.00084 } } };
    if (turnIndex === 1) {
      message.usage.cost.output *= 2;
      message.usage.cost.cacheRead *= 2;
      message.usage.cost.total = 0.02168;
    }
    const saved = structuredClone(message);
    assert.equal(end({ message }, ctx), undefined, '统计扩展不应替换 SDK 的消息或费用');
    assert.deepEqual(message, saved);
    turn({ turnIndex, message });
  }
  const saved = parseReviewUsage(JSON.parse(readFileSync(path.join(directory, 'review-usage.json'), 'utf8')));
  assert.equal(saved.total.cacheWrite, 9000);
  assert.ok(Math.abs(saved.total.cost.total - 0.0367) < 1e-12);
  assert.doesNotMatch(buildFooter({ ...metadata, usage: saved }), /缓存写入生命周期/);

  // 标准统计本身损坏仍须中止并撤掉旧文件，不能用上一轮统计掩盖失败。
  request();
  let aborted = false;
  assert.throws(() => end({ message: { role: 'assistant', responseId: 'resp_missing',
    usage: { totalTokens: 1, cacheWrite: 1 } } }, { abort: () => { aborted = true; } }), /review token usage/);
  assert.equal(aborted, true);
  assert.throws(() => readFileSync(path.join(directory, 'review-usage.json')), { code: 'ENOENT' });
  assert.throws(() => turn({ turnIndex: 3, message: { role: 'assistant' } }), /review token usage/);
});

test('逐轮费用保留失败及推理分项，保存无正文的累计与首轮统计供发布', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-usage-'));
  const originalWorkspace = process.env.REVIEW_WORKSPACE_PATH;
  process.env.REVIEW_WORKSPACE_PATH = directory;
  t.after(() => {
    if (originalWorkspace === undefined) delete process.env.REVIEW_WORKSPACE_PATH;
    else process.env.REVIEW_WORKSPACE_PATH = originalWorkspace;
    rmSync(directory, { recursive: true, force: true });
  });
  const handlers = new Map<string, Function>();
  costExtension({ on: (event, handler) => { handlers.set(event, handler); } });
  const lines: unknown[][] = [];
  t.mock.method(console, 'info', (...args: unknown[]) => { lines.push(args); });
  const turn = handlers.get('turn_end')!;
  turn({ turnIndex: 0, message: { role: 'user', content: 'private source' } });
  assert.equal(lines.length, 0);
  const cost = { input: 0.00006, output: 0.02, cacheRead: 0.05, cacheWrite: 0.2, total: 0.27006 };
  for (const stopReason of ['toolUse', 'error']) {
    turn({ turnIndex: 1, message: { role: 'assistant', provider: 'openai', model: 'gpt-6.1-sol',
      responseId: 'response-1', content: 'private source', errorMessage: 'private diagnostics', stopReason,
      usage: { input: 30, output: 2000, reasoning: 1200, cacheRead: 500000, cacheWrite: 80000, totalTokens: 582030, cost } } });
    const [prefix, value] = lines.at(-1)! as string[];
    assert.equal(prefix, '[review-usage]');
    assert.deepEqual(JSON.parse(value), { turn: 1, model: 'openai/gpt-6.1-sol', responseId: 'response-1', stopReason,
      tokens: { input: 30, output: 2000, reasoning: 1200, cacheRead: 500000, cacheWrite: 80000, total: 582030 }, cost });
    assert.ok(!value.includes('private'));
  }
  const saved = readFileSync(path.join(directory, 'review-usage.json'), 'utf8');
  const summary = parseReviewUsage(JSON.parse(saved));
  assert.equal(summary.turns, 2);
  assert.equal(summary.first.cacheRead, 500000);
  assert.equal(summary.total.cacheRead, 1000000);
  assert.equal(summary.total.reasoning, 2400);
  assert.equal(summary.total.cost.total, 2 * cost.total);
  assert.ok(!saved.includes('private'));
  turn({ turnIndex: 3, message: { role: 'assistant', provider: 'openai', model: 'gpt-6.1-sol', stopReason: 'stop',
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
  assert.equal(parseReviewUsage(JSON.parse(readFileSync(path.join(directory, 'review-usage.json'), 'utf8'))).total.reasoning, undefined);
});

test('footer 展示首轮命中和分项费用，零输入及缺失推理保持准确', () => {
  const first: ModelUsage = { input: 3, output: 132, cacheRead: 1972, cacheWrite: 41123, reasoning: 0, totalTokens: 43230,
    cost: { input: 0.000006, output: 0.00132, cacheRead: 0.0001972, cacheWrite: 0.1028075, total: 0.1043307 } };
  const footer = buildFooter({ ...metadata, cost: 0.1505318, controlSha: 'b64df5114c7fe64a9eb7ff3361a13d36ba9305b2',
    usage: { turns: 1, first, total: first } });
  assert.match(footer, /首轮缓存命中 4\.6%/);
  assert.match(footer, /缓存读取 \| 1,972 \| \$0\.0002/);
  assert.match(footer, /缓存写入 \| 41,123 \| \$0\.1028/);
  assert.match(footer, /Cost \(est\.\): \$0\.1505/);
  assert.match(footer, /Rules: b64df51/);
  assert.match(footer, /推理 Token：0，已包含在输出中/);
  const empty: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  assert.match(buildFooter({ ...metadata, usage: { turns: 1, first: empty, total: empty } }), /首轮缓存命中 无输入/);
  assert.match(buildFooter({ ...metadata, usage: { turns: 1, first: empty, total: empty } }), /推理 Token：未提供/);
  for (const value of [null, {}, { turns: 0, first, total: first },
    { turns: 1, first, total: { ...first, cacheRead: -1 } },
    { turns: 1, first, total: { ...first, cost: { ...first.cost, total: Infinity } } }]) {
    assert.throws(() => parseReviewUsage(value), /review/);
  }
});

test('运行时保留目录价格与原生重试，显式缓存默认关闭并由仓库变量控制', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-model-cost-'));
  try {
    await symlink(fileURLToPath(new URL('..', import.meta.url)), path.join(directory, 'control'), 'dir');
    const workflow = parse(await readFile(workflowPath, 'utf8')) as Workflow;
    const runtime = workflow.jobs.review.steps.find(step => step.name === 'Configure Pi runtime')!;
    assert.equal(runtime.env?.REVIEW_EXPLICIT_PROMPT_CACHE, '${{ vars.REVIEW_EXPLICIT_PROMPT_CACHE }}');
    for (const [model, setting, enabled] of [
      ['gpt-6-luna', undefined, false], ['gpt-6.1-sol', 'false', false], ['gpt-6.1-sol', 'true', true],
    ] as const) {
      const runtimeHome = path.join(directory, `${model}-${setting ?? 'default'}`);
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', runtime.run!.replaceAll('$HOME', '$REVIEW_RUNTIME_HOME')], {
        cwd: directory,
        env: { PATH: process.env.PATH, REVIEW_RUNTIME_HOME: runtimeHome, REVIEW_AGENT_MODEL: model,
          REVIEW_EXPLICIT_PROMPT_CACHE: setting, REVIEW_WORKSPACE_PATH: path.join(directory, 'workspace') },
      });
      const provider = JSON.parse(await readFile(path.join(runtimeHome, '.pi/agent/models.json'), 'utf8')).providers.openai;
      const settings = JSON.parse(await readFile(path.join(runtimeHome, '.pi/agent/settings.json'), 'utf8'));
      assert.deepEqual(settings, { retry: { baseDelayMs: 15000 }, compaction: { enabled: true } });
      assert.equal(provider.models, undefined, '重新声明模型会把缺省价格设为 0');
      assert.deepEqual(Object.keys(provider.modelOverrides), [model]);
      const override = provider.modelOverrides[model];
      assert.equal(override.cost, undefined, '输入、输出、缓存及分档单价均由目录提供');
      assert.equal(override.compat.supportsExplicitPromptCacheMode, enabled);
      assert.equal(override.contextWindow, 272000);
      assert.equal(override.maxTokens, 25000);
      assert.equal(override.thinkingLevelMap.off, 'none');
      assert.equal(override.thinkingLevelMap.xhigh, 'xhigh');
      await assert.rejects(access(path.join(runtimeHome, '.pi/agent/skills/agentic-review')));
    }
    for (const setting of ['yes', '1', 'null', '"true"']) {
      assert.throws(() => execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', runtime.run!.replaceAll('$HOME', '$REVIEW_RUNTIME_HOME')], {
        cwd: directory, stdio: 'ignore',
        env: { PATH: process.env.PATH, REVIEW_RUNTIME_HOME: path.join(directory, 'invalid'),
          REVIEW_AGENT_MODEL: 'gpt-6.1-sol', REVIEW_EXPLICIT_PROMPT_CACHE: setting,
          REVIEW_WORKSPACE_PATH: path.join(directory, 'workspace') },
      }), /Command failed/, '非法配置必须使准备阶段失败');
    }
    const prompt = await loadReviewPrompt(fileURLToPath(new URL('..', import.meta.url)));
    assert.ok(prompt.includes(await readFile(new URL('../skills/agentic-review/SKILL.md', import.meta.url), 'utf8')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
