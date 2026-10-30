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
  assert.deepEqual(Object.keys(entry.jobs), ['review']);
  assert.equal(execution.concurrency.group, 'agentic-review-${{ inputs.repository_id }}-${{ inputs.pull_number }}');
  assert.equal(execution.concurrency.queue, 'max');
  assert.equal(execution.concurrency['cancel-in-progress'], false);
  assert.notEqual(execution.concurrency.group, entry.concurrency.group);
  assert.equal(execution.jobs.publish.needs, 'review');
  assert.equal(execution.on.workflow_dispatch, undefined);
  assert.deepEqual(entry.permissions, execution.permissions);
});

test('the caller provides the execution secrets through inheritance or an explicit mapping', () => {
  const required = ['AGENTIC_REVIEW_APP_PRIVATE_KEY', 'REVIEW_AGENT_API_KEY'];
  const assertSecrets = (secrets: any) => {
    if (secrets === 'inherit') return;
    for (const name of required) assert.equal(secrets?.[name], '${{ secrets.' + name + ' }}');
  };
  assertSecrets(entry.jobs.review.secrets);
  const mapped = Object.fromEntries(required.map(name => [name, '${{ secrets.' + name + ' }}']));
  assert.doesNotThrow(() => assertSecrets(mapped));
  for (const name of required) {
    const missing = { ...mapped };
    delete missing[name];
    assert.throws(() => assertSecrets(missing));
  }
});

test('the entry forwards every request field without changing the explicit comment identity', () => {
  const inputs = entry.on.workflow_dispatch.inputs;
  const assertInputs = (definitions: Record<string, unknown>, forwarded: Record<string, unknown>) => {
    assert.deepEqual(new Set(Object.keys(definitions)), new Set(Object.keys(inputs)));
    assert.deepEqual(new Set(Object.keys(forwarded)), new Set(Object.keys(inputs)));
    for (const [name, definition] of Object.entries(inputs)) {
      assert.deepEqual(definitions[name], definition);
      assert.equal(forwarded[name], '${{ inputs.' + name + ' }}');
    }
  };
  assertInputs(execution.on.workflow_call.inputs, entry.jobs.review.with);
  assert.doesNotThrow(() => assertInputs(
    Object.fromEntries(Object.entries(execution.on.workflow_call.inputs).reverse()),
    Object.fromEntries(Object.entries(entry.jobs.review.with).reverse()),
  ));
  const missing = { ...execution.on.workflow_call.inputs };
  delete missing.comment_id;
  assert.throws(() => assertInputs(missing, entry.jobs.review.with));
  assert.throws(() => assertInputs(execution.on.workflow_call.inputs,
    { ...entry.jobs.review.with, comment_id: '${{ inputs.comment_root_id }}' }));
});
