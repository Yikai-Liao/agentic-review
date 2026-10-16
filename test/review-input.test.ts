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
      REVIEW_CONTEXT_PATH: path.join(directory, 'review-context.json'),
      REVIEW_INPUT_PATH: path.join(directory, 'input.md'),
      REVIEW_ASSOCIATIONS_PATH: path.join(directory, 'associations.json'),
    });
    const associations = {
      pull_requests: [{ repository: 'owner/repo', number: 59, title: '源 PR', url: 'https://github.com/owner/repo/pull/59' }],
      issues: [],
    };
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, JSON.stringify(associations));
    writeFileSync(path.join(directory, 'AGENTS.md'), '项目约束');
    writeFileSync(process.env.REVIEW_CONTEXT_PATH!, JSON.stringify({ request: { text: '只看鉴权' } }));
    writeFileSync(path.join(directory, 'review-progress.json'), JSON.stringify({ ledger: [] }));
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
    assert.ok(input.includes('## Review request'));
    const index = input.split('## PR association index\n\n')[1].split('\n\n## ')[0];
    assert.deepEqual(JSON.parse(index), associations);
    assert.ok(input.includes('只看鉴权'));
    assert.ok(input.includes('项目约束'));
    assert.ok(input.includes('明确决定'));
    assert.ok(input.includes('Workspace resume manifest'));
    assert.ok(input.includes(path.join(directory, 'review-progress.json')));
    const baseline = JSON.parse(readFileSync(path.join(directory, 'discussion-baseline.json'), 'utf8'));
    assert.equal(baseline.repository, 'owner/repo');
    assert.ok(baseline.fingerprints.inline_comments['1']);
    assert.throws(() => main(() => { throw new Error('GitHub unavailable'); }), /GitHub unavailable/);
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, JSON.stringify({ pull_requests: [], issues: [] }));
    main(run);
    assert.ok(readFileSync(process.env.REVIEW_INPUT_PATH!, 'utf8').includes('"pull_requests": []'));
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, 'invalid json');
    assert.throws(() => main(run), SyntaxError);
    rmSync(process.env.REVIEW_ASSOCIATIONS_PATH!);
    assert.throws(() => main(run), /ENOENT/);
  } finally {
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});
