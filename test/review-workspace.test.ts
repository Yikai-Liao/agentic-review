import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareReviewWorkspace } from '../scripts/prepare-review-workspace.ts';
import { buildReviewRequest, initialReviewCoverage, type ReviewCoverage, type ReviewProgress } from '../scripts/review-request.ts';

test('resume preserves the index and completed files while reopening the requested thread file', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-resume-'));
  try {
    const previousPath = path.join(directory, 'previous');
    const workspace = path.join(directory, 'current');
    mkdirSync(path.join(previousPath, 'batches'), { recursive: true });
    mkdirSync(workspace);
    const request = buildReviewRequest({ repository: 'owner/repo', pullNumber: 7,
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), runId: '10' });
    const ranges = [{ targets: ['complete pull request'], comparison_start: request.base_sha, comparison_end: request.head_sha }];
    const previous: ReviewCoverage = { ...initialReviewCoverage(request), status: 'published',
      scope: { kind: 'pr', mode: 'full', rationale: '完整审查', explicit_text: '', ranges },
      ledger: ['auth.ts', 'billing.ts', 'cache.ts', 'api.ts', 'main.ts', 'test.ts', 'README.md']
        .map((file) => ({ path: file, status: 'complete', batches: ['B1'] })), completed_batches: ['B1'] };
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(previous));
    writeFileSync(path.join(previousPath, 'batches/B1.md'), '完整证据与稳定覆盖 ID');
    writeFileSync(path.join(previousPath, 'notes.md'), '历史索引与 finding 摘要');
    writeFileSync(path.join(previousPath, 'review-result.json'), '{"body":"上一轮结论","comments":[],"thread_updates":[],"request_reply":null}');
    const progress: ReviewProgress = { scope: { mode: 'focused', rationale: '复核当前 thread', explicit_text: '', ranges },
      ledger: previous.ledger.map((entry) => ({ path: entry.path, status: 'pending', batches: [] })) };
    const reset = () => writeFileSync(path.join(workspace, 'review-progress.json'), JSON.stringify(progress));
    reset();
    const context = { request: { ...request, run_id: '11', source: 'thread' as const, comment_id: '2', root_comment_id: '1' } };
    const manifest = prepareReviewWorkspace({ workspace, context, previousPath, threadPath: 'auth.ts' });
    const restored = JSON.parse(readFileSync(manifest.paths.progress, 'utf8'));
    assert.deepEqual(manifest.pending_files, ['auth.ts']);
    assert.equal(restored.ledger.filter((entry: any) => entry.status === 'complete').length, 6);
    assert.deepEqual(manifest.batches, [{ id: 'B1', path: path.join(workspace, 'batches/B1.md'), pending_file_count: 1, directly_changed_files: [] }]);
    assert.equal(manifest.inherited_from_run, '10:1');
    assert.equal(readFileSync(manifest.paths.notes!, 'utf8'), '历史索引与 finding 摘要');
    assert.equal(readFileSync(manifest.paths.previous_result!, 'utf8'), '{"body":"上一轮结论","comments":[],"thread_updates":[],"request_reply":null}');
    assert.equal(readFileSync(manifest.batches[0].path, 'utf8'), '完整证据与稳定覆盖 ID');
    assert.equal(JSON.parse(readFileSync(path.join(previousPath, 'review-coverage.json'), 'utf8')).ledger[0].status, 'complete');

    // 新 head 的改动可能影响其他文件的契约：证据保留，完成状态由本轮影响判断重新确认。
    reset();
    const changed = prepareReviewWorkspace({ workspace, context: { request: { ...context.request, head_sha: 'c'.repeat(40) } }, previousPath,
      readChanges: (before, after) => {
        assert.equal(before, request.head_sha);
        assert.equal(after, 'c'.repeat(40));
        return ['auth.ts', 'new-file.ts'];
      } });
    assert.equal(changed.same_snapshot, false);
    assert.equal(changed.pending_files.length, 7);
    assert.equal(changed.batches[0].pending_file_count, 7);
    assert.deepEqual(changed.changed_paths, ['auth.ts', 'new-file.ts']);
    assert.deepEqual(changed.batches[0].directly_changed_files, ['auth.ts']);
    assert.equal(changed.same_base, true);
    assert.equal(readFileSync(changed.paths.notes!, 'utf8'), '历史索引与 finding 摘要');

    // 差分读取失败必须停止，不能把未知变化表示成空增量或完成继承。
    reset();
    assert.throws(() => prepareReviewWorkspace({ workspace,
      context: { request: { ...context.request, head_sha: 'c'.repeat(40) } }, previousPath,
      readChanges: () => { throw new Error('git unavailable'); },
    }), /git unavailable/);
    assert.equal(JSON.parse(readFileSync(path.join(workspace, 'review-progress.json'), 'utf8'))
      .ledger.every((entry: { status: string }) => entry.status === 'pending'), true);

    // 发布后请求重新审查，不能凭相同快照自动视为完成。
    reset();
    const repeated = prepareReviewWorkspace({ workspace, context: { request: { ...context.request, source: 'pr_comment' } }, previousPath });
    assert.equal(repeated.pending_files.length, 7);

    // 上次失败也不免除新 PR 评论的复核义务；相同范围的排除项仍保留。
    previous.status = 'draft';
    previous.request = { ...previous.request, source: 'pr_comment', comment_id: '1', root_comment_id: '1' };
    previous.scope!.mode = 'focused';
    previous.ledger[0] = { path: 'auth.ts', status: 'pending', batches: ['B1'] };
    previous.ledger[1] = { path: 'billing.ts', status: 'out_of_scope', batches: [] };
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(previous));
    reset();
    const resumed = prepareReviewWorkspace({ workspace, context: { request: { ...context.request, source: 'pr_comment' } }, previousPath });
    assert.deepEqual(resumed.pending_files, previous.ledger.filter((entry) => entry.status !== 'out_of_scope').map((entry) => entry.path));
    const resumedProgress = JSON.parse(readFileSync(resumed.paths.progress, 'utf8'));
    assert.equal(resumedProgress.ledger[1].status, 'out_of_scope');
    assert.equal(resumedProgress.ledger[2].status, 'pending');

    // 空证据不得凭历史状态通过恢复。
    writeFileSync(path.join(previousPath, 'batches/B1.md'), '');
    reset();
    assert.throws(() => prepareReviewWorkspace({ workspace, context, previousPath }), /Missing inherited batch evidence/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('同一快照恢复无 batch 的完成项，代码变化后重新核定', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-no-candidate-'));
  try {
    const previousPath = path.join(directory, 'previous');
    const workspace = path.join(directory, 'current');
    mkdirSync(previousPath);
    mkdirSync(workspace);
    const request = buildReviewRequest({ repository: 'owner/repo', pullNumber: 7,
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), runId: '10' });
    const scope = { kind: 'pr' as const, mode: 'full' as const, rationale: '完整审查', explicit_text: '',
      ranges: [{ targets: ['complete pull request'], comparison_start: request.base_sha, comparison_end: request.head_sha }] };
    const previous: ReviewCoverage = { ...initialReviewCoverage(request), status: 'published', scope,
      ledger: [{ path: 'auth.ts', status: 'complete', batches: [] }], completed_batches: [] };
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(previous));
    const result = { body: '未发现问题。', comments: [] as Array<{ path: string; line: number; start_line: null; body: string }>, thread_updates: [], request_reply: null };
    writeFileSync(path.join(previousPath, 'review-result.json'), JSON.stringify(result));
    const reset = () => writeFileSync(path.join(workspace, 'review-progress.json'), JSON.stringify({ scope,
      ledger: [{ path: 'auth.ts', status: 'pending', batches: [] }] }));
    reset();
    const context = { request: { ...request, run_id: '11' } };
    const restored = prepareReviewWorkspace({ workspace, context, previousPath });
    assert.deepEqual(restored.batches, []);
    assert.deepEqual(restored.pending_files, []);
    assert.deepEqual(JSON.parse(readFileSync(restored.paths.progress, 'utf8')).ledger,
      [{ path: 'auth.ts', status: 'complete', batches: [] }]);
    reset();
    const changed = prepareReviewWorkspace({ workspace, previousPath,
      context: { request: { ...context.request, head_sha: 'c'.repeat(40) } }, readChanges: () => ['auth.ts'] });
    assert.deepEqual(changed.batches, []);
    assert.deepEqual(changed.pending_files, ['auth.ts']);
    result.comments.push({ path: 'auth.ts', line: 1, start_line: null, body: '有 finding。' });
    writeFileSync(path.join(previousPath, 'review-result.json'), JSON.stringify(result));
    reset();
    assert.throws(() => prepareReviewWorkspace({ workspace, context, previousPath }), /Missing finding batch evidence/);
    previous.ledger[0].batches = ['B1'];
    previous.completed_batches = ['B1'];
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(previous));
    mkdirSync(path.join(previousPath, 'batches'));
    writeFileSync(path.join(previousPath, 'batches/B1.md'), 'auth.ts finding 的调查证据。');
    const withEvidence = prepareReviewWorkspace({ workspace, context, previousPath });
    assert.deepEqual(withEvidence.pending_files, []);
    assert.equal(withEvidence.batches[0].id, 'B1');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
