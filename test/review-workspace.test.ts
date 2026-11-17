import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareReviewWorkspace } from '../scripts/prepare-review-workspace.ts';
import { inventoryDigest, readReviewProgress, validateCoverageCompletion } from '../scripts/review-coverage.ts';
import { buildReviewRequest, initialReviewCoverage, type ReviewCoverage, type ReviewProgress } from '../scripts/review-request.ts';

test('resume preserves the index and completed files while reopening the requested thread file', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-resume-'));
  try {
    const previousPath = path.join(directory, 'previous');
    const workspace = path.join(directory, 'current');
    mkdirSync(previousPath);
    mkdirSync(workspace);
    const request = buildReviewRequest({ repository: 'owner/repo', pullNumber: 7,
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), runId: '10' });
    const ranges = [{ targets: ['complete pull request'], comparison_start: request.base_sha, comparison_end: request.head_sha }];
    const previous: ReviewCoverage = { ...initialReviewCoverage(request), status: 'published',
      scope: { kind: 'pr', mode: 'full', rationale: 'Full review', explicit_text: '', ranges },
      ledger: ['auth.ts', 'billing.ts', 'cache.ts', 'api.ts', 'main.ts', 'test.ts', 'README.md']
        .map((file) => ({ path: file, status: 'complete' })) };
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(previous));
    writeFileSync(path.join(previousPath, 'notes.md'), 'Earlier index and finding summary');
    writeFileSync(path.join(previousPath, 'review-result.json'), '{"body":"Previous conclusion","comments":[],"thread_updates":[],"request_reply":null}');
    const progress: ReviewProgress = { scope: { mode: 'focused', rationale: 'Recheck the current thread', explicit_text: '', ranges },
      ledger: previous.ledger.map((entry) => ({ path: entry.path, status: 'pending' })) };
    const reset = () => writeFileSync(path.join(workspace, 'review-progress.json'), JSON.stringify(progress));
    reset();
    const context = { request: { ...request, run_id: '11', source: 'thread' as const, comment_id: '2', root_comment_id: '1' } };
    const manifest = prepareReviewWorkspace({ workspace, context, previousPath, threadPath: 'auth.ts' });
    const restored = JSON.parse(readFileSync(manifest.paths.progress, 'utf8'));
    assert.deepEqual(manifest.pending_files, ['auth.ts']);
    assert.equal(restored.ledger.filter((entry: any) => entry.status === 'complete').length, 6);
    assert.equal(manifest.inherited_from_run, '10:1');
    assert.equal(readFileSync(manifest.paths.notes!, 'utf8'), 'Earlier index and finding summary');
    assert.equal(readFileSync(manifest.paths.previous_result!, 'utf8'), '{"body":"Previous conclusion","comments":[],"thread_updates":[],"request_reply":null}');
    assert.equal(JSON.parse(readFileSync(path.join(previousPath, 'review-coverage.json'), 'utf8')).ledger[0].status, 'complete');

    // A new head may affect other files' contracts: evidence is kept, and completion is reconfirmed by this round's impact judgment.
    reset();
    const changed = prepareReviewWorkspace({ workspace, context: { request: { ...context.request, head_sha: 'c'.repeat(40) } }, previousPath,
      readChanges: (before, after) => {
        assert.equal(before, request.head_sha);
        assert.equal(after, 'c'.repeat(40));
        return ['auth.ts', 'new-file.ts'];
      } });
    assert.equal(changed.same_snapshot, false);
    assert.equal(changed.pending_files.length, 7);
    assert.deepEqual(changed.changed_paths, ['auth.ts', 'new-file.ts']);
    assert.equal(changed.same_base, true);
    assert.equal(readFileSync(changed.paths.notes!, 'utf8'), 'Earlier index and finding summary');

    // A failed diff read must stop; unknown changes never become an empty increment or inherited completion.
    reset();
    assert.throws(() => prepareReviewWorkspace({ workspace,
      context: { request: { ...context.request, head_sha: 'c'.repeat(40) } }, previousPath,
      readChanges: () => { throw new Error('git unavailable'); },
    }), /git unavailable/);
    assert.equal(JSON.parse(readFileSync(path.join(workspace, 'review-progress.json'), 'utf8'))
      .ledger.every((entry: { status: string }) => entry.status === 'pending'), true);

    // A re-review request after publication is not complete just because the snapshot is the same.
    reset();
    const repeated = prepareReviewWorkspace({ workspace, context: { request: { ...context.request, source: 'pr_comment' } }, previousPath });
    assert.equal(repeated.pending_files.length, 7);

    // The previous round published only partial conclusions within its time budget: a comment request on the same snapshot continues with unreviewed files only.
    const partial = { ...previous, ledger: previous.ledger.map((entry, index) => index < 2 ? { ...entry, status: 'pending' as const } : entry) };
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(partial));
    reset();
    const continued = prepareReviewWorkspace({ workspace, context: { request: { ...context.request, source: 'pr_comment' } }, previousPath });
    assert.deepEqual(continued.pending_files, ['auth.ts', 'billing.ts']);
    // New commits after a partial publication: published files that did not change directly stay complete; directly changed files are pending again.
    reset();
    const advanced = prepareReviewWorkspace({ workspace,
      context: { request: { ...context.request, source: 'pr_comment', head_sha: 'c'.repeat(40) } }, previousPath,
      readChanges: () => ['cache.ts'] });
    assert.deepEqual(advanced.pending_files, ['auth.ts', 'billing.ts', 'cache.ts']);
    // With an unknown diff, earlier completed entries are not treated as still valid.
    reset();
    const unknown = prepareReviewWorkspace({ workspace,
      context: { request: { ...context.request, source: 'pr_comment', head_sha: 'c'.repeat(40) } }, previousPath,
      readChanges: () => null });
    assert.equal(unknown.pending_files.length, 7);
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(previous));

    // A previous failure does not waive rechecking for a new PR comment; exclusions for the same scope are kept.
    previous.status = 'draft';
    previous.request = { ...previous.request, source: 'pr_comment', comment_id: '1', root_comment_id: '1' };
    previous.scope!.mode = 'focused';
    previous.ledger[0] = { path: 'auth.ts', status: 'pending' };
    previous.ledger[1] = { path: 'billing.ts', status: 'out_of_scope' };
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(previous));
    reset();
    const resumed = prepareReviewWorkspace({ workspace, context: { request: { ...context.request, source: 'pr_comment' } }, previousPath });
    assert.deepEqual(resumed.pending_files, previous.ledger.filter((entry) => entry.status !== 'out_of_scope').map((entry) => entry.path));
    const resumedProgress = JSON.parse(readFileSync(resumed.paths.progress, 'utf8'));
    assert.equal(resumedProgress.ledger[1].status, 'out_of_scope');
    assert.equal(resumedProgress.ledger[2].status, 'pending');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('A thread request carries over the previous round\'s source-reviewed files and reopens only the discussed file', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-thread-source-'));
  try {
    const previousPath = path.join(directory, 'previous');
    const workspace = path.join(directory, 'current');
    mkdirSync(previousPath);
    mkdirSync(workspace);
    const request = buildReviewRequest({ repository: 'owner/repo', pullNumber: 7,
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), runId: '10' });
    const ranges = [{ targets: ['complete pull request'], comparison_start: request.base_sha, comparison_end: request.head_sha }];
    const previous: ReviewCoverage = { ...initialReviewCoverage(request), status: 'published',
      scope: { kind: 'pr', mode: 'full', rationale: 'Full review', explicit_text: '', ranges },
      ledger: [{ path: 'auth.ts', status: 'source_reviewed' }, { path: 'billing.ts', status: 'source_reviewed' }, { path: 'cache.ts', status: 'complete' }] };
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(previous));
    const progress: ReviewProgress = { scope: { mode: 'focused', rationale: 'Recheck the current thread', explicit_text: '', ranges },
      ledger: previous.ledger.map((entry) => ({ path: entry.path, status: 'pending' })) };
    writeFileSync(path.join(workspace, 'review-progress.json'), JSON.stringify(progress));
    const context = { request: { ...request, run_id: '11', source: 'thread' as const, comment_id: '2', root_comment_id: '1' } };
    const manifest = prepareReviewWorkspace({ workspace, context, previousPath, threadPath: 'auth.ts' });
    assert.deepEqual(manifest.pending_files, ['auth.ts']);
    const restored = JSON.parse(readFileSync(manifest.paths.progress, 'utf8'));
    assert.deepEqual(restored.ledger.map((entry: any) => entry.status), ['pending', 'complete', 'complete']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('One working draft and the previous result are enough to resume, and a new snapshot still awaits confirmation', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-notes-'));
  try {
    const previousPath = path.join(directory, 'previous');
    const workspace = path.join(directory, 'current');
    mkdirSync(previousPath);
    mkdirSync(workspace);
    const request = buildReviewRequest({ repository: 'owner/repo', pullNumber: 7,
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), runId: '10' });
    const scope = { kind: 'pr' as const, mode: 'full' as const, rationale: 'Full review', explicit_text: '',
      ranges: [{ targets: ['complete pull request'], comparison_start: request.base_sha, comparison_end: request.head_sha }] };
    const previous: ReviewCoverage = { ...initialReviewCoverage(request), status: 'published', scope,
      ledger: [{ path: 'auth.ts', status: 'complete' }] };
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(previous));
    const result = JSON.stringify({ body: 'Findings with full proof in the body.', comments: [], thread_updates: [], request_reply: null });
    writeFileSync(path.join(previousPath, 'review-result.json'), result);
    writeFileSync(path.join(previousPath, 'notes.md'), 'Premises of ruled-out suspicions, where to resume reading, and result references.');
    const reset = () => writeFileSync(path.join(workspace, 'review-progress.json'), JSON.stringify({ scope,
      ledger: [{ path: 'auth.ts', status: 'pending' }] }));
    reset();
    const context = { request: { ...request, run_id: '11' } };
    const restored = prepareReviewWorkspace({ workspace, context, previousPath });
    assert.deepEqual(restored.pending_files, []);
    assert.deepEqual(JSON.parse(readFileSync(restored.paths.progress, 'utf8')).ledger,
      [{ path: 'auth.ts', status: 'complete' }]);
    assert.equal(readFileSync(restored.paths.previous_result!, 'utf8'), result);
    assert.equal(readFileSync(restored.paths.notes, 'utf8'), 'Premises of ruled-out suspicions, where to resume reading, and result references.');
    reset();
    const changed = prepareReviewWorkspace({ workspace, previousPath,
      context: { request: { ...context.request, head_sha: 'c'.repeat(40) } }, readChanges: () => ['auth.ts'] });
    assert.deepEqual(changed.pending_files, ['auth.ts']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('An automatic increment carries over unchanged completed entries, new changes are pending, and indirect impact can be reopened on demand', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-lazy-resume-'));
  try {
    const previousPath = path.join(directory, 'previous');
    const workspace = path.join(directory, 'current');
    mkdirSync(previousPath);
    mkdirSync(workspace);
    const request = buildReviewRequest({ repository: 'owner/repo', pullNumber: 7,
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), runId: '10' });
    const previous: ReviewCoverage = { ...initialReviewCoverage(request), status: 'published', complete_audit: true,
      scope: { kind: 'pr', mode: 'full', rationale: 'Full review', explicit_text: '',
        ranges: [{ targets: ['complete pull request'], comparison_start: request.base_sha, comparison_end: request.head_sha }] },
      ledger: ['auth.ts', 'caller.ts', 'README.md'].map(file => ({ path: file, status: 'complete' })) };
    const coveragePath = path.join(previousPath, 'review-coverage.json');
    writeFileSync(coveragePath, JSON.stringify(previous));
    writeFileSync(path.join(previousPath, 'notes.md'), 'Earlier investigation of the auth entry and its callers.');
    const current = buildReviewRequest({ repository: 'owner/repo', pullNumber: 7,
      baseSha: request.base_sha, headSha: 'c'.repeat(40), runId: '11' });
    const files = [...previous.ledger.map(entry => entry.path), 'new.ts'];
    const progressPath = path.join(workspace, 'review-progress.json');
    const contextPath = path.join(directory, 'review-context.json');
    const reset = () => writeFileSync(progressPath, JSON.stringify({
      scope: { mode: 'full', rationale: 'Full review', explicit_text: '',
        ranges: [{ targets: ['complete pull request'], comparison_start: current.base_sha, comparison_end: current.head_sha }] },
      ledger: files.map(file => ({ path: file, status: 'pending' })),
    }));
    reset();
    writeFileSync(contextPath, JSON.stringify({ request: current, source_reviewed: [] }));
    const manifest = prepareReviewWorkspace({ workspace, previousPath, context: { request: current },
      readChanges: () => ['auth.ts', 'new.ts'] });
    assert.deepEqual(manifest.pending_files, ['auth.ts', 'new.ts']);
    const coverage = await readReviewProgress(contextPath, progressPath);
    assert.deepEqual(coverage.ledger.filter(entry => entry.status === 'complete').map(entry => entry.path), ['caller.ts', 'README.md']);
    await assert.rejects(validateCoverageCompletion(coverage, inventoryDigest(files)), /Incomplete coverage: auth.ts/);

    // When a new auth implementation changes the calling convention, the agent may reopen callers that did not change directly; publication validation still blocks unfinished entries.
    coverage.ledger.forEach(entry => { entry.status = entry.path === 'caller.ts' ? 'pending' : 'complete'; });
    await assert.rejects(validateCoverageCompletion(coverage, inventoryDigest(files)), /Incomplete coverage: caller.ts/);
    coverage.ledger.find(entry => entry.path === 'caller.ts')!.status = 'complete';
    await validateCoverageCompletion(coverage, inventoryDigest(files));

    for (const [name, context, readChanges, prior] of [
      ['different base', { request: { ...current, base_sha: 'd'.repeat(40) } }, () => ['auth.ts'], previous],
      ['unknown increment', { request: current }, () => null, previous],
      ['explicit PR request', { request: { ...current, source: 'pr_comment' as const, comment_id: '2', root_comment_id: '2' } }, () => ['auth.ts'], previous],
      ['unfinished review', { request: current }, () => ['auth.ts'], { ...previous, status: 'draft' as const, complete_audit: false }],
    ] as const) {
      reset();
      writeFileSync(coveragePath, JSON.stringify(prior));
      assert.deepEqual(prepareReviewWorkspace({ workspace, previousPath, context, readChanges }).pending_files, files, name);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
