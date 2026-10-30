import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';
import { buildFooter } from '../scripts/publish-review.ts';

type Step = { id?: string; uses?: string; env?: Record<string, string> };
type Job = { env?: Record<string, string>; steps: Step[] };
type Workflow = { env: Record<string, string>; jobs: { review: Job; publish: Job } };

test('the action pin drives both the review step and the published footer', async () => {
  const source = await readFile(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8');
  const refs = source.match(/shaftoe\/pi-coding-agent-action@v\d+\.\d+\.\d+/g) ?? [];
  assert.equal(refs.length, 1, 'workflow 只能保留一处 Pi action release 引用');
  const pinnedRef = refs[0]!;
  // 当前 pin 与另一个明确 release 分别验证共用引用同时驱动 uses 和 footer。
  for (const ref of [pinnedRef, 'shaftoe/pi-coding-agent-action@v9.8.7']) {
    const workflow = parse(source.replace(pinnedRef, ref)) as Workflow;
    const agent = workflow.jobs.review.steps.find(step => step.id === 'pi-review')!;
    const publisher = workflow.jobs.publish.steps.find(step => step.id === 'publish-review')!;
    const publishEnv = { ...workflow.env, ...workflow.jobs.publish.env, ...publisher.env };
    assert.equal(agent.uses, ref);
    assert.equal(publishEnv.REVIEW_PI_ACTION_REF, agent.uses);
    const footer = buildFooter({
      runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/artifact/1',
      model: 'openai/gpt-test', actionRef: publishEnv.REVIEW_PI_ACTION_REF,
    });
    assert.ok(footer.includes(`| Action v${ref.split('@v')[1]}`), footer);
  }
});

test('footer rejects floating or malformed Pi action references', () => {
  for (const actionRef of ['shaftoe/pi-coding-agent-action@v2', 'shaftoe/pi-coding-agent-action@develop', '2.30.0']) {
    assert.throws(() => buildFooter({
      runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/artifact/1',
      model: 'openai/gpt-test', actionRef,
    }), /Invalid Pi action release reference/);
  }
});
