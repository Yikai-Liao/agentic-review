import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareReviewInput } from '../scripts/prepare-review-input.ts';
import { buildReviewRequest, initialReviewCoverage } from '../scripts/review-request.ts';
import { readDiscussion, type Run } from '../scripts/refresh-review-discussion.ts';

async function main(run: Run) {
  const { request } = JSON.parse(readFileSync(process.env.REVIEW_CONTEXT_PATH!, 'utf8'));
  return prepareReviewInput({ repository: request.repository, pullNumber: String(request.pull_number),
    baseSha: request.base_sha, headSha: request.head_sha, metadata: { title: 'Test PR' } },
  await readDiscussion(request.repository, String(request.pull_number), run), run);
}

const readInput = (file: string) => JSON.parse(readFileSync(file, 'utf8')).materials
  .map((item: { title: string; path: string }) => `## ${item.title}\n\n${readFileSync(item.path, 'utf8')}`).join('\n\n');

test('Startup materials are indexed by meaning and keep the discussion baseline, project rules, and pinned-range patches', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-input-'));
  const originalEnv = { ...process.env };
  try {
    const base = path.join(directory, 'base');
    const head = path.join(directory, 'head');
    mkdirSync(base);
    mkdirSync(head);
    Object.assign(process.env, {
      REVIEW_REPOSITORY: 'owner/repo', REVIEW_PULL_NUMBER: '60',
      REVIEW_TARGET_PATH: head, REVIEW_BASE_PATH: base,
      REVIEW_WORKSPACE_PATH: directory,
      REVIEW_CONTEXT_PATH: path.join(directory, 'review-context.json'),
      REVIEW_INPUT_PATH: path.join(directory, 'input.md'),
      REVIEW_ASSOCIATIONS_PATH: path.join(directory, 'associations.json'),
      REVIEW_ATTRIBUTION_PATH: path.join(directory, 'attribution.json'),
    });
    const associations = {
      pull_requests: [{ repository: 'owner/repo', number: 59, title: 'Source PR', url: 'https://github.com/owner/repo/pull/59' }],
      issues: [],
    };
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, JSON.stringify(associations));
    const sourcePullRequest = { number: 59, title: 'Source PR', url: 'https://github.com/owner/repo/pull/59' };
    writeFileSync(process.env.REVIEW_ATTRIBUTION_PATH!, JSON.stringify({
      reviewed: ['src/billing.ts'], composition: [{ path: 'src/auth.ts', pull_requests: [sourcePullRequest] }], pull_requests: [sourcePullRequest],
    }));
    writeFileSync(path.join(base, '.agentic-review.md'), 'Review at the code level by default.');
    writeFileSync(path.join(head, '.agentic-review.md'), 'Review design docs at the architecture level.');
    writeFileSync(path.join(head, 'AGENTS.md'), 'Project constraint: review development plans at the plan level.');
    mkdirSync(path.join(head, 'src'));
    mkdirSync(path.join(base, 'src'));
    writeFileSync(path.join(head, 'src/AGENTS.md'), 'Directory rule: keep interface error classes.');
    writeFileSync(path.join(base, 'src/AGENTS.md'), 'Old directory rule: unify interface error classes.');
    const initialRequest = buildReviewRequest({ repository: 'owner/repo', pullNumber: 60,
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), runId: '20', text: 'Auth only' });
    writeFileSync(process.env.REVIEW_CONTEXT_PATH!, JSON.stringify({ request: initialRequest, source_reviewed: ['src/billing.ts'] }));
    writeFileSync(path.join(directory, 'review-progress.json'), JSON.stringify({ ledger: [{ path: 'src/auth.ts', status: 'pending' }] }));
    const run = async (command: string, args: string[]) => {
      if (command === 'git') return args.includes('--name-only') ? 'src/auth.ts\0' : 'diff --git a/src/auth.ts b/src/auth.ts\n+auth change\n';
      assert.equal(command, 'gh');
      if (args.includes('graphql')) return JSON.stringify([{ data: { repository: { pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      } } } }]);
      return args.includes('view') ? '{"title":"Test PR"}' : '[[{"id":1,"body":"Explicit decision"}]]';
    };
    await main(run);
    const input = readInput(process.env.REVIEW_INPUT_PATH!);
    assert.ok(input.includes('Test PR'));
    assert.ok(input.includes('## Review request'));
    const index = input.split('## PR association index\n\n')[1].split('\n\n## ')[0];
    assert.deepEqual(JSON.parse(index), associations);
    assert.ok(input.includes('Auth only'));
    const attributionSection = JSON.parse(input.split('## Source review attribution\n\n')[1].split('\n\n## ')[0]);
    assert.equal(attributionSection.source_reviewed_files, 1);
    assert.deepEqual(attributionSection.composition_files, [{ path: 'src/auth.ts', pull_requests: [sourcePullRequest] }]);
    assert.ok(!input.split('## Review request\n\n')[1].split('\n\n## ')[0].includes('source_reviewed'));
    assert.ok(input.includes('Project constraint'));
    assert.ok(input.includes('## Base .agentic-review.md\n\nReview at the code level by default.'));
    assert.ok(input.includes('## Head .agentic-review.md\n\nReview design docs at the architecture level.'));
    assert.ok(input.includes('## Head AGENTS.md\n\nProject constraint: review development plans at the plan level.'));
    assert.ok(input.includes('## Head src/AGENTS.md\n\nDirectory rule: keep interface error classes.'));
    assert.ok(input.includes('## Base src/AGENTS.md\n\nOld directory rule: unify interface error classes.'));
    assert.ok(input.includes('## Current review notes\n\n# Review Notes'));
    assert.ok(input.includes('## Current review progress\n\n'));
    const runtimePaths = JSON.parse(input.split('## Review runtime paths\n\n')[1].split('\n\n## ')[0]);
    assert.equal(runtimePaths.target, head);
    assert.equal(runtimePaths.base, base);
    assert.equal(runtimePaths.control, fileURLToPath(new URL('../', import.meta.url)));
    assert.ok(input.includes('Explicit decision'));
    assert.ok(input.includes('Workspace resume manifest'));
    assert.ok(input.includes(path.join(directory, 'review-progress.json')));
    const notes = readFileSync(path.join(directory, 'notes.md'), 'utf8');
    assert.ok(!notes.includes('Auth only'));
    assert.ok(notes.includes('$REVIEW_CONTEXT_PATH'));
    assert.ok(notes.includes('central/review-rules.md'));
    assert.ok(notes.includes(path.join(directory, 'review-progress.json')));
    const assertInitialNotes = (source: string, instruction = '') => {
      const facts = source.match(/```json\n([\s\S]*?)\n```/);
      assert.ok(facts);
      const { text: _requestText, ...identity } = initialRequest;
      assert.deepEqual(JSON.parse(facts[1]), { request: identity, context_path: '$REVIEW_CONTEXT_PATH',
        rules_path: fileURLToPath(new URL('../central/review-rules.md', import.meta.url)), progress_path: path.join(directory, 'review-progress.json') });
      // Exclude only the instruction this case provides; completion conclusions in arbitrary Markdown quotes must not be erased with it.
      const scaffold = source.replace(facts[0], '').replace(instruction, '');
      assert.match(scaffold, /^# Review Notes\s+## Investigation\s*$/);
    };
    assertInitialNotes(notes);
    const instruction = '> complete marks finished entries; write "no issues found" only after investigating.';
    assert.doesNotThrow(() => assertInitialNotes(notes.replace('## Investigation',
      `${instruction}\n\n## Investigation`), instruction));
    for (const premature of ['- B1: complete', 'Conclusion: no issues found.', '> - B1: complete', '> Conclusion: no issues found.']) {
      assert.throws(() => assertInitialNotes(`${notes}\n${premature}\n`));
      assert.throws(() => assertInitialNotes(`${premature}\n${notes}`));
      assert.throws(() => assertInitialNotes(notes.replace('## Investigation', `${premature}\n\n## Investigation`)));
    }
    const baseline = JSON.parse(readFileSync(path.join(directory, 'discussion-baseline.json'), 'utf8'));
    assert.equal(baseline.repository, 'owner/repo');
    assert.ok(baseline.fingerprints.inline_comments['1']);
    // A first explicit request and the whole PR share the merge-base range, so only one patch is generated.
    const prRequest = { ...initialRequest, source: 'pr_comment', comment_id: '3', root_comment_id: '3' };
    writeFileSync(process.env.REVIEW_CONTEXT_PATH!, JSON.stringify({ request: prRequest, source_reviewed: ['src/billing.ts'],
      default_plan: { ranges: [{ comparison_start: prRequest.comparison_start, comparison_end: prRequest.head_sha }] } }));
    let patchReads = 0;
    await main(async (command, args) => {
      if (command === 'git' && args.includes('--unified=3')) patchReads++;
      return run(command, args);
    });
    const patches = JSON.parse(readFileSync(process.env.REVIEW_INPUT_PATH!, 'utf8')).materials
      .filter((item: { kind: string }) => item.kind === 'changes');
    assert.equal(patchReads, 1);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].use, 'changes');
    writeFileSync(process.env.REVIEW_CONTEXT_PATH!, JSON.stringify({ request: initialRequest, source_reviewed: ['src/billing.ts'] }));
    // An unchanged earlier snapshot only lowers default preload priority; new replies or edits still deliver the full thread.
    const history = path.join(directory, 'history');
    mkdirSync(history);
    writeFileSync(path.join(history, 'review-coverage.json'), JSON.stringify(initialReviewCoverage({ ...initialRequest, run_id: '19' })));
    writeFileSync(path.join(history, 'discussion-baseline.json'), JSON.stringify(baseline));
    writeFileSync(path.join(history, 'notes.md'), 'level: architecture\nEarlier judgment: keep the original scope when reading results.');
    writeFileSync(path.join(history, 'review-result.json'), JSON.stringify({ body: 'Previous explicit conclusion', comments: [], thread_updates: [], request_reply: null }));
    process.env.REVIEW_PREVIOUS_WORKSPACE_PATH = history;
    await main(run);
    assert.ok(readInput(process.env.REVIEW_INPUT_PATH!).includes('Earlier judgment: keep the original scope when reading results.'));
    assert.ok(readInput(process.env.REVIEW_INPUT_PATH!).includes('Previous explicit conclusion'));
    const materialIndex = () => JSON.parse(readFileSync(process.env.REVIEW_INPUT_PATH!, 'utf8')).materials as Array<{ kind: string; title: string; use: string; path: string }>;
    assert.ok(materialIndex().filter(item => item.kind === 'discussion').every(item => item.use === 'reference'));
    for (const comments of [
      [{ id: 1, body: 'Explicit decision', path: 'src/auth.ts' }, { id: 2, in_reply_to_id: 1, body: 'Follow-up confirmation', path: 'src/auth.ts' }],
      [{ id: 1, body: 'Edited decision', path: 'src/auth.ts' }],
    ]) {
      await main(async (command, args) => command === 'gh' && args.some(arg => arg.includes('/pulls/60/comments?'))
        ? JSON.stringify([comments]) : run(command, args));
      const thread = materialIndex().find(item => item.title === 'Review thread 1')!;
      assert.equal(thread.use, 'discussion');
      const content = readFileSync(thread.path, 'utf8');
      for (const comment of comments) assert.ok(content.includes(comment.body));
    }
    await main(async (command, args) => command === 'gh' && args.includes('graphql')
      ? JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: {
        nodes: [{ id: 'unmatched-thread', isResolved: false, isOutdated: false, resolvedBy: null, comments: { nodes: [{ databaseId: 99 }] } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } }]) : run(command, args));
    const unmatched = materialIndex().find(item => item.title === 'Review thread 99')!;
    assert.equal(unmatched.use, 'discussion');
    assert.ok(readFileSync(unmatched.path, 'utf8').includes('unmatched-thread'));
    delete process.env.REVIEW_PREVIOUS_WORKSPACE_PATH;
    await assert.rejects(main(async () => { throw new Error('GitHub unavailable'); }), /GitHub unavailable/);
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, JSON.stringify({ pull_requests: [], issues: [] }));
    await main(run);
    assert.ok(readInput(process.env.REVIEW_INPUT_PATH!).includes('"pull_requests": []'));
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, 'invalid json');
    await assert.rejects(main(run), SyntaxError);
    rmSync(process.env.REVIEW_ASSOCIATIONS_PATH!);
    await assert.rejects(main(run), /ENOENT/);

    // A large comment stays as separate raw text, and other rules and patches remain individually readable.
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, JSON.stringify(associations));
    const largeDecision = 'Explicit decision: keep the original scope. 🙂'.repeat(6000);
    await main(async (command, args) => command === 'git' || args.includes('view') || args.includes('graphql')
      ? run(command, args)
      : JSON.stringify([[{ id: 1, body: largeDecision }]]));
    const completeInput = readInput(process.env.REVIEW_INPUT_PATH!);
    assert.ok(completeInput.includes(largeDecision));
    assert.ok(completeInput.includes('## Head AGENTS.md'));
    assert.ok(completeInput.includes('Workspace resume manifest'));
    const catalog = JSON.parse(readFileSync(process.env.REVIEW_INPUT_PATH!, 'utf8'));
    assert.ok(catalog.materials.some((item: { kind: string; location: string }) => item.kind === 'changes' && item.location === 'src/auth.ts'));

    // Verify enumeration with real Git instead of pinning the arguments and output shape of an equivalent implementation.
    const git = (...args: string[]) => execFileSync('git', ['-C', head, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('add', '.'); git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    writeFileSync(path.join(head, '旧文件.ts'), 'old content');
    git('add', '.'); git('commit', '-qm', 'old head');
    const oldHead = git('rev-parse', 'HEAD');
    rmSync(path.join(head, '旧文件.ts'));
    writeFileSync(path.join(head, '含\n换行.ts'), 'new content');
    git('add', '.'); git('commit', '-qm', 'new head');
    const newHead = git('rev-parse', 'HEAD');
    const previous = path.join(directory, 'previous');
    mkdirSync(previous);
    const request = buildReviewRequest({ repository: 'owner/repo', pullNumber: 60,
      baseSha, headSha: oldHead, runId: '10' });
    writeFileSync(path.join(previous, 'review-coverage.json'), JSON.stringify(initialReviewCoverage(request)));
    writeFileSync(process.env.REVIEW_CONTEXT_PATH!, JSON.stringify({ request: { ...request, head_sha: newHead, run_id: '11' }, source_reviewed: [] }));
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, JSON.stringify(associations));
    process.env.REVIEW_PREVIOUS_WORKSPACE_PATH = previous;
    await main(run);
    const manifestPath = path.join(directory, 'resume-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifest.changed_paths.sort(), ['旧文件.ts', '含\n换行.ts'].sort());

    // When the earlier head is not in the current clone, the summary stays unknown while full input and progress can still be prepared.
    const unavailable = initialReviewCoverage({ ...request, head_sha: 'f'.repeat(40) });
    unavailable.scope = { kind: 'pr', mode: 'full', rationale: 'Full review', explicit_text: '',
      ranges: [{ targets: ['complete pull request'], comparison_start: baseSha, comparison_end: unavailable.request.head_sha }] };
    unavailable.status = 'published';
    unavailable.ledger = [{ path: '含\n换行.ts', status: 'complete' }];
    writeFileSync(path.join(previous, 'review-coverage.json'), JSON.stringify(unavailable));
    writeFileSync(path.join(previous, 'review-result.json'), JSON.stringify({
      body: 'No issues found.', comments: [], thread_updates: [], request_reply: null,
    }));
    writeFileSync(path.join(directory, 'review-progress.json'), JSON.stringify({
      ledger: [{ path: '含\n换行.ts', status: 'pending' }],
    }));
    await main(run);
    const unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(unknown.changed_paths, null);
    assert.deepEqual(unknown.pending_files, ['含\n换行.ts']);
    const ledger = JSON.parse(readFileSync(path.join(directory, 'review-progress.json'), 'utf8')).ledger;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].path, '含\n换行.ts');
    assert.equal(ledger[0].status, 'pending');
    assert.ok(readInput(process.env.REVIEW_INPUT_PATH!).includes('Test PR'));

  } finally {
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});
