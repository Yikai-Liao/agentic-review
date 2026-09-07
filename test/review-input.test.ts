import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../scripts/prepare-review-input.ts';

test('prepared input retains complete file navigation without expanding the full diff in incremental mode', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-input-'));
  const originalEnv = { ...process.env };
  try {
    Object.assign(process.env, {
      REVIEW_REPOSITORY: 'owner/repo', REVIEW_PULL_NUMBER: '60',
      REVIEW_TARGET_PATH: directory, REVIEW_BASE_PATH: directory,
      REVIEW_WORKSPACE_PATH: directory,
      REVIEW_BASE_SHA: 'a'.repeat(40), REVIEW_HEAD_SHA: 'b'.repeat(40),
      REVIEW_INPUT_PATH: path.join(directory, 'input.md'),
      REVIEW_DIFF_PATH: path.join(directory, 'full.diff'),
      REVIEW_FOCUS_DIFF_PATH: path.join(directory, 'focus.diff'),
    });
    const full = '+FULL_ONLY_EVIDENCE';
    const focus = '+FOCUS_ONLY_EVIDENCE';
    writeFileSync(process.env.REVIEW_DIFF_PATH!, full);
    writeFileSync(process.env.REVIEW_FOCUS_DIFF_PATH!, focus);
    writeFileSync(path.join(directory, 'AGENTS.md'), '项目约束');
    const fileList = Array.from({ length: 1200 }, (_, i) => `M\tfile-${i}.ts`).join('\n');
    const run = (command: string, args: string[]) => {
      if (command === 'git') {
        assert.equal(args.at(-1), `${'a'.repeat(40)}...${'b'.repeat(40)}`);
        return fileList;
      }
      assert.equal(command, 'gh');
      if (args.includes('graphql')) return JSON.stringify([{ data: { repository: { pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      } } } }]);
      return args.includes('view') ? '{"title":"测试 PR"}' : '[[{"id":1,"body":"明确决定"}]]';
    };
    for (const mode of ['initial', 'incremental_all', 'incremental', 'incremental_unchanged']) {
      process.env.REVIEW_MODE = mode;
      main(run);
      const input = readFileSync(process.env.REVIEW_INPUT_PATH!, 'utf8');
      assert.ok(input.includes(fileList));
      assert.ok(input.includes(process.env.REVIEW_DIFF_PATH!));
      assert.ok(input.includes('项目约束'));
      assert.ok(input.includes('明确决定'));
      const baseline = JSON.parse(readFileSync(path.join(directory, 'discussion-baseline.json'), 'utf8'));
      assert.equal(baseline.repository, 'owner/repo');
      assert.ok(baseline.fingerprints.inline_comments['1']);
      assert.equal(input.includes(full), mode === 'initial' || mode === 'incremental_all');
      assert.equal(input.includes(focus), mode === 'incremental');
      assert.equal(readFileSync(process.env.REVIEW_DIFF_PATH!, 'utf8'), full);
    }
    process.env.REVIEW_MODE = 'unknown';
    assert.throws(() => main(run), /Invalid review mode/);
    process.env.REVIEW_MODE = 'incremental';
    assert.throws(() => main(() => { throw new Error('GitHub unavailable'); }), /GitHub unavailable/);
  } finally {
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});
