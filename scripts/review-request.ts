import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { CoverageEntry } from './review-coverage.ts';

export type ReviewRequest = {
  version: 1;
  source: 'automatic' | 'pr_comment' | 'thread';
  comment_id: string | null;
  root_comment_id: string | null;
  text: string;
  repository: string;
  pull_number: number;
  base_sha: string;
  head_sha: string;
  comparison_start: string;
  requested_at: string;
  run_id: string;
  run_attempt: string;
};

export type ReviewScope = {
  id: string;
  kind: 'pr' | 'thread';
  mode: 'full' | 'incremental' | 'focused';
  rationale: string;
  inherited_from_run: string | null;
  explicit_text: string;
  targets: string[];
  comparison_start: string;
  comparison_end: string;
  decided_at: string;
};

export type ReviewCoverage = {
  request: ReviewRequest;
  scope?: ReviewScope;
  default_plan?: DefaultReviewPlan;
  status: 'requested' | 'draft' | 'published' | 'failed';
  completed_batches: string[];
  ledger: CoverageEntry[];
  complete_audit: boolean;
  updated_at: string;
};

export type DefaultReviewPlan = {
  kind: 'pr' | 'thread';
  mode: 'full' | 'incremental' | 'focused';
  targets: string[];
  comparison_start: string;
  comparison_end: string;
  inherited_from_run: string | null;
  reason: 'thread_default' | 'no_history' | 'reopen_unchanged_scope' | 'resume_failed_scope' | 'continue_published_scope';
  previous_status: ReviewCoverage['status'] | null;
  pending_scope?: ReviewScope;
};

const sha = /^[0-9a-f]{40}$/;

export function buildReviewRequest(input: {
  source?: string;
  commentId?: string;
  rootCommentId?: string;
  text?: string;
  repository: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  comparisonStart?: string;
  runId: string;
  runAttempt?: string;
  now?: string;
}): ReviewRequest {
  const source = input.source === 'thread' || input.source === 'pr_comment' ? input.source : 'automatic';
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(input.repository)) throw new Error('Invalid review repository');
  if (!Number.isInteger(input.pullNumber) || input.pullNumber < 1) throw new Error('Invalid review pull number');
  for (const value of [input.baseSha, input.headSha]) if (!sha.test(value)) throw new Error('Invalid review snapshot');
  const comparisonStart = input.comparisonStart ?? input.baseSha;
  if (!sha.test(comparisonStart)) throw new Error('Invalid review comparison start');
  if (!input.runId || !/^[A-Za-z0-9._-]+$/.test(input.runId)) throw new Error('Invalid review run identity');
  const runAttempt = input.runAttempt ?? '1';
  if (!/^[0-9]+$/.test(runAttempt) || Number(runAttempt) < 1) throw new Error('Invalid review run attempt');
  return {
    version: 1,
    source,
    comment_id: input.commentId || null,
    root_comment_id: input.rootCommentId || null,
    text: input.text ?? '',
    repository: input.repository,
    pull_number: input.pullNumber,
    base_sha: input.baseSha,
    head_sha: input.headSha,
    comparison_start: comparisonStart,
    requested_at: input.now ?? new Date().toISOString(),
    run_id: input.runId,
    run_attempt: runAttempt,
  };
}

