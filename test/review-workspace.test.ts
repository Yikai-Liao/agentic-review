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
      scope: { kind: 'pr', mode: 'full', rationale: '完整审查', explicit_text: '', ranges },
      ledger: ['auth.ts', 'billing.ts', 'cache.ts', 'api.ts', 'main.ts', 'test.ts', 'README.md']
        .map((file) => ({ path: file, status: 'complete' })) };
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(previous));
    writeFileSync(path.join(previousPath, 'notes.md'), '历史索引与 finding 摘要');
    writeFileSync(path.join(previousPath, 'review-result.json'), '{"body":"上一轮结论","comments":[],"thread_updates":[],"request_reply":null}');
    const progress: ReviewProgress = { scope: { mode: 'focused', rationale: '复核当前 thread', explicit_text: '', ranges },
      ledger: previous.ledger.map((entry) => ({ path: entry.path, status: 'pending' })) };
    const reset = () => writeFileSync(path.join(workspace, 'review-progress.json'), JSON.stringify(progress));
    reset();
    const context = { request: { ...request, run_id: '11', source: 'thread' as const, comment_id: '2', root_comment_id: '1' } };
    const manifest = prepareReviewWorkspace({ workspace, context, previousPath, threadPath: 'auth.ts' });
    const restored = JSON.parse(readFileSync(manifest.paths.progress, 'utf8'));
    assert.deepEqual(manifest.pending_files, ['auth.ts']);
    assert.equal(restored.ledger.filter((entry: any) => entry.status === 'complete').length, 6);
    assert.equal(manifest.inherited_from_run, '10:1');
    assert.equal(readFileSync(manifest.paths.notes!, 'utf8'), '历史索引与 finding 摘要');
    assert.equal(readFileSync(manifest.paths.previous_result!, 'utf8'), '{"body":"上一轮结论","comments":[],"thread_updates":[],"request_reply":null}');
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
    assert.deepEqual(changed.changed_paths, ['auth.ts', 'new-file.ts']);
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

test('一份工作稿和上一轮结果足以恢复调查，新快照仍保持待核定', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-notes-'));
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
      ledger: [{ path: 'auth.ts', status: 'complete' }] };
    writeFileSync(path.join(previousPath, 'review-coverage.json'), JSON.stringify(previous));
    const result = JSON.stringify({ body: '正文中的 finding 和完整证明。', comments: [], thread_updates: [], request_reply: null });
    writeFileSync(path.join(previousPath, 'review-result.json'), result);
    writeFileSync(path.join(previousPath, 'notes.md'), '已排除疑点的前提、待续读位置和结果引用。');
    const reset = () => writeFileSync(path.join(workspace, 'review-progress.json'), JSON.stringify({ scope,
      ledger: [{ path: 'auth.ts', status: 'pending' }] }));
    reset();
    const context = { request: { ...request, run_id: '11' } };
    const restored = prepareReviewWorkspace({ workspace, context, previousPath });
    assert.deepEqual(restored.pending_files, []);
    assert.deepEqual(JSON.parse(readFileSync(restored.paths.progress, 'utf8')).ledger,
      [{ path: 'auth.ts', status: 'complete' }]);
    assert.equal(readFileSync(restored.paths.previous_result!, 'utf8'), result);
    assert.equal(readFileSync(restored.paths.notes, 'utf8'), '已排除疑点的前提、待续读位置和结果引用。');
    reset();
    const changed = prepareReviewWorkspace({ workspace, previousPath,
      context: { request: { ...context.request, head_sha: 'c'.repeat(40) } }, readChanges: () => ['auth.ts'] });
    assert.deepEqual(changed.pending_files, ['auth.ts']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('automatic 增量延续未改完成项，新变化待审，间接影响可按需重开', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-lazy-resume-'));
  try {
    const previousPath = path.join(directory, 'previous');
    const workspace = path.join(directory, 'current');
    mkdirSync(previousPath);
    mkdirSync(workspace);
    const request = buildReviewRequest({ repository: 'owner/repo', pullNumber: 7,
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), runId: '10' });
    const previous: ReviewCoverage = { ...initialReviewCoverage(request), status: 'published', complete_audit: true,
      scope: { kind: 'pr', mode: 'full', rationale: '完整审查', explicit_text: '',
        ranges: [{ targets: ['complete pull request'], comparison_start: request.base_sha, comparison_end: request.head_sha }] },
      ledger: ['auth.ts', 'caller.ts', 'README.md'].map(file => ({ path: file, status: 'complete' })) };
    const coveragePath = path.join(previousPath, 'review-coverage.json');
    writeFileSync(coveragePath, JSON.stringify(previous));
    writeFileSync(path.join(previousPath, 'notes.md'), '鉴权入口与调用关系的既有调查。');
    const current = buildReviewRequest({ repository: 'owner/repo', pullNumber: 7,
      baseSha: request.base_sha, headSha: 'c'.repeat(40), runId: '11' });
    const files = [...previous.ledger.map(entry => entry.path), 'new.ts'];
    const progressPath = path.join(workspace, 'review-progress.json');
    const contextPath = path.join(directory, 'review-context.json');
    const reset = () => writeFileSync(progressPath, JSON.stringify({
      scope: { mode: 'full', rationale: '完整审查', explicit_text: '',
        ranges: [{ targets: ['complete pull request'], comparison_start: current.base_sha, comparison_end: current.head_sha }] },
      ledger: files.map(file => ({ path: file, status: 'pending' })),
    }));
    reset();
    writeFileSync(contextPath, JSON.stringify({ request: current }));
    const manifest = prepareReviewWorkspace({ workspace, previousPath, context: { request: current },
      readChanges: () => ['auth.ts', 'new.ts'] });
    assert.deepEqual(manifest.pending_files, ['auth.ts', 'new.ts']);
    const coverage = await readReviewProgress(contextPath, progressPath);
    assert.deepEqual(coverage.ledger.filter(entry => entry.status === 'complete').map(entry => entry.path), ['caller.ts', 'README.md']);
    await assert.rejects(validateCoverageCompletion(coverage, inventoryDigest(files)), /Incomplete coverage: auth.ts/);

    // 新鉴权实现改变调用约定时，Agent 可重开未直接修改的 caller；发布校验仍会阻止未完成项。
    coverage.ledger.forEach(entry => { entry.status = entry.path === 'caller.ts' ? 'pending' : 'complete'; });
    await assert.rejects(validateCoverageCompletion(coverage, inventoryDigest(files)), /Incomplete coverage: caller.ts/);
    coverage.ledger.find(entry => entry.path === 'caller.ts')!.status = 'complete';
    await validateCoverageCompletion(coverage, inventoryDigest(files));

    for (const [name, context, readChanges, prior] of [
      ['不同 base', { request: { ...current, base_sha: 'd'.repeat(40) } }, () => ['auth.ts'], previous],
      ['未知增量', { request: current }, () => null, previous],
      ['显式 PR 请求', { request: { ...current, source: 'pr_comment' as const, comment_id: '2', root_comment_id: '2' } }, () => ['auth.ts'], previous],
      ['未完成审查', { request: current }, () => ['auth.ts'], { ...previous, status: 'draft' as const, complete_audit: false }],
    ] as const) {
      reset();
      writeFileSync(coveragePath, JSON.stringify(prior));
      assert.deepEqual(prepareReviewWorkspace({ workspace, previousPath, context, readChanges }).pending_files, files, name);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
