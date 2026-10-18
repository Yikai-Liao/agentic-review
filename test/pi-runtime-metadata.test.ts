import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';
import { buildFooter } from '../scripts/publish-review.ts';

// 升级 Pi action 时同步更新这两个已核对值：ref 与 workflow 的固定版本一致，
// 版本取该 release 中 @earendil-works/pi-* 依赖的版本。
const VERIFIED_ACTION_REF = 'shaftoe/pi-coding-agent-action@v2.30.0';
const VERIFIED_PI_VERSION = '1.0.4';

type Step = { id?: string; uses?: string; env?: Record<string, string> };
type Job = { env?: Record<string, string>; steps: Step[] };
type Workflow = { env: Record<string, string>; jobs: { review: Job; publish: Job } };

async function readPinnedWorkflow() {
  const source = await readFile(new URL('../.github/workflows/agentic-review.yml', import.meta.url), 'utf8');
  const refs = source.match(/shaftoe\/pi-coding-agent-action@v\d+\.\d+\.\d+/g) ?? [];
  assert.equal(refs.length, 1, 'workflow 只能保留一处 Pi action release 引用');
  return { source, pinnedRef: refs[0]! };
}

test('the action pin drives both the review step and the published footer', async () => {
  const { source, pinnedRef } = await readPinnedWorkflow();
  // 当前 pin 与另一个明确 release 分别验证共用引用同时驱动 uses 和 footer。
  for (const ref of [pinnedRef, 'shaftoe/pi-coding-agent-action@v9.8.7']) {
    const workflow = parse(source.replace(pinnedRef, ref)) as Workflow;
    const agent = workflow.jobs.review.steps.find(step => step.id === 'pi-review')!;
    const publisher = workflow.jobs.publish.steps.find(step => step.id === 'publish-review')!;
    const agentEnv = { ...workflow.env, ...workflow.jobs.review.env, ...agent.env };
    const publishEnv = { ...workflow.env, ...workflow.jobs.publish.env, ...publisher.env };
    assert.equal(agent.uses, ref);
    assert.equal(publishEnv.REVIEW_PI_ACTION_REF, agent.uses);
    assert.equal(publishEnv.REVIEW_PI_VERSION, agentEnv.REVIEW_PI_VERSION);
    const footer = buildFooter({
      runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/artifact/1',
      model: 'openai/gpt-test', piVersion: publishEnv.REVIEW_PI_VERSION,
      actionRef: publishEnv.REVIEW_PI_ACTION_REF,
    });
    assert.ok(footer.includes(`Pi SDK v${publishEnv.REVIEW_PI_VERSION} | Action v${ref.split('@v')[1]}`), footer);
  }
});

test('the pinned release and declared Pi SDK version match the verified upgrade', async () => {
  const { source, pinnedRef } = await readPinnedWorkflow();
  const { env } = parse(source) as Workflow;
  assert.equal(pinnedRef, VERIFIED_ACTION_REF, '升级 Pi action 后更新 VERIFIED_ACTION_REF');
  assert.equal(env.REVIEW_PI_VERSION, VERIFIED_PI_VERSION,
    '升级 Pi action 后更新 VERIFIED_PI_VERSION，取值来自上游 release 的 pi 依赖版本');
});

test('footer rejects floating or malformed Pi action references', () => {
  for (const actionRef of ['shaftoe/pi-coding-agent-action@v2', 'shaftoe/pi-coding-agent-action@develop', '2.30.0']) {
    assert.throws(() => buildFooter({
      runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/artifact/1',
      model: 'openai/gpt-test', actionRef,
    }), /Invalid Pi action release reference/);
  }
});
