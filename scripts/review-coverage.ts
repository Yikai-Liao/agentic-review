import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildReviewRequest, validateReviewScope, validateReviewRanges, type ReviewCoverage } from './review-request.ts';

export type CoverageEntry = { path: string; status: 'pending' | 'complete' | 'out_of_scope' };
const record = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
const relative = (value: string) => value.length > 0 && !path.posix.isAbsolute(value) && !value.split('/').some((part) => part === '..' || part === '.');

export function inventoryDigest(files: string[]): string {
  return createHash('sha256').update(JSON.stringify([...files].sort())).digest('hex');
}

export function parseReviewCoverage(value: unknown): ReviewCoverage {
  if (!record(value) || !record(value.request)) throw new Error('Invalid review coverage');
  const r = value.request;
  if (!['automatic', 'pr_comment', 'thread'].includes(r.source) || r.version !== 1
    || typeof r.text !== 'string' || typeof r.requested_at !== 'string' || !Number.isFinite(Date.parse(r.requested_at))
    || (r.source === 'automatic' ? r.comment_id !== null || r.root_comment_id !== null
      : typeof r.comment_id !== 'string' || !/^\d+$/.test(r.comment_id)
        || (r.source === 'thread' ? typeof r.root_comment_id !== 'string' || !/^\d+$/.test(r.root_comment_id) : r.root_comment_id !== r.comment_id))) throw new Error('Invalid coverage request');
  if (['repository', 'base_sha', 'head_sha', 'comparison_start', 'run_id', 'run_attempt'].some((field) => typeof r[field] !== 'string')) throw new Error('Invalid coverage request fields');
  const rebuilt = buildReviewRequest({ source: r.source, commentId: r.comment_id, rootCommentId: r.root_comment_id, text: r.text, repository: r.repository, pullNumber: r.pull_number, baseSha: r.base_sha, headSha: r.head_sha, comparisonStart: r.comparison_start, runId: r.run_id, runAttempt: r.run_attempt, now: r.requested_at });
  if (Object.keys(r).length !== Object.keys(rebuilt).length || Object.entries(rebuilt).some(([key, item]) => r[key] !== item)) throw new Error('Invalid coverage request');
  if (!['requested', 'draft', 'published', 'failed'].includes(value.status) || typeof value.complete_audit !== 'boolean'
    || typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))) throw new Error('Invalid coverage state');
  if (value.default_plan !== undefined) {
    const plan = value.default_plan;
    if (!record(plan) || !['pr', 'thread'].includes(plan.kind) || !['full', 'incremental', 'focused'].includes(plan.mode)
      || !['thread_default', 'no_history', 'reopen_unchanged_scope', 'resume_failed_scope', 'continue_published_scope'].includes(plan.reason)
      || (plan.previous_status !== null && !['requested', 'draft', 'published', 'failed'].includes(plan.previous_status))
      || (plan.inherited_from_run !== null && (typeof plan.inherited_from_run !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(plan.inherited_from_run)))) throw new Error('Invalid default review plan');
    validateReviewRanges(plan.ranges);
  }
  if (value.scope !== undefined) validateReviewScope(value.scope, rebuilt);
  if ((value.status === 'draft' || value.status === 'published') && !value.scope) throw new Error('Missing coverage scope');
  if (value.complete_audit && (value.status !== 'published' || r.source !== 'automatic' || value.scope?.mode !== 'full')) throw new Error('Invalid complete audit');
  if (!Array.isArray(value.ledger) || value.ledger.some((entry: unknown) => !record(entry) || typeof entry.path !== 'string' || !relative(entry.path)
    || !['pending', 'complete', 'out_of_scope'].includes(entry.status))) throw new Error('Invalid coverage ledger');
  if (new Set(value.ledger.map((entry: CoverageEntry) => entry.path)).size !== value.ledger.length) throw new Error('Duplicate coverage path');
  const coverage: ReviewCoverage = {
    request: rebuilt, status: value.status, complete_audit: value.complete_audit, updated_at: value.updated_at,
    ledger: value.ledger.map((entry: CoverageEntry) => ({ path: entry.path, status: entry.status })),
  };
  if (value.scope !== undefined) coverage.scope = value.scope;
  if (value.default_plan !== undefined) coverage.default_plan = value.default_plan;
  return coverage;
}

// 合并的历史记录由代码生成，模型可写文件不含 request、默认计划或发布状态。
export async function readReviewProgress(contextPath: string, progressPath: string): Promise<ReviewCoverage> {
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  const progress = JSON.parse(await readFile(progressPath, 'utf8'));
  return parseReviewProgress(context, progress);
}

export function parseReviewProgress(context: unknown, progress: unknown): ReviewCoverage {
  if (!record(context) || !record(context.request) || !record(progress)
    || Object.keys(progress).some((key) => !['scope', 'ledger'].includes(key))) throw new Error('Invalid review progress fields');
  if (progress.scope !== undefined && (!record(progress.scope)
    || Object.keys(progress.scope).sort().join(',') !== 'explicit_text,mode,ranges,rationale')) throw new Error('Invalid review scope decision fields');
  const scope = progress.scope === undefined ? undefined : {
    ...progress.scope,
    kind: context.request.source === 'thread' ? 'thread' : 'pr',
  };
  return parseReviewCoverage({
    request: context.request,
    default_plan: context.default_plan,
    scope,
    ledger: progress.ledger,
    status: progress.scope ? 'draft' : 'requested',
    complete_audit: false,
    updated_at: new Date().toISOString(),
  });
}

export async function validateCoverageCompletion(coverage: ReviewCoverage, expectedDigest: string): Promise<void> {
  parseReviewCoverage(coverage);
  if (!coverage.scope || !['draft', 'published'].includes(coverage.status)) throw new Error('Review coverage is not ready for publication');
  if (!/^[0-9a-f]{64}$/.test(expectedDigest) || inventoryDigest(coverage.ledger.map((entry) => entry.path)) !== expectedDigest) throw new Error('Coverage does not match trusted change inventory');
  for (const entry of coverage.ledger) {
    if (entry.status === 'out_of_scope' && coverage.scope.mode !== 'full') continue;
    if (entry.status !== 'complete') throw new Error(`Incomplete coverage: ${entry.path}`);
  }
}

export function validateAuditCheckpoint(coverage: ReviewCoverage, expected: { repository: string; pullNumber: number; base: string; head: string; run: string; attempt: string }): void {
  parseReviewCoverage(coverage);
  const r = coverage.request;
  if (!coverage.complete_audit || coverage.status !== 'published' || r.repository !== expected.repository
    || r.pull_number !== expected.pullNumber || r.base_sha !== expected.base || r.head_sha !== expected.head
    || r.run_id !== expected.run || r.run_attempt !== expected.attempt) throw new Error('Workspace is not the selected completed audit checkpoint');
}

async function main() {
  const workspace = process.env.PREVIOUS_WORKSPACE_PATH!;
  const coverage = parseReviewCoverage(JSON.parse(await readFile(path.join(workspace, 'review-coverage.json'), 'utf8')));
  validateAuditCheckpoint(coverage, { repository: process.env.REPOSITORY!, pullNumber: Number(process.env.PULL_NUMBER), base: process.env.CHECKPOINT_BASE!, head: process.env.CHECKPOINT_HEAD!, run: process.env.CHECKPOINT_RUN!, attempt: process.env.CHECKPOINT_ATTEMPT! });
  await validateCoverageCompletion(coverage, inventoryDigest(coverage.ledger.map((entry) => entry.path)));
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error); process.exitCode = 1; });
