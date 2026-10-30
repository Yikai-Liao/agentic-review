import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
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

  const sameSnapshot = previous?.request.base_sha === context.request.base_sha
    && previous?.request.head_sha === context.request.head_sha;
  const sameScope = previous?.scope?.mode === progress.scope?.mode
    && isDeepStrictEqual(previous?.scope?.ranges, progress.scope?.ranges);
  const repeatPrScope = context.request.source === 'pr_comment';
  const changedPaths = previous && !sameSnapshot
    ? readChanges?.(previous.request.head_sha, context.request.head_sha) ?? null
    : previous ? [] : null;
  const batches: Array<{ id: string; path: string; pending_file_count: number; directly_changed_files: string[] | null }> = [];
  if (previous && previousPath) {
    const batchDirectory = path.join(previousPath, 'batches');
    if (existsSync(batchDirectory)) {
      mkdirSync(path.join(workspace, 'batches'), { recursive: true, mode: 0o700 });
      for (const name of readdirSync(batchDirectory).sort()) {
        const source = realpathSync(path.join(batchDirectory, name));
        if (!/^[A-Za-z0-9_-]+\.md$/.test(name) || !source.startsWith(`${realpathSync(previousPath)}${path.sep}`)
          || !statSync(source).isFile()) throw new Error('Invalid previous batch file');
        const destination = path.join(workspace, 'batches', name);
        writeFileSync(destination, readFileSync(source), { mode: 0o600 });
        batches.push({ id: name.slice(0, -3), path: destination, pending_file_count: 0, directly_changed_files: null });
      }
    }
    const previousEntries = new Map(previous.ledger.map((entry) => [entry.path, entry]));
    for (const entry of progress.ledger) {
      const old = previousEntries.get(entry.path);
      if (!old) continue;
      entry.batches = [...old.batches];
      // 新快照可能改变未修改文件的调用方或契约，不能只看文件 diff 自动确认继承。
      if (sameSnapshot && entry.path !== threadPath) {
        if (old.status === 'complete' && !repeatPrScope) {
          if (!old.batches.length || old.batches.some((id) => !batches.some((batch) => batch.id === id)
            || !readFileSync(path.join(workspace, 'batches', `${id}.md`), 'utf8').trim())) throw new Error('Missing inherited batch evidence');
          entry.status = 'complete';
        } else if (old.status === 'out_of_scope' && sameScope && progress.scope?.mode !== 'full') {
          entry.status = 'out_of_scope';
        }
      }
    }
    for (const batch of batches) {
      const files = new Set(previous.ledger.filter((entry) => entry.batches.includes(batch.id)).map((entry) => entry.path));
      batch.pending_file_count = progress.ledger.filter((entry) => entry.status === 'pending' && entry.batches.includes(batch.id)).length;
      batch.directly_changed_files = changedPaths?.filter((file) => files.has(file)) ?? null;
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
    same_base: previous ? previous.request.base_sha === context.request.base_sha : null,
    changed_paths: changedPaths,
    paths: {
      workspace,
      notes: notesPath,
      progress: progressPath,
      previous_result: existsSync(path.join(workspace, 'previous-review-result.json')) ? path.join(workspace, 'previous-review-result.json') : null,
      result: path.join(workspace, 'review-result.json'),
    },
    batches,
    pending_files: progress.ledger.filter((entry) => entry.status === 'pending').map((entry) => entry.path),
  };
  writeFileSync(path.join(workspace, 'resume-manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return manifest;
}
