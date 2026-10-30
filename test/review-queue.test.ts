import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { data, Evaluator, Lexer, Parser } from '@actions/expressions';
import { parse } from 'yaml';

const entry = parse(readFileSync(new URL('../.github/workflows/agentic-review.yml', import.meta.url), 'utf8'));
const execution = parse(readFileSync(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));

// 使用 Actions 表达式语义比较实际分组关系，不固定前缀、函数或条件拼写。
function groupFor(template: string, repository: string, pull: string, source: string, run: number) {
  const context = JSON.parse(JSON.stringify({
    inputs: { repository_id: repository, pull_number: pull, trigger_source: source },
    github: { run_id: String(run) },
  }), data.reviver);
  return template.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => {
    const parsed = new Parser(new Lexer(expression).lex().tokens, ['inputs', 'github'], []).parse();
    return new Evaluator(parsed, context).evaluate().coerceString();
  }).toLowerCase();
}

function assertGrouping(admission: string, serialized: string) {
  const automatic = groupFor(admission, '11', '7', 'automatic', 101);
  assert.equal(automatic, groupFor(admission, '11', '7', 'automatic', 102));
  const explicit = groupFor(admission, '11', '7', 'pr_comment', 103);
  assert.notEqual(explicit, automatic);
  assert.notEqual(explicit, groupFor(admission, '11', '7', 'pr_comment', 104));
  assert.notEqual(explicit, groupFor(admission, '11', '7', 'thread', 105));
  const executionGroup = groupFor(serialized, '11', '7', 'automatic', 101);
  for (const source of ['automatic', 'pr_comment', 'thread']) {
    const admitted = groupFor(admission, '11', '7', source, 106);
    assert.notEqual(admitted, groupFor(admission, '12', '7', source, 106));
    assert.notEqual(admitted, groupFor(admission, '11', '8', source, 106));
    assert.notEqual(groupFor(admission, '12', '34', source, 106), groupFor(admission, '123', '4', source, 106));
    assert.equal(executionGroup, groupFor(serialized, '11', '7', source, 106));
    assert.notEqual(executionGroup, admitted);
  }
  assert.notEqual(executionGroup, groupFor(serialized, '12', '7', 'automatic', 101));
  assert.notEqual(executionGroup, groupFor(serialized, '11', '8', 'automatic', 101));
  assert.notEqual(groupFor(serialized, '12', '34', 'automatic', 101), groupFor(serialized, '123', '4', 'automatic', 101));
}

test('automatic admission replaces only pending automatic requests, preserving explicit requests', () => {
  const admission = entry.concurrency;
  assert.equal(admission['cancel-in-progress'], false);
  assert.ok(admission.queue === undefined || admission.queue === 'single');
  assertGrouping(admission.group, execution.concurrency.group);
  const equivalent = "other-admission-${{ inputs.repository_id }}-${{ inputs.pull_number }}-${{ inputs.trigger_source != 'automatic' && github.run_id || 'automatic' }}";
  assert.doesNotThrow(() => assertGrouping(equivalent, 'other-execution-${{ inputs.repository_id }}-${{ inputs.pull_number }}'));
  assert.doesNotThrow(() => assertGrouping(
    "${{ format('entry-{0}-{1}-{2}', inputs['repository_id'], inputs['pull_number'], inputs.trigger_source != 'AUTOMATIC' && github.run_id || 'automatic') }}",
    "${{ format('execution-{0}-{1}', inputs.repository_id, inputs.pull_number) }}",
  ));
  const request = "${{ inputs.trigger_source == 'automatic' && 'automatic' || github.run_id }}";
  for (const broken of [
    `entry-\${{ inputs.pull_number }}-${request}`,
    `entry-\${{ inputs.repository_id }}-${request}`,
    `entry-\${{ inputs.repository_id }}\${{ inputs.pull_number }}-${request}`,
    "entry-${{ inputs.repository_id }}-${{ inputs.pull_number }}-${{ github.run_id }}",
    "entry-${{ inputs.repository_id }}-${{ inputs.pull_number }}",
  ]) assert.throws(() => assertGrouping(broken, execution.concurrency.group));
  for (const broken of [
    'execution-${{ inputs.pull_number }}',
    'execution-${{ inputs.repository_id }}',
    'execution-${{ inputs.repository_id }}${{ inputs.pull_number }}',
    'execution-${{ inputs.repository_id }}-${{ inputs.pull_number }}-${{ github.run_id }}',
  ]) assert.throws(() => assertGrouping(admission.group, broken));
  assert.equal(entry.on.workflow_dispatch.inputs.trigger_source.default, 'automatic');
});

test('the reusable execution serializes the entire review and trusted publication for each PR', () => {
  assert.equal(entry.jobs.review.uses, './.github/workflows/review-execution.yml');
  assert.deepEqual(Object.keys(entry.jobs), ['review']);
  assert.equal(execution.concurrency.queue, 'max');
  assert.equal(execution.concurrency['cancel-in-progress'], false);
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
