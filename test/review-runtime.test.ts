import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

test('central Review starts without Lark tools, credentials or a rotation dependency', () => {
  const source = readFileSync(new URL('../.github/workflows/agentic-review.yml', import.meta.url), 'utf8');
  const workflow = parse(source);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['publish', 'review']);
  assert.equal(workflow.jobs.review.needs, undefined);
  assert.equal(workflow.jobs.review.environment, undefined);
  assert.doesNotMatch(source, /LARKSUITE_|AGENTIC_REVIEW_LARK_|lark-cli/);
  const agent = workflow.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
  assert.ok(agent);
  assert.equal(agent.env.GH_TOKEN, '${{ steps.read-token.outputs.token }}');
  assert.equal(workflow.jobs.publish.needs, 'review');
});

test('Lark token rotation remains scheduled and isolated from the Review Agent', () => {
  const source = readFileSync(new URL('../.github/workflows/lark-token-refresh.yml', import.meta.url), 'utf8');
  const workflow = parse(source);
  assert.equal(workflow.on.schedule.length, 1);
  assert.deepEqual(workflow.on.repository_dispatch.types, ['authorize-lark-user', 'refresh-lark-user']);
  const refresh = workflow.jobs.refresh;
  assert.equal(refresh.environment, 'lark-rotation');
  assert.equal(refresh.concurrency['cancel-in-progress'], false);
  const rotate = refresh.steps.find((step: { run?: string }) => step.run === 'node scripts/refresh-lark-user-token.ts');
  assert.ok(rotate);
  assert.equal(rotate.env.LARK_REFRESH_TOKEN, '${{ secrets.AGENTIC_REVIEW_LARK_REFRESH_TOKEN }}');
  assert.equal(rotate.env.LARK_APP_SECRET, '${{ secrets.AGENTIC_REVIEW_LARK_APP_SECRET }}');
});
