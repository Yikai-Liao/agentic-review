import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { comparisonUsable, buildReviewRequest, prepareDefaultReviewPlan, type ReviewCoverage } from '../scripts/review-request.ts';

const base = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);
const head = 'c'.repeat(40);

function request(source: 'automatic' | 'pr_comment' | 'thread', currentHead = head) {
  return buildReviewRequest({ source, repository: 'owner/repo', pullNumber: 7, baseSha: base, headSha: currentHead, comparisonStart: base, runId: '20', runAttempt: '1', now: '2026-01-01T00:00:00Z' });
}

function previous(status: ReviewCoverage['status'], previousHead = oldHead): ReviewCoverage {
  const value = request('pr_comment', previousHead);
  return {
    request: value, status, ledger: [], complete_audit: false, updated_at: value.requested_at,
    scope: { kind: 'pr', mode: 'focused', rationale: 'auth', explicit_text: 'auth', ranges: [{ targets: ['auth'], comparison_start: base, comparison_end: previousHead }] },
  };
}

test('reopens the prior actual PR scope when head is unchanged', () => {
  const plan = prepareDefaultReviewPlan(request('pr_comment', oldHead), previous('published', oldHead), () => true);
  assert.equal(plan.reason, 'reopen_unchanged_scope');
  assert.deepEqual(plan.ranges.at(-1)!.targets, ['auth']);
  assert.equal(plan.ranges.at(-1)!.comparison_start, base);
});

test('resumes failed scope and compares failed head to new head', () => {
  const plan = prepareDefaultReviewPlan(request('pr_comment', head), previous('failed'), () => true);
  assert.equal(plan.reason, 'resume_failed_scope');
  assert.equal(plan.ranges.at(-1)!.comparison_start, oldHead);
  assert.deepEqual(plan.ranges.at(-1)!.targets, ['all changes in comparison interval and direct impact']);
  assert.deepEqual(plan.ranges[0]?.targets, ['auth']);
  assert.equal(plan.ranges[0]?.comparison_start, base);
  assert.equal(plan.ranges[0]?.comparison_end, oldHead);
  assert.equal(plan.inherited_from_run, '20:1');
});

test('thread default does not inherit PR scope history', () => {
  const plan = prepareDefaultReviewPlan(request('thread'), previous('published'), () => true);
  assert.equal(plan.reason, 'thread_default');
  assert.equal(plan.kind, 'thread');
  assert.equal(plan.inherited_from_run, null);
});


test('published focused history does not restrict new changes to old targets', () => {
  const plan = prepareDefaultReviewPlan(request('pr_comment'), previous('published'), () => true);
  assert.deepEqual(plan.ranges.at(-1)!.targets, ['all changes in comparison interval and direct impact']);
  assert.equal(plan.ranges.length, 1);
});

test('automatic review keeps complete PR scope after a focused request', () => {
  const plan = prepareDefaultReviewPlan(request('automatic', oldHead), previous('published'), () => true);
  assert.equal(plan.mode, 'full');
  assert.deepEqual(plan.ranges.at(-1)!.targets, ['complete pull request']);
});

test('base changes and unavailable history cannot reopen an unchanged scope', () => {
  const changedBase = { ...request('pr_comment', oldHead), base_sha: head };
  assert.equal(prepareDefaultReviewPlan(changedBase, previous('published'), () => true).mode, 'full');
  assert.throws(() => prepareDefaultReviewPlan(request('pr_comment'), previous('failed'), () => false), /comparison is unavailable/);
});


test('real commit history retains failed auth interval and includes new payments changes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-scope-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(dir, 'auth.ts'), 'initial');
    git('add', '.'); git('commit', '-qm', 'base');
    const a = git('rev-parse', 'HEAD');
    writeFileSync(path.join(dir, 'auth.ts'), 'changed');
    git('add', '.'); git('commit', '-qm', 'auth');
    const b = git('rev-parse', 'HEAD');
    writeFileSync(path.join(dir, 'payments.ts'), 'new payments');
    git('add', '.'); git('commit', '-qm', 'payments');
    const c = git('rev-parse', 'HEAD');
    const old = previous('draft');
    old.request = { ...old.request, base_sha: a, head_sha: b };
    old.scope = { ...old.scope!, ranges: [{ targets: ['auth'], comparison_start: a, comparison_end: b }] };
    const current = { ...request('pr_comment'), base_sha: a, head_sha: c, comparison_start: a };
    const plan = prepareDefaultReviewPlan(current, old, (start, end) => comparisonUsable(dir, start, end));
    assert.equal(git('diff', '--name-only', plan.ranges.at(-1)!.comparison_start, plan.ranges.at(-1)!.comparison_end), 'payments.ts');
    assert.equal(git('diff', '--name-only', plan.ranges[0].comparison_start, plan.ranges[0].comparison_end), 'auth.ts');
    assert.deepEqual(plan.ranges[0].targets, ['auth']);
    assert.equal(comparisonUsable(dir, 'f'.repeat(40), c), false);
    assert.equal(comparisonUsable(dir, c, b), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('consecutive failures preserve every interval, including retries before scope is recorded', () => {
  const secondRequest = request('pr_comment', head);
  const secondPlan = prepareDefaultReviewPlan(secondRequest, previous('failed'), () => true);
  const second: ReviewCoverage = {
    request: secondRequest, default_plan: secondPlan, status: 'requested', ledger: [], complete_audit: false, updated_at: secondRequest.requested_at,
  };
  const sameHead = prepareDefaultReviewPlan(secondRequest, second, () => true);
  assert.deepEqual(sameHead.ranges, secondPlan.ranges);
  const nextRequest = request('pr_comment', 'd'.repeat(40));
  for (const saved of [
    second,
    { ...second, status: 'failed' as const, scope: { ...previous('failed').scope!, ranges: secondPlan.ranges } },
  ]) {
    const next = prepareDefaultReviewPlan(nextRequest, saved, () => true);
    assert.deepEqual(next.ranges.map(({ comparison_start, comparison_end }) => [comparison_start, comparison_end]),
      [[base, oldHead], [oldHead, head], [head, nextRequest.head_sha]]);
    assert.deepEqual(next.ranges[0].targets, ['auth']);
  }
  const published = { ...second, status: 'published' as const, scope: { ...previous('failed').scope!, ranges: secondPlan.ranges } };
  assert.equal(prepareDefaultReviewPlan(nextRequest, published, () => true).ranges.length, 1);
});
