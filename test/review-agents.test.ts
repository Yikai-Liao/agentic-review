import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadReviewAgents } from '../src/review-agents.ts';

const engineRoot = path.resolve(import.meta.dirname, '..');

test('从中央配置选择 Review Agents', async () => {
  assert.deepEqual((await loadReviewAgents(engineRoot)).map(({ id }) => id), ['production-semantics', 'test-quality']);
  assert.equal((await loadReviewAgents(engineRoot, 'performance'))[0]!.id, 'performance');
  await assert.rejects(() => loadReviewAgents(engineRoot, 'missing'), /Unknown REVIEW_AGENTS/);
});