export async function persistReviewCoverage(file: string, coverage: ReviewCoverage): Promise<void> {
  if (!path.isAbsolute(file)) throw new Error('Review coverage path must be absolute');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(coverage)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

export function initialReviewCoverage(request: ReviewRequest): ReviewCoverage {
  return { request, status: 'requested', completed_batches: [], ledger: [], complete_audit: false, updated_at: request.requested_at };
}

export function comparisonUsable(targetPath: string, start: string, end: string): boolean {
  if (!sha.test(start) || !sha.test(end)) return false;
  for (const commit of [start, end]) {
    if (spawnSync('git', ['-C', targetPath, 'cat-file', '-e', `${commit}^{commit}`]).status !== 0) return false;
  }
  return spawnSync('git', ['-C', targetPath, 'merge-base', '--is-ancestor', start, end]).status === 0;
}

export function prepareDefaultReviewPlan(
  request: ReviewRequest,
  previous: ReviewCoverage | null,
  usable: (start: string, end: string) => boolean,
): DefaultReviewPlan {
  if (request.source === 'thread') return {
    kind: 'thread', mode: 'focused', targets: ['current thread and direct impact'], comparison_start: request.comparison_start,
    comparison_end: request.head_sha, inherited_from_run: null, reason: 'thread_default', previous_status: null,
  };
  const full: DefaultReviewPlan = {
    kind: 'pr', mode: 'full', targets: ['complete pull request'], comparison_start: request.comparison_start,
    comparison_end: request.head_sha, inherited_from_run: null, reason: 'no_history', previous_status: null,
  };
  if (request.source === 'automatic') return full;
  const scope = previous?.scope;
  if (!previous || !scope || scope.kind !== 'pr' || previous.request.repository !== request.repository
    || previous.request.pull_number !== request.pull_number || scope.comparison_end !== previous.request.head_sha
    || !scope.targets.length || !usable(scope.comparison_start, scope.comparison_end)) return full;
  const inherited = `${previous.request.run_id}:${previous.request.run_attempt}`;
  if (previous.request.head_sha === request.head_sha && previous.request.base_sha === request.base_sha) return {
    kind: 'pr', mode: scope.mode, targets: [...scope.targets], comparison_start: scope.comparison_start,
    comparison_end: request.head_sha, inherited_from_run: inherited,
    reason: 'reopen_unchanged_scope', previous_status: previous.status,
  };
  const failed = previous.status !== 'published';
  const incremental = previous.request.base_sha === request.base_sha && usable(previous.request.head_sha, request.head_sha);
  return {
    kind: 'pr', mode: incremental ? 'incremental' : 'full',
    targets: incremental ? ['all changes in comparison interval and direct impact'] : full.targets,
    comparison_start: incremental ? previous.request.head_sha : request.comparison_start,
    comparison_end: request.head_sha, inherited_from_run: inherited,
    reason: failed ? 'resume_failed_scope' : 'continue_published_scope', previous_status: previous.status,
    ...(failed ? { pending_scope: scope } : {}),
  };
}

export function validateReviewScope(scope: ReviewScope, request: ReviewRequest): void {
  if (!scope || !['pr', 'thread'].includes(scope.kind)) throw new Error('Invalid review scope kind');
  if (typeof scope.id !== 'string' || !scope.id || !/^[A-Za-z0-9._:-]+$/.test(scope.id)) throw new Error('Invalid review scope id');
  if ((request.source === 'thread') !== (scope.kind === 'thread')) throw new Error('Review scope kind does not match request');
  if (request.source === 'automatic' && (scope.mode !== 'full' || scope.comparison_start !== request.comparison_start)) throw new Error('Automatic audit requires complete PR scope');
  if (!['full', 'incremental', 'focused'].includes(scope.mode)) throw new Error('Invalid review scope mode');
  if (typeof scope.rationale !== 'string' || !scope.rationale.trim()) throw new Error('Invalid review scope rationale');
  if (!Array.isArray(scope.targets) || scope.targets.length < 1 || scope.targets.some((target) => typeof target !== 'string' || !target.trim())) throw new Error('Invalid review scope targets');
  if (!sha.test(scope.comparison_start) || scope.comparison_end !== request.head_sha) throw new Error('Invalid review scope comparison');
  if (scope.inherited_from_run !== null && (typeof scope.inherited_from_run !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(scope.inherited_from_run))) throw new Error('Invalid inherited review run');
  if (typeof scope.explicit_text !== 'string') throw new Error('Invalid explicit review scope');
  if (typeof scope.decided_at !== 'string' || !Number.isFinite(Date.parse(scope.decided_at))) throw new Error('Invalid review scope timestamp');
}

export async function main() {
  const { inventoryDigest, parseReviewCoverage, validateCoverageCompletion } = await import('./review-coverage.ts');
  const output = process.env.REVIEW_COVERAGE_PATH;
  if (!output) throw new Error('Missing REVIEW_COVERAGE_PATH');
  const request = buildReviewRequest({
    source: process.env.REVIEW_TRIGGER_SOURCE,
    commentId: process.env.REVIEW_COMMENT_ID,
    rootCommentId: process.env.REVIEW_COMMENT_ROOT_ID,
    text: process.env.REVIEW_COMMENT_BODY,
    repository: process.env.REVIEW_REPOSITORY ?? '',
    pullNumber: Number(process.env.REVIEW_PULL_NUMBER),
    baseSha: process.env.REVIEW_BASE_SHA ?? '',
    headSha: process.env.REVIEW_HEAD_SHA ?? '',
    comparisonStart: spawnSync('git', ['-C', process.env.REVIEW_TARGET_PATH!, 'merge-base', process.env.REVIEW_BASE_SHA!, process.env.REVIEW_HEAD_SHA!], { encoding: 'utf8' }).stdout.trim(),
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  let previous: ReviewCoverage | null = null;
  const previousPath = process.env.REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH;
  if (previousPath) {
    try {
      previous = parseReviewCoverage(JSON.parse(await readFile(path.join(previousPath, 'review-coverage.json'), 'utf8')));
      if (previous.request.repository !== request.repository || previous.request.pull_number !== request.pull_number
        || previous.request.run_id !== process.env.REVIEW_PREVIOUS_RUN_ID || previous.request.run_attempt !== process.env.REVIEW_PREVIOUS_RUN_ATTEMPT
        || previous.request.source !== process.env.REVIEW_PREVIOUS_SOURCE) throw new Error('Previous coverage does not match selected artifact');
      if (process.env.REVIEW_PREVIOUS_PUBLISHED === 'true') {
        if (previous.status !== 'published') throw new Error('Completion artifact is not published');
        await validateCoverageCompletion(previous, previousPath, inventoryDigest(previous.ledger.map((entry) => entry.path)));
      } else {
        previous = { ...previous, status: previous.scope ? 'draft' : 'requested', complete_audit: false };
      }
    } catch (error) {
      throw new Error(`Previous review request workspace could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const coverage = initialReviewCoverage(request);
  const diff = spawnSync('git', ['-C', process.env.REVIEW_TARGET_PATH!, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', `${request.base_sha}...${request.head_sha}`], { encoding: 'utf8' });
  if (diff.status !== 0) throw new Error('Could not enumerate review changes');
  coverage.ledger = diff.stdout.split('\0').filter(Boolean).map((file) => ({ path: file, status: 'pending', batches: [] }));
  await appendFile(process.env.GITHUB_OUTPUT!, `inventory_digest=${inventoryDigest(coverage.ledger.map((entry) => entry.path))}\ncomparison_start=${request.comparison_start}\n`);
  coverage.default_plan = prepareDefaultReviewPlan(request, previous, (start, end) => comparisonUsable(process.env.REVIEW_TARGET_PATH!, start, end));
  await persistReviewCoverage(output, coverage);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error); process.exitCode = 1; });
