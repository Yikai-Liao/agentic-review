import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const entry = parse(readFileSync(new URL('../.github/workflows/agentic-review.yml', import.meta.url), 'utf8'));
const execution = parse(readFileSync(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));

test('automatic admission replaces only pending automatic requests, preserving explicit requests', () => {
  const admission = entry.concurrency;
  assert.equal(admission['cancel-in-progress'], false);
  assert.ok(admission.queue === undefined || admission.queue === 'single');
  assert.equal(admission.group,
    "agentic-review-admission-${{ inputs.repository_id }}-${{ inputs.pull_number }}-${{ inputs.trigger_source == 'automatic' && 'automatic' || github.run_id }}");
  assert.equal(entry.on.workflow_dispatch.inputs.trigger_source.default, 'automatic');
});

test('the reusable execution serializes the entire review and trusted publication for each PR', () => {
  assert.equal(entry.jobs.review.uses, './.github/workflows/review-execution.yml');
  assert.equal(entry.jobs.review.secrets, 'inherit');
  assert.deepEqual(Object.keys(entry.jobs), ['review']);
  assert.equal(execution.concurrency.group, 'agentic-review-${{ inputs.repository_id }}-${{ inputs.pull_number }}');
  assert.equal(execution.concurrency.queue, 'max');
  assert.equal(execution.concurrency['cancel-in-progress'], false);
  assert.notEqual(execution.concurrency.group, entry.concurrency.group);
  assert.equal(execution.jobs.publish.needs, 'review');
  assert.equal(execution.on.workflow_dispatch, undefined);
  assert.deepEqual(entry.permissions, execution.permissions);
});

test('the entry forwards every request field without changing the explicit comment identity', () => {
  const inputs = entry.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(execution.on.workflow_call.inputs), Object.keys(inputs));
  assert.deepEqual(Object.keys(entry.jobs.review.with), Object.keys(inputs));
  for (const [name, definition] of Object.entries(inputs)) {
    assert.deepEqual(execution.on.workflow_call.inputs[name], definition);
    assert.equal(entry.jobs.review.with[name], '${{ inputs.' + name + ' }}');
  }
});
