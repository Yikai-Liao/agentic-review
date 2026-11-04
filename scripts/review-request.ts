import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { SourceAttribution } from './attribute-review-sources.ts';
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

export type ReviewRange = {
  targets: string[];
  comparison_start: string;
  comparison_end: string;
};

export type ReviewScope = {
  kind: 'pr' | 'thread';
  mode: 'full' | 'incremental' | 'focused';
  rationale: string;
  explicit_text: string;
  ranges: ReviewRange[];
};

export type ReviewScopeDecision = Omit<ReviewScope, 'kind'>;

export type ReviewCoverage = {
  request: ReviewRequest;
  scope?: ReviewScope;
  default_plan?: DefaultReviewPlan;
  status: 'requested' | 'draft' | 'published' | 'failed';
  ledger: CoverageEntry[];
  complete_audit: boolean;
  updated_at: string;
};

// Agent 只提交判断和进度；请求身份与默认计划由准备阶段单独封存。
export type ReviewContext = Pick<ReviewCoverage, 'request' | 'default_plan'> & { source_reviewed: string[] };
export type ReviewProgress = { scope?: ReviewScopeDecision; ledger: CoverageEntry[] };

export type DefaultReviewPlan = {
  kind: 'pr' | 'thread';
  mode: 'full' | 'incremental' | 'focused';
  ranges: ReviewRange[];
  inherited_from_run: string | null;
  reason: 'thread_default' | 'no_history' | 'reopen_unchanged_scope' | 'resume_failed_scope' | 'continue_published_scope';
  previous_status: ReviewCoverage['status'] | null;
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

export async function persistReviewProgress(file: string, progress: ReviewProgress): Promise<void> {
  if (!path.isAbsolute(file)) throw new Error('Review progress path must be absolute');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(progress)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function initialReviewCoverage(request: ReviewRequest): ReviewCoverage {
  return { request, status: 'requested', ledger: [], complete_audit: false, updated_at: request.requested_at };
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
  const range = (targets: string[], start = request.comparison_start): ReviewRange => ({
    targets, comparison_start: start, comparison_end: request.head_sha,
  });
  if (request.source === 'thread') return {
    kind: 'thread', mode: 'focused', ranges: [range(['current thread and direct impact'])],
    inherited_from_run: null, reason: 'thread_default', previous_status: null,
  };
  const full: DefaultReviewPlan = {
    kind: 'pr', mode: 'full', ranges: [range(['complete pull request'])],
    inherited_from_run: null, reason: 'no_history', previous_status: null,
  };
  if (request.source === 'automatic') return full;
  // 未记录实际范围就失败时，默认计划本身仍是尚未完成的义务。
  const scope = previous?.scope ?? previous?.default_plan;
  if (!previous || !scope || scope.kind !== 'pr' || previous.request.repository !== request.repository
    || previous.request.pull_number !== request.pull_number) return full;
  if (scope.ranges.some((item) => !usable(item.comparison_start, item.comparison_end))) {
    throw new Error('Previous review comparison is unavailable');
  }
  const inherited = `${previous.request.run_id}:${previous.request.run_attempt}`;
  if (previous.request.head_sha === request.head_sha && previous.request.base_sha === request.base_sha) return {
    kind: 'pr', mode: scope.mode, ranges: structuredClone(scope.ranges), inherited_from_run: inherited,
    reason: 'reopen_unchanged_scope', previous_status: previous.status,
  };
  // 部分发布的旧范围仍有未审文件，与失败一样保留为本轮义务。
  const failed = previous.status !== 'published' || previous.ledger.some((entry) => entry.status === 'pending');
  const incremental = previous.request.base_sha === request.base_sha && usable(previous.request.head_sha, request.head_sha);
  const current = incremental
    ? range(['all changes in comparison interval and direct impact'], previous.request.head_sha)
    : full.ranges[0];
  return {
    kind: 'pr', mode: incremental ? 'incremental' : 'full',
    ranges: [...(failed ? structuredClone(scope.ranges) : []), current],
    inherited_from_run: inherited,
    reason: failed ? 'resume_failed_scope' : 'continue_published_scope', previous_status: previous.status,
  };
}

export function validateReviewRanges(ranges: ReviewRange[]): void {
  if (!Array.isArray(ranges) || !ranges.length) throw new Error('Invalid review ranges');
  for (const item of ranges) {
    if (!item || !Array.isArray(item.targets) || !item.targets.length
      || item.targets.some((target) => typeof target !== 'string' || !target.trim())) throw new Error('Invalid review scope targets');
    if (typeof item.comparison_start !== 'string' || !sha.test(item.comparison_start)
      || typeof item.comparison_end !== 'string' || !sha.test(item.comparison_end)) throw new Error('Invalid review scope comparison');
  }
}

export function reviewInventory(targetPath: string, request: ReviewRequest, plan: DefaultReviewPlan): string[] {
  // 完整 PR 保留显式扩大范围的入口；所有历史区间独立枚举，撤销不能抵消待审文件。
  const files = new Set<string>();
  const intervals = new Set([request.comparison_start + '..' + request.head_sha,
    ...plan.ranges.map((item) => item.comparison_start + '..' + item.comparison_end)]);
  for (const interval of intervals) {
    const diff = spawnSync('git', ['-C', targetPath, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', interval], { encoding: 'utf8' });
    if (diff.status !== 0) throw new Error('Could not enumerate review changes');
    diff.stdout.split('\0').filter(Boolean).forEach((file) => files.add(file));
  }
  return [...files].sort();
}

export function validateReviewScope(scope: ReviewScope, request: ReviewRequest): void {
  if (!scope || !['pr', 'thread'].includes(scope.kind)) throw new Error('Invalid review scope kind');
  if ((request.source === 'thread') !== (scope.kind === 'thread')) throw new Error('Review scope kind does not match request');
  validateReviewRanges(scope.ranges);
  if (!scope.ranges.some((item) => item.comparison_end === request.head_sha)) throw new Error('Review scope does not include current snapshot');
  if (request.source === 'automatic' && (scope.mode !== 'full' || scope.ranges.length !== 1 || scope.ranges[0].comparison_start !== request.comparison_start)) throw new Error('Automatic audit requires complete PR scope');
  if (!['full', 'incremental', 'focused'].includes(scope.mode)) throw new Error('Invalid review scope mode');
  if (typeof scope.rationale !== 'string' || !scope.rationale.trim()) throw new Error('Invalid review scope rationale');
  if (typeof scope.explicit_text !== 'string') throw new Error('Invalid explicit review scope');
}

export async function main() {
  const { inventoryDigest, parseReviewCoverage, pendingCoverage } = await import('./review-coverage.ts');
  const contextPath = process.env.REVIEW_CONTEXT_PATH;
  const progressPath = process.env.REVIEW_PROGRESS_PATH;
  if (!contextPath || !path.isAbsolute(contextPath) || !progressPath) throw new Error('Missing review context or progress path');
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
        // 已发布工作稿可能是时间预算内的部分结论；这里只核对其结构，未审文件由默认计划继续承接。
        pendingCoverage(previous, inventoryDigest(previous.ledger.map((entry) => entry.path)));
      } else {
        previous = { ...previous, status: previous.scope ? 'draft' : 'requested', complete_audit: false };
      }
    } catch (error) {
      throw new Error(`Previous review request workspace could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const coverage = initialReviewCoverage(request);
  coverage.default_plan = prepareDefaultReviewPlan(request, previous, (start, end) => comparisonUsable(process.env.REVIEW_TARGET_PATH!, start, end));
  // 来源 PR 已审且合入内容与其 head 一致的文件，直接记为来源已审；其余文件待审。
  const attribution = JSON.parse(await readFile(process.env.REVIEW_ATTRIBUTION_PATH!, 'utf8')) as SourceAttribution;
  const sourceReviewed = new Set(attribution.reviewed);
  coverage.ledger = reviewInventory(process.env.REVIEW_TARGET_PATH!, request, coverage.default_plan)
    .map((file) => ({ path: file, status: sourceReviewed.has(file) ? 'source_reviewed' : 'pending' }));
  const context: ReviewContext = {
    request, default_plan: coverage.default_plan,
    source_reviewed: coverage.ledger.filter((entry) => entry.status === 'source_reviewed').map((entry) => entry.path).sort(),
  };
  const contextText = `${JSON.stringify(context)}\n`;
  await mkdir(path.dirname(contextPath), { recursive: true, mode: 0o700 });
  await writeFile(contextPath, contextText, { encoding: 'utf8', mode: 0o400, flag: 'wx' });
  await persistReviewProgress(progressPath, { ledger: coverage.ledger, scope: {
    mode: coverage.default_plan.mode, ranges: coverage.default_plan.ranges,
    rationale: '采用默认审查计划；显式请求改变范围时由 Agent 调整。', explicit_text: '',
  } });
  // Runner 在本步骤结束时保存摘要；后续 Agent 对本地文件的修改不能改写该步骤输出。
  await appendFile(process.env.GITHUB_OUTPUT!, `inventory_digest=${inventoryDigest(coverage.ledger.map((entry) => entry.path))}\ncomparison_start=${request.comparison_start}\ncontext_digest=${createHash('sha256').update(contextText).digest('hex')}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error); process.exitCode = 1; });
