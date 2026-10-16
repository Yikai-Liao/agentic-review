import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';
import { buildFooter } from '../scripts/publish-review.ts';

test('published Pi versions match the pinned action release', async () => {
  type Step = { id?: string; uses?: string; env?: Record<string, string> };
  const workflow = parse(await readFile(new URL('../.github/workflows/agentic-review.yml', import.meta.url), 'utf8')) as {
    jobs: { review: { steps: Step[] }; publish: { steps: Step[] } };
  };
  const agent = workflow.jobs.review.steps.find(step => step.id === 'pi-review')!;
  const publisher = workflow.jobs.publish.steps.find(step => step.id === 'publish-review')!;
  const actionVersion = agent.uses?.match(/^shaftoe\/pi-coding-agent-action@v(.+)$/)?.[1];
  assert.ok(actionVersion, 'Pi action must use a fixed release');
  assert.equal(publisher.env?.REVIEW_ACTION_VERSION, actionVersion);
  const footer = buildFooter({
    runUrl: 'https://github.test/run', workspaceUrl: 'https://github.test/artifact/1',
    model: 'openai/gpt-test', piVersion: publisher.env?.REVIEW_PI_VERSION,
    actionVersion: publisher.env?.REVIEW_ACTION_VERSION,
  });
  // v2.30.0 的发布产物捆绑 Pi SDK 1.0.4，不能采用 develop README 中的版本。
  assert.match(footer, /Pi SDK v1\.0\.4 \| Action v2\.30\.0/);
});
