import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadReviewAgents } from '../src/review-agents.ts';

test('从中央配置选择 Review Agents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-agents-'));
  await writeFile(path.join(root, 'review-agents.json'), JSON.stringify({
    agents: [
      { id: 'optional-agent', runByDefault: false },
      { id: 'default-agent', runByDefault: true },
    ],
  }));
  try {
    assert.deepEqual((await loadReviewAgents(root)).map(({ id }) => id), ['default-agent']);
    assert.deepEqual((await loadReviewAgents(root, 'optional-agent')).map(({ id }) => id), ['optional-agent']);
    await assert.rejects(() => loadReviewAgents(root, 'missing'), /Unknown REVIEW_AGENTS/);
  } finally {
    await rm(root, { recursive: true });
  }
});
