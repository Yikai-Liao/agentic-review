import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectExistingCheck } from '../src/check.ts';

test('creates the first Check and reuses only active or successful App checks', () => {
  assert.equal(selectExistingCheck([], 'review-app', 'task'), undefined);
  assert.deepEqual(selectExistingCheck([
    { id: 1, app: { slug: 'review-app' }, status: 'in_progress', conclusion: null, external_id: 'task' },
  ], 'review-app', 'task'), { id: 1, duplicate: false });
  assert.deepEqual(selectExistingCheck([
    { id: 2, app: { slug: 'review-app' }, status: 'completed', conclusion: 'success', external_id: 'task' },
  ], 'review-app', 'task'), { id: 2, duplicate: true });
  assert.equal(selectExistingCheck([
    { id: 3, app: { slug: 'review-app' }, status: 'completed', conclusion: 'failure', external_id: 'task' },
  ], 'review-app', 'task'), undefined);
  assert.equal(selectExistingCheck([
    { id: 4, app: { slug: 'review-app' }, status: 'completed', conclusion: 'success', external_id: 'other-base' },
  ], 'review-app', 'task'), undefined);
});
