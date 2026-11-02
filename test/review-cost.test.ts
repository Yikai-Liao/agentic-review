import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { buildFooter } from '../scripts/publish-review.ts';
import costExtension from '../.github/pi-extensions/review-cost.ts';
import { loadReviewPrompt } from '../scripts/load-review-prompt.ts';

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

test('逐轮费用只记录 SDK 用量与估算，保留失败及推理分项，不输出正文', t => {
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
});

test('运行时保留模型目录价格与分档，并启用单层有界重试', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-model-cost-'));
  try {
    await symlink(fileURLToPath(new URL('..', import.meta.url)), path.join(directory, 'control'), 'dir');
    const workflow = parse(await readFile(workflowPath, 'utf8')) as Workflow;
    const runtime = workflow.jobs.review.steps.find(step => step.name === 'Configure Pi runtime')!;
    for (const model of ['gpt-6-luna', 'gpt-6.1-sol']) {
      const runtimeHome = path.join(directory, model);
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', runtime.run!.replaceAll('$HOME', '$REVIEW_RUNTIME_HOME')], {
        cwd: directory,
        env: { PATH: process.env.PATH, REVIEW_RUNTIME_HOME: runtimeHome, REVIEW_AGENT_MODEL: model, REVIEW_WORKSPACE_PATH: path.join(directory, 'workspace') },
      });
      const provider = JSON.parse(await readFile(path.join(runtimeHome, '.pi/agent/models.json'), 'utf8')).providers.openai;
      const settings = JSON.parse(await readFile(path.join(runtimeHome, '.pi/agent/settings.json'), 'utf8'));
      assert.deepEqual(settings.retry, { enabled: false, provider: { maxRetries: 3, maxRetryDelayMs: 120000 } });
      assert.equal(provider.models, undefined, '重新声明模型会把缺省价格设为 0');
      assert.deepEqual(Object.keys(provider.modelOverrides), [model]);
      const override = provider.modelOverrides[model];
      assert.equal(override.cost, undefined, '输入、输出、缓存及分档单价均由目录提供');
      assert.equal(override.contextWindow, 500000);
      assert.equal(override.maxTokens, 128000);
      assert.equal(override.thinkingLevelMap.off, 'none');
      assert.equal(override.thinkingLevelMap.xhigh, 'xhigh');
      await assert.rejects(access(path.join(runtimeHome, '.pi/agent/skills/agentic-review')));
    }
    const prompt = await loadReviewPrompt(fileURLToPath(new URL('..', import.meta.url)));
    assert.ok(prompt.includes(await readFile(new URL('../skills/agentic-review/SKILL.md', import.meta.url), 'utf8')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
