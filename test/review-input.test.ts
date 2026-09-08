import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../scripts/prepare-review-input.ts';

test('prepared input captures discussion baseline and project rules without generating diffs', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-input-'));
  const originalEnv = { ...process.env };
  try {
    Object.assign(process.env, {
      REVIEW_REPOSITORY: 'owner/repo', REVIEW_PULL_NUMBER: '60',
      REVIEW_TARGET_PATH: directory, REVIEW_BASE_PATH: directory,
      REVIEW_WORKSPACE_PATH: directory,
      REVIEW_INPUT_PATH: path.join(directory, 'input.md'),
    });
    writeFileSync(path.join(directory, 'AGENTS.md'), '项目约束');
    const run = (command: string, args: string[]) => {
      assert.equal(command, 'gh');
      if (args.includes('graphql')) return JSON.stringify([{ data: { repository: { pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      } } } }]);
      return args.includes('view') ? '{"title":"测试 PR"}' : '[[{"id":1,"body":"明确决定"}]]';
    };
    main(run);
    const input = readFileSync(process.env.REVIEW_INPUT_PATH!, 'utf8');
    assert.ok(input.includes('测试 PR'));
    assert.ok(input.includes('项目约束'));
    assert.ok(input.includes('明确决定'));
    const baseline = JSON.parse(readFileSync(path.join(directory, 'discussion-baseline.json'), 'utf8'));
    assert.equal(baseline.repository, 'owner/repo');
    assert.ok(baseline.fingerprints.inline_comments['1']);
    assert.throws(() => main(() => { throw new Error('GitHub unavailable'); }), /GitHub unavailable/);
  } finally {
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});
