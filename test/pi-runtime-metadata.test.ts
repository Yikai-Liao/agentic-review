import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';
import { buildFooter } from '../scripts/publish-review.ts';

test('the action pin and published metadata follow one shared release reference', async () => {
  const source = await readFile(new URL('../.github/workflows/agentic-review.yml', import.meta.url), 'utf8');
  type Step = { id?: string; uses?: string; env?: Record<string, string> };
  type Job = { env?: Record<string, string>; steps: Step[] };
  for (const version of ['2.30.0', '9.8.7']) {
    const workflow = parse(source.replace('shaftoe/pi-coding-agent-action@v2.30.0', `shaftoe/pi-coding-agent-action@v${version}`)) as {
      env: Record<string, string>; jobs: { review: Job; publish: Job };
    };
    const agent = workflow.jobs.review.steps.find(step => step.id === 'pi-review')!;
    const publisher = workflow.jobs.publish.steps.find(step => step.id === 'publish-review')!;
    const agentEnv = { ...workflow.env, ...workflow.jobs.review.env, ...agent.env };
    const publishEnv = { ...workflow.env, ...workflow.jobs.publish.env, ...publisher.env };
    assert.equal(agent.uses, `shaftoe/pi-coding-agent-action@v${version}`);
    assert.equal(publishEnv.REVIEW_PI_ACTION_REF, agent.uses);
    assert.equal(publishEnv.REVIEW_PI_VERSION, agentEnv.REVIEW_PI_VERSION);
    const footer = buildFooter({
      runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/artifact/1',
      model: 'openai/gpt-test', piVersion: publishEnv.REVIEW_PI_VERSION,
      actionRef: publishEnv.REVIEW_PI_ACTION_REF,
    });
    assert.ok(footer.includes(`Pi SDK v1.0.4 | Action v${version}`));
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
