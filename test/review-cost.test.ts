import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { parse } from 'yaml';
import { buildFooter, usageDetails } from '../scripts/publish-review.ts';
import costExtension from '../.github/pi-extensions/review-cost.ts';
import { loadReviewPrompt } from '../scripts/load-review-prompt.ts';
import { parseReviewUsage, type ModelUsage } from '../scripts/review-usage.ts';
import { findCatalogCost, type CatalogModel } from '../scripts/review-pricing.ts';

const price = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
const catalog: CatalogModel[] = [{ provider: 'openai', id: 'gpt-test', cost: price }];
// Explicitly registered models start with zero prices; the extension fills them from the catalog before the first request.
const modelOf = (extra: object = {}) => ({ id: 'gpt-test', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...extra });
const registry = { getAll: () => catalog };

const metadata = { runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/workspace', model: 'openai/gpt-test' };
type Step = { id?: string; name?: string; env?: Record<string, string>; run?: string };
type Workflow = { jobs: { review: { steps: Step[] } } };
const workflowPath = new URL('../.github/workflows/review-execution.yml', import.meta.url);

test('The cost estimate keeps low-cost calls and distinguishes zero cost, missing, and invalid stats', () => {
  for (const [cost, expected] of [
    [0.00424, '$0.0042'], [1.23678, '$1.2368'], [0.000001, '<$0.0001'], [0, '$0.0000'],
  ] as const) assert.ok(buildFooter({ ...metadata, cost }).details.endsWith(`费用约 ${expected}`));
  assert.ok(buildFooter(metadata).details.endsWith('费用未提供'));
  for (const cost of [-0.1, NaN, Infinity]) assert.throws(() => buildFooter({ ...metadata, cost }), /Invalid review cost/);
});

test('Published cost comes directly from the Pi Action\'s stats output', async () => {
  const workflow = parse(await readFile(workflowPath, 'utf8')) as Workflow;
  const publisher = workflow.jobs.review.steps.find(step => step.id === 'publish-review')!;
  assert.equal(publisher.env?.REVIEW_COST, '${{ steps.pi-review.outputs.cost }}');
  const agent = workflow.jobs.review.steps.find(step => step.id === 'pi-review') as Step & { with: { extensions: string } };
  assert.ok(agent.with.extensions.trim().split(/\s+/).includes('control/.github/pi-extensions/review-cost.ts'));
});

test('Different reviews share the OpenAI cache group while input, service tier, and other APIs keep their contracts', () => {
  const handlers = new Map<string, Function>();
  costExtension({ on: (event, handler) => { handlers.set(event, handler); } });
  const request = handlers.get('before_provider_request')!;
  const input = [{ role: 'user', content: 'Shared rules; this PR\'s own input' }];
  for (const key of ['session-1', 'session-2']) {
    const original = { model: 'gpt-6.1-sol', input, prompt_cache_key: key, store: false,
      reasoning: { effort: 'high' }, service_tier: 'priority', prompt_cache_options: { ttl: '30m' } };
    const result = request({ payload: original }, { model: modelOf({ api: 'openai-responses' }), modelRegistry: registry });
    assert.deepEqual(result, { ...original, prompt_cache_key: 'agentic-review' });
    assert.equal(result.input, input);
    assert.equal(original.prompt_cache_key, key);
    assert.equal(request({ payload: original }, { model: modelOf({ api: 'anthropic-messages' }), modelRegistry: registry }), undefined);
  }
});

test('Fixed rules use a 12h cache across commits and tool turns, and dynamic materials use a 30m implicit cache', async t => {
  const prefixes: unknown[] = [];
  t.mock.method(console, 'info', (label: unknown, json: unknown) => {
    if (label === '[review-cache-prefix]' && typeof json === 'string') prefixes.push(JSON.parse(json));
  });
  const handlers = new Map<string, Function>();
  costExtension({ on: (event, handler) => { handlers.set(event, handler); } });
  const prompt = (await loadReviewPrompt(fileURLToPath(new URL('..', import.meta.url)))).trim();
  handlers.get('before_agent_start')!({ prompt });
  const request = handlers.get('before_provider_request')!;
  const ctx = { model: modelOf({ api: 'openai-responses', compat: { supportsExplicitPromptCacheMode: true } }), modelRegistry: registry,
    abort: () => assert.fail('A normal request should not abort') };
  const stable = [{ role: 'developer', content: 'Fixed system prompt' },
    { role: 'user', content: [{ type: 'input_text', text: prompt }] }];
  const patched: any[] = [];
  for (const commit of ['head-one', 'head-two']) {
    handlers.get('before_agent_start')!({ prompt });
    const original = { model: 'gpt-6.1-sol', input: [...stable,
      { role: 'user', content: [{ type: 'input_text', text: `Materials for this round ${commit}` }] }],
      tools: [{ type: 'function', name: 'read' }], store: false, reasoning: { effort: 'high' },
      prompt_cache_options: { ttl: '30m' }, prompt_cache_key: commit };
    const saved = structuredClone(original);
    const result = request({ payload: original }, ctx);
    assert.deepEqual(original, saved, 'The SDK\'s original request must not be modified in place');
    assert.deepEqual(result.input[1].content[0].prompt_cache_breakpoint, { mode: 'explicit', ttl: '12h' });
    const unmarked = structuredClone(result);
    delete unmarked.input[1].content[0].prompt_cache_breakpoint;
    assert.deepEqual(unmarked, { ...original, prompt_cache_key: 'agentic-review',
      prompt_cache_options: { mode: 'implicit', ttl: '30m' } });
    const later = { ...original, input: [...original.input,
      { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'Source at the pinned SHA' }] };
    const next = request({ payload: later }, ctx);
    assert.deepEqual(next.input[1], result.input[1]);
    assert.deepEqual(next.input.slice(2), later.input.slice(2));
    assert.deepEqual(next.prompt_cache_options, { mode: 'implicit', ttl: '30m' }, 'Dynamic content must not be written to the 12h cache');
    patched.push(result);
  }
  assert.deepEqual(patched[0].input.slice(0, 2), patched[1].input.slice(0, 2));
  assert.equal(prefixes.length, 2);
  assert.deepEqual(prefixes[0], prefixes[1], 'New commits and added materials must not change the actual fixed prefix fingerprint');
  assert.ok(!JSON.stringify(prefixes).includes('Fixed system prompt'), 'Diagnostics must not record content');
  const compacted = { input: [{ role: 'user', content: [{ type: 'input_text', text: 'Investigation summary after compaction' }] }] };
  assert.deepEqual(request({ payload: compacted }, ctx), { ...compacted, prompt_cache_key: 'agentic-review',
    prompt_cache_options: { mode: 'implicit', ttl: '30m' } }, 'After compaction removes the fixed rules, a short-term cache must still be requested explicitly');
  handlers.get('before_agent_start')!({ prompt });
  let aborted = false;
  assert.throws(() => request({ payload: compacted }, { ...ctx, abort: () => { aborted = true; } }), /Fixed review prompt is missing/);
  assert.equal(aborted, true, 'The SDK swallows ordinary hook exceptions, so missing rules on the first request must also abort');
});

test('When the relay returns no TTL breakdown, the SDK cost is kept and tiered and service tier prices stay unchanged', t => {
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
  handlers.get('before_agent_start')!({ prompt: 'Fixed rules' });
  const request = (compacted = false) => handlers.get('before_provider_request')!({ payload: { input: [
    { role: 'user', content: [{ type: 'input_text', text: 'Fixed rules' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Dynamic materials' }] },
  ].slice(compacted ? 1 : 0) } }, { model: modelOf({ api: 'openai-responses', compat: { supportsExplicitPromptCacheMode: true } }), modelRegistry: registry });
  const end = handlers.get('message_end')!;
  const turn = handlers.get('turn_end')!;
  const ctx = { abort: () => assert.fail('Valid standard stats should not abort') };
  for (const [turnIndex, writes, sdkWriteCost, stopReason] of [
    [0, 4000, 0.01, 'toolUse'],
    [1, 4000, 0.02, 'error'], // Catalog price for a higher tier or service tier.
    [2, 0, 0, 'stop'],
    [3, 1000, 0.0025, 'stop'], // Only dynamic context remains after compaction.
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
    assert.equal(end({ message }, ctx), undefined, 'The stats extension must not replace the SDK\'s message or cost');
    assert.deepEqual(message, saved);
    turn({ turnIndex, message });
  }
  const saved = parseReviewUsage(JSON.parse(readFileSync(path.join(directory, 'review-usage.json'), 'utf8')));
  assert.equal(saved.total.cacheWrite, 9000);
  assert.ok(Math.abs(saved.total.cost.total - 0.0367) < 1e-12);
  assert.doesNotMatch(usageDetails(saved), /缓存写入生命周期/);

  // Corrupt standard stats must still abort and remove the old file; the previous round's stats never mask the failure.
  request();
  let aborted = false;
  assert.throws(() => end({ message: { role: 'assistant', responseId: 'resp_missing',
    usage: { totalTokens: 1, cacheWrite: 1 } } }, { abort: () => { aborted = true; } }), /review token usage/);
  assert.equal(aborted, true);
  assert.throws(() => readFileSync(path.join(directory, 'review-usage.json')), { code: 'ENOENT' });
  assert.throws(() => turn({ turnIndex: 3, message: { role: 'assistant' } }), /review token usage/);
});

test('Per-turn cost keeps failures and reasoning breakdowns, saves only content-free totals and first-turn stats for publication, and writes no run log', t => {
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
  const cost = { input: 0.00006, output: 0.02, cacheRead: 0.05, cacheWrite: 0.2, total: 0.27006 };
  for (const stopReason of ['toolUse', 'error']) {
    turn({ turnIndex: 1, message: { role: 'assistant', provider: 'openai', model: 'gpt-6.1-sol',
      responseId: 'response-1', content: 'private source', errorMessage: 'private diagnostics', stopReason,
      usage: { input: 30, output: 2000, reasoning: 1200, cacheRead: 500000, cacheWrite: 80000, totalTokens: 582030, cost } } });
  }
  assert.equal(lines.length, 0);
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

test('The footer puts links and run info on separate lines; usage details show first-turn hits and itemized cost, and stay accurate for zero input and missing reasoning', () => {
  const first: ModelUsage = { input: 3, output: 132, cacheRead: 1972, cacheWrite: 41123, reasoning: 0, totalTokens: 43230,
    cost: { input: 0.000006, output: 0.00132, cacheRead: 0.0001972, cacheWrite: 0.1028075, total: 0.1043307 } };
  const footer = buildFooter({ ...metadata, cost: 0.1505318, controlSha: 'b64df5114c7fe64a9eb7ff3361a13d36ba9305b2' });
  assert.doesNotMatch(footer.links + footer.details, /\n/);
  assert.match(footer.details, /费用约 \$0\.1505/);
  assert.match(footer.details, /规则 `b64df51`/);
  const details = usageDetails({ turns: 1, priceKnown: true, first, total: first });
  assert.match(details, /首轮缓存命中 4\.6%/);
  assert.match(details, /缓存读取 \| 1,972 \| \$0\.0002/);
  assert.match(details, /缓存写入 \| 41,123 \| \$0\.1028/);
  assert.match(details, /推理 Token：0，已包含在输出中/);
  const empty: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  assert.match(usageDetails({ turns: 1, priceKnown: true, first: empty, total: empty }), /首轮缓存命中 无输入/);
  assert.match(usageDetails({ turns: 1, priceKnown: true, first: empty, total: empty }), /推理 Token：未提供/);
  for (const value of [null, {}, { turns: 0, priceKnown: true, first, total: first },
    { turns: 1, priceKnown: true, first, total: { ...first, cacheRead: -1 } },
    { turns: 1, priceKnown: true, first, total: { ...first, cost: { ...first.cost, total: Infinity } } }]) {
    assert.throws(() => parseReviewUsage(value), /review/);
  }
});

test('The runtime registers a Responses model and keeps native retries; explicit caching is off by default and controlled by a repository variable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-model-cost-'));
  try {
    await mkdir(path.join(directory, 'control/scripts'), { recursive: true });
    await copyFile(new URL('../scripts/configure-review-fast-mode.ts', import.meta.url),
      path.join(directory, 'control/scripts/configure-review-fast-mode.ts'));
    const workflow = parse(await readFile(workflowPath, 'utf8')) as Workflow;
    const runtime = workflow.jobs.review.steps.find(step => step.name === 'Configure Pi runtime')!;
    assert.equal(runtime.env?.REVIEW_EXPLICIT_PROMPT_CACHE, '${{ vars.REVIEW_EXPLICIT_PROMPT_CACHE }}');
    for (const [model, setting, enabled] of [
      ['gpt-6-luna', undefined, false], ['gpt-6.1-sol', 'false', false], ['gpt-6.1-sol', 'true', true],
      ['deepseek-flash', 'false', false], ['gateway/opus-alias', 'false', false],
    ] as const) {
      const runtimeHome = path.join(directory, `${model}-${setting ?? 'default'}`);
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', runtime.run!.replaceAll('$HOME', '$REVIEW_RUNTIME_HOME')], {
        cwd: directory,
        env: { PATH: process.env.PATH, REVIEW_RUNTIME_HOME: runtimeHome, REVIEW_AGENT_MODEL: model, REVIEW_AGENT_BASE_URL: 'https://gateway.test/v1',
          REVIEW_EXPLICIT_PROMPT_CACHE: setting, REVIEW_WORKSPACE_PATH: path.join(directory, 'workspace') },
      });
      const provider = JSON.parse(await readFile(path.join(runtimeHome, '.pi/agent/models.json'), 'utf8')).providers.openai;
      const settings = JSON.parse(await readFile(path.join(runtimeHome, '.pi/agent/settings.json'), 'utf8'));
      assert.deepEqual(settings, { retry: { baseDelayMs: 15000 }, compaction: { enabled: true } });
      assert.equal(provider.modelOverrides, undefined);
      assert.equal(provider.models.length, 1);
      assert.equal(provider.baseUrl, 'https://gateway.test/v1');
      const registeredModel = provider.models[0];
      assert.equal(registeredModel.id, model);
      assert.equal(registeredModel.api, 'openai-responses');
      assert.equal(registeredModel.compat.supportsExplicitPromptCacheMode, enabled);
      assert.equal(registeredModel.contextWindow, 272000);
      assert.equal(registeredModel.maxTokens, 25000);
      assert.equal(registeredModel.thinkingLevelMap.off, 'none');
      assert.equal(registeredModel.thinkingLevelMap.xhigh, 'xhigh');
      await assert.rejects(access(path.join(runtimeHome, '.pi/agent/skills/agentic-review')));
    }
    for (const setting of ['yes', '1', 'null', '"true"']) {
      assert.throws(() => execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', runtime.run!.replaceAll('$HOME', '$REVIEW_RUNTIME_HOME')], {
        cwd: directory, stdio: 'ignore',
        env: { PATH: process.env.PATH, REVIEW_RUNTIME_HOME: path.join(directory, 'invalid'),
          REVIEW_AGENT_MODEL: 'gpt-6.1-sol', REVIEW_EXPLICIT_PROMPT_CACHE: setting,
          REVIEW_WORKSPACE_PATH: path.join(directory, 'workspace') },
      }), /Command failed/, 'Invalid configuration must fail the preparation step');
    }
    const prompt = await loadReviewPrompt(fileURLToPath(new URL('..', import.meta.url)));
    assert.ok(prompt.includes(await readFile(new URL('../skills/agentic-review/SKILL.md', import.meta.url), 'utf8')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Explicitly registered models take prices from the Pi catalog: exact ID first, then the latest version of the same family and tier, otherwise cost is marked unknown', t => {
  const entry = (provider: string, id: string, input: number) => ({ provider, id, cost: { input, output: input * 5, cacheRead: 0, cacheWrite: 0 } });
  const models = [entry('openai', 'gpt-5.6-terra', 2), entry('openai', 'gpt-6-terra', 3), entry('openai', 'gpt-6.1-sol', 4),
    entry('openai', 'gpt-6.1-luna', 0), entry('bedrock', 'openai.gpt-7-terra', 9), entry('openai', 'deepseek-flash', 1)];
  assert.equal(findCatalogCost('gpt-6.1-sol', models)?.input, 4);
  assert.equal(findCatalogCost('deepseek-flash', models)?.input, 1);
  assert.equal(findCatalogCost('gpt-6.1-terra', models)?.input, 3);
  assert.equal(findCatalogCost('gpt-5.2-terra', models)?.input, 3);
  // A zero-price entry is a model shadowed by explicit registration and is not a catalog price.
  assert.equal(findCatalogCost('gpt-6.1-luna', models), undefined);
  assert.equal(findCatalogCost('gateway/opus-alias', models), undefined);

  const handlers = new Map<string, Function>();
  costExtension({ on: (event, handler) => { handlers.set(event, handler); } });
  const model = modelOf({ api: 'openai-responses' });
  handlers.get('before_provider_request')!({ payload: { input: [] } }, { model, modelRegistry: registry });
  assert.deepEqual(model.cost, price);

  // Run one full request and turn through the extension, then build the publication from the review-usage.json it saved.
  const directory = mkdtempSync(path.join(tmpdir(), 'review-price-'));
  const originalWorkspace = process.env.REVIEW_WORKSPACE_PATH;
  process.env.REVIEW_WORKSPACE_PATH = directory;
  t.after(() => {
    if (originalWorkspace === undefined) delete process.env.REVIEW_WORKSPACE_PATH;
    else process.env.REVIEW_WORKSPACE_PATH = originalWorkspace;
    rmSync(directory, { recursive: true, force: true });
  });
  t.mock.method(console, 'info', () => {});
  const publishedFooter = (id: string) => {
    const run = new Map<string, Function>();
    costExtension({ on: (event, handler) => { run.set(event, handler); } });
    const registered = modelOf({ id, api: 'openai-responses' });
    run.get('before_provider_request')!({ payload: { input: [] } },
      { model: registered, modelRegistry: registry, abort: () => assert.fail('A missing price should not abort the review') });
    // Simulate the SDK computing usage from the registered model's cost at that time.
    const rate = registered.cost.input;
    const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000,
      cost: { input: rate, output: 0, cacheRead: 0, cacheWrite: 0, total: rate } };
    run.get('message_end')!({ message: { role: 'assistant', usage } }, { abort: () => assert.fail('Usage is valid') });
    run.get('turn_end')!({ turnIndex: 0, message: { role: 'assistant', provider: 'openai', model: id, stopReason: 'stop', usage } });
    const saved = parseReviewUsage(JSON.parse(readFileSync(path.join(directory, 'review-usage.json'), 'utf8')));
    return { saved, footer: `${buildFooter({ ...metadata, cost: rate, priceKnown: saved.priceKnown }).details}\n${usageDetails(saved)}` };
  };
  // Priced model: the saved price is known and cost is shown normally.
  const known = publishedFooter('gpt-test');
  assert.equal(known.saved.priceKnown, true);
  assert.match(known.footer, /费用约 \$2\.0000/);
  // Gateway alias with no catalog price: the review runs as usual, the saved price is unknown, and publication shows the cost as not provided.
  const unknown = publishedFooter('gateway/opus-alias');
  assert.equal(unknown.saved.priceKnown, false);
  assert.match(unknown.footer, /费用未提供/);
  assert.doesNotMatch(unknown.footer, /\$0\.0000/);
  assert.throws(() => parseReviewUsage({ ...unknown.saved, priceKnown: undefined }), /Invalid review price state/);
});
