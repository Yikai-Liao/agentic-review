import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { buildFooter } from '../scripts/publish-review.ts';

const metadata = { runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/workspace', model: 'openai/gpt-test' };
type Step = { id?: string; name?: string; env?: Record<string, string>; run?: string };
type Workflow = { jobs: { review: { outputs: Record<string, string>; steps: Step[] }; publish: { steps: Step[] } } };
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
  assert.equal(workflow.jobs.review.outputs.cost, '${{ steps.pi-review.outputs.cost }}');
  const publisher = workflow.jobs.publish.steps.find(step => step.id === 'publish-review')!;
  assert.equal(publisher.env?.REVIEW_COST, '${{ needs.review.outputs.cost }}');
});

test('运行时只覆盖模型能力，保留 Pi 目录的价格与分档', async () => {
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
      assert.equal(provider.models, undefined, '重新声明模型会把缺省价格设为 0');
      assert.deepEqual(Object.keys(provider.modelOverrides), [model]);
      const override = provider.modelOverrides[model];
      assert.equal(override.cost, undefined, '输入、输出、缓存及分档单价均由目录提供');
      assert.equal(override.contextWindow, 500000);
      assert.equal(override.maxTokens, 128000);
      assert.equal(override.thinkingLevelMap.off, 'none');
      assert.equal(override.thinkingLevelMap.xhigh, 'xhigh');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
