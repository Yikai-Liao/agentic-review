import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildReviewRequest, initialReviewCoverage, validateReviewScope } from '../scripts/review-request.ts';
import { inventoryDigest, parseReviewCoverage, validateAuditCheckpoint, validateCoverageCompletion } from '../scripts/review-coverage.ts';

const noFindings = { body: '未发现问题。', comments: [], thread_updates: [], request_reply: null };

function fixture() {
  const request = buildReviewRequest({ source: 'automatic', repository: 'owner/repo', pullNumber: 7, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), runId: '20' });
  return { ...initialReviewCoverage(request), status: 'draft' as const, completed_batches: ['B1'],
    ledger: [{ path: 'src/a.ts', status: 'complete' as const, batches: ['B1'] }],
    scope: { kind: 'pr' as const, mode: 'full' as const, rationale: 'complete PR', explicit_text: '', ranges: [{ targets: ['complete pull request'], comparison_start: request.comparison_start, comparison_end: request.head_sha }] } };
}

test('发布允许无候选完成项省略 batch，仍拒绝漏项、未完成及无效证据引用', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'coverage-'));
  const digest = inventoryDigest(['src/a.ts']);
  try {
    const noCandidate = { ...fixture(), completed_batches: [],
      ledger: [{ path: 'src/a.ts', status: 'complete' as const, batches: [] }] };
    await validateCoverageCompletion(noCandidate, workspace, digest, noFindings);
    await mkdir(path.join(workspace, 'batches'));
    await writeFile(path.join(workspace, 'batches/B1.md'), 'a.ts 全部 hunk 的证据与结论');
    await validateCoverageCompletion(fixture(), workspace, digest, noFindings);
    await validateCoverageCompletion({ ...fixture(), ledger: [fixture().ledger[0],
      { path: 'src/b.ts', status: 'complete', batches: [] }] }, workspace, inventoryDigest(['src/a.ts', 'src/b.ts']), noFindings);
    const finding = { ...noFindings, comments: [{ path: 'src/a.ts', line: 1, start_line: null, body: '有 finding。' }] };
    await assert.rejects(validateCoverageCompletion(noCandidate, workspace, digest, finding), /Missing finding batch evidence/);
    await validateCoverageCompletion(fixture(), workspace, digest, finding);
    await assert.rejects(validateCoverageCompletion({ ...fixture(), ledger: [fixture().ledger[0],
      { path: 'src/b.ts', status: 'complete', batches: [] }] }, workspace, inventoryDigest(['src/a.ts', 'src/b.ts']),
      { ...finding, comments: [{ ...finding.comments[0], path: 'src/b.ts' }] }), /Missing finding batch evidence: src\/b.ts/);
    const update = { ...noFindings, thread_updates: [{ root_comment_id: 1, status: 'resolved' as const, evidence: '有依据的状态变化。' }] };
    await assert.rejects(validateCoverageCompletion(noCandidate, workspace, digest, update), /Missing thread update batch evidence/);
    await validateCoverageCompletion(fixture(), workspace, digest, update);
    await assert.rejects(validateCoverageCompletion({ ...fixture(), ledger: [] }, workspace, digest, noFindings), /inventory/);
    await assert.rejects(validateCoverageCompletion({ ...fixture(), ledger: [{ path: 'src/a.ts', status: 'pending', batches: [] }] }, workspace, digest, noFindings), /Incomplete/);
    await assert.rejects(validateCoverageCompletion({ ...fixture(), ledger: [{ path: 'src/a.ts', status: 'out_of_scope', batches: [] }] }, workspace, digest, noFindings), /Incomplete/);
    await assert.rejects(validateCoverageCompletion({ ...fixture(), completed_batches: [] }, workspace, digest, noFindings), /batches/);
    await writeFile(path.join(workspace, 'batches/B1.md'), '');
    await assert.rejects(validateCoverageCompletion(fixture(), workspace, digest, noFindings), /Missing batch/);
    await rm(path.join(workspace, 'batches/B1.md'));
    await assert.rejects(validateCoverageCompletion(fixture(), workspace, digest, noFindings), /ENOENT/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('automatic scope cannot use incremental mode or shrink its comparison interval', () => {
  const value = fixture();
  assert.throws(() => validateReviewScope({ ...value.scope, mode: 'incremental' }, value.request), /complete PR/);
  assert.throws(() => validateReviewScope({ ...value.scope, ranges: [{ ...value.scope.ranges[0], comparison_start: value.request.head_sha }] }, value.request), /complete PR/);
});

test('history rejects invalid request, scope, state and duplicate ledger records', () => {
  const value = fixture();
  assert.deepEqual(parseReviewCoverage(value), value);
  for (const bad of [
    { ...value, status: 'success' }, { ...value, complete_audit: true },
    { ...value, request: { ...value.request, version: 2 } },
    { ...value, scope: { ...value.scope, ranges: [{ ...value.scope.ranges[0], comparison_end: 'c'.repeat(40) }] } },
    { ...value, ledger: [value.ledger[0], value.ledger[0]] },
    { ...value, ledger: [{ ...value.ledger[0], batches: ['../../secret'] }] },
  ]) assert.throws(() => parseReviewCoverage(bad));
});

test('checkpoint requires published full audit bound to the selected run and snapshot', () => {
  const value = fixture();
  const expected = { repository: 'owner/repo', pullNumber: 7, base: value.request.base_sha, head: value.request.head_sha, run: '20', attempt: '1' };
  assert.throws(() => validateAuditCheckpoint(value, expected), /completed audit/);
  const published = { ...value, status: 'published' as const, complete_audit: true };
  validateAuditCheckpoint(published, expected);
  assert.throws(() => validateAuditCheckpoint(published, { ...expected, attempt: '2' }), /completed audit/);
  assert.throws(() => validateAuditCheckpoint({ ...published, complete_audit: false }, expected), /completed audit/);
});
