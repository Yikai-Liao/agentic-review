import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseReviewCoverage } from './review-coverage.ts';
import type { ReviewContext, ReviewProgress } from './review-request.ts';

// 启动前迁移证据和可确定的进度；自然语言范围、跨文件影响与讨论反证仍由 Agent 判断。
export function prepareReviewWorkspace({ workspace, context, previousPath, threadPath, readChanges }: {
  workspace: string;
  context: ReviewContext;
  previousPath?: string;
  threadPath?: string;
  readChanges?: (previousHead: string, currentHead: string) => string[] | null;
}) {
  const progressPath = path.join(workspace, 'review-progress.json');
  const progress: ReviewProgress = JSON.parse(readFileSync(progressPath, 'utf8'));
  const previous = previousPath
    ? parseReviewCoverage(JSON.parse(readFileSync(path.join(previousPath, 'review-coverage.json'), 'utf8')))
    : null;
  if (previous && (previous.request.repository !== context.request.repository
    || previous.request.pull_number !== context.request.pull_number)) throw new Error('Previous workspace belongs to another PR');

  const sameBase = previous?.request.base_sha === context.request.base_sha;
  const sameSnapshot = sameBase
    && previous?.request.head_sha === context.request.head_sha;
  const sameScope = previous?.scope?.mode === progress.scope?.mode
    && isDeepStrictEqual(previous?.scope?.ranges, progress.scope?.ranges);
  const repeatPrScope = context.request.source === 'pr_comment';
  const changedPaths = previous && !sameSnapshot
    ? readChanges?.(previous.request.head_sha, context.request.head_sha) ?? null
    : previous ? [] : null;
  const changed = new Set(changedPaths ?? []);
  // 可信完整 audit 的未改完成项默认延续；Agent 沿新变化和讨论重开间接受影响的项。
  const continueAudit = context.request.source === 'automatic' && previous?.complete_audit
    && sameBase && changedPaths !== null;
  if (previous && previousPath) {
    const previousEntries = new Map(previous.ledger.map((entry) => [entry.path, entry]));
    for (const entry of progress.ledger) {
      const old = previousEntries.get(entry.path);
      if (!old || entry.path === threadPath) continue;
      if (old.status === 'complete' && !repeatPrScope
        && (sameSnapshot || (continueAudit && !changed.has(entry.path)))) {
        entry.status = 'complete';
      } else if (sameSnapshot && old.status === 'out_of_scope' && sameScope && progress.scope?.mode !== 'full') {
        entry.status = 'out_of_scope';
      }
    }
    const oldNotes = path.join(previousPath, 'notes.md');
    if (existsSync(oldNotes)) {
      writeFileSync(path.join(workspace, 'notes.md'), readFileSync(oldNotes), { mode: 0o600 });
    }
    const oldResult = path.join(previousPath, 'review-result.json');
    if (existsSync(oldResult)) writeFileSync(path.join(workspace, 'previous-review-result.json'), readFileSync(oldResult), { mode: 0o600 });
  }
  const notesPath = path.join(workspace, 'notes.md');
  if (!existsSync(notesPath)) {
    // 固定事实由准备阶段记录；Agent 只需补充层级、调查证据和判断。
    const entry = fileURLToPath(new URL('../central/review-rules.md', import.meta.url));
    const { text, ...identity } = context.request;
    const facts = { request: identity, context_path: '$REVIEW_CONTEXT_PATH', rules_path: entry, progress_path: progressPath };
    writeFileSync(notesPath, `# Review 调查索引\n\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\`\n\n## 调查记录\n`, { mode: 0o600 });
  }
  writeFileSync(progressPath, `${JSON.stringify(progress)}\n`, { mode: 0o600 });
  const manifest = {
    request: context.request,
    inherited_from_run: previous ? `${previous.request.run_id}:${previous.request.run_attempt}` : null,
    same_snapshot: Boolean(sameSnapshot),
    same_base: previous ? sameBase : null,
    changed_paths: changedPaths,
    paths: {
      workspace,
      notes: notesPath,
      progress: progressPath,
      previous_result: existsSync(path.join(workspace, 'previous-review-result.json')) ? path.join(workspace, 'previous-review-result.json') : null,
      result: path.join(workspace, 'review-result.json'),
    },
    pending_files: progress.ledger.filter((entry) => entry.status === 'pending').map((entry) => entry.path),
  };
  writeFileSync(path.join(workspace, 'resume-manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return manifest;
}
