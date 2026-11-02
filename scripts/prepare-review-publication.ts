import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inventoryDigest, parseReviewProgress } from './review-coverage.ts';
import { buildReviewRequest, persistReviewCoverage } from './review-request.ts';

// Agent 结束后，把预先封存的上下文与 Agent 进度组装为历史记录。
// 不要求完成覆盖：失败或中断的审查也必须留下可恢复范围。
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
  // 校验和解析使用同一份内容，避免校验后重新读取可变文件。
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
  // 两侧都来自可信 workflow，不比较或采用模型复制的身份字段。
  if (!isDeepStrictEqual(coverage.request, request)) throw new Error('Sealed review context does not match workflow inputs');
  if (inventoryDigest(coverage.ledger.map((entry) => entry.path)) !== required('REVIEW_INVENTORY_DIGEST')) throw new Error('Coverage does not match trusted change inventory');
  await persistReviewCoverage(required('REVIEW_COVERAGE_PATH'), coverage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
