import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inventoryDigest, parseReviewProgress } from './review-coverage.ts';
import { buildReviewRequest, persistReviewCoverage } from './review-request.ts';

// After the agent ends, assemble the pre-sealed context and agent progress into a history record.
// Full coverage is not required: failed or interrupted reviews must still leave a recoverable scope.
export async function main() {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const context = await readFile(required('REVIEW_CONTEXT_PATH'), 'utf8');
  if (createHash('sha256').update(context).digest('hex') !== required('REVIEW_CONTEXT_DIGEST')) {
    throw new Error('Review context does not match the trusted preparation digest');
  }
  // Verify and parse the same bytes so a mutable file is never reread after verification.
  const coverage = parseReviewProgress(JSON.parse(context), JSON.parse(await readFile(required('REVIEW_PROGRESS_PATH'), 'utf8')));
  const request = buildReviewRequest({
    source: required('REVIEW_TRIGGER_SOURCE'),
    commentId: process.env.REVIEW_COMMENT_ID,
    rootCommentId: process.env.REVIEW_COMMENT_ROOT_ID,
    text: process.env.REVIEW_COMMENT_BODY,
    repository: required('REPOSITORY'),
    pullNumber: Number(required('PULL_NUMBER')),
    baseSha: required('BASE_SHA'),
    headSha: required('HEAD_SHA'),
    comparisonStart: required('REVIEW_COMPARISON_START'),
    runId: required('REVIEW_RUN_ID'),
    runAttempt: required('REVIEW_RUN_ATTEMPT'),
    now: coverage.request.requested_at,
  });
  // Both sides come from the trusted workflow; identity fields copied by the model are neither compared nor used.
  if (!isDeepStrictEqual(coverage.request, request)) throw new Error('Sealed review context does not match workflow inputs');
  if (inventoryDigest(coverage.ledger.map((entry) => entry.path)) !== required('REVIEW_INVENTORY_DIGEST')) throw new Error('Coverage does not match trusted change inventory');
  await persistReviewCoverage(required('REVIEW_COVERAGE_PATH'), coverage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
