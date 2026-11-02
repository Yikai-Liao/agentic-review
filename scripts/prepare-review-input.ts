import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupReviewThreads, readDiscussion, runGh, type DiscussionBaseline, type Run } from './refresh-review-discussion.ts';
import { prepareReviewWorkspace } from './prepare-review-workspace.ts';
import type { ReviewProgress } from './review-request.ts';
import type { ReviewSnapshot } from './resolve-review-snapshot.ts';
import { writeReviewInput, type ReviewMaterial } from './write-review-input.ts';

export async function prepareReviewInput(snapshot: ReviewSnapshot, discussionSnapshot: Awaited<ReturnType<typeof readDiscussion>>, run: Run = runGh) {
  const env = process.env;
  const required = (name: string) => {
    if (!env[name]) throw new Error(`Missing ${name}`);
    return env[name]!;
  };
  const repository = required('REVIEW_REPOSITORY');
  const pull = required('REVIEW_PULL_NUMBER');
  const target = required('REVIEW_TARGET_PATH');
  const base = required('REVIEW_BASE_PATH');
  const materials: ReviewMaterial[] = [];
  const section = (kind: ReviewMaterial['kind'], title: string, content: string,
    use: ReviewMaterial['use'] = 'context', location?: string) => materials.push({ kind, title, content, use, location });
  const associations = JSON.parse(readFileSync(required('REVIEW_ASSOCIATIONS_PATH'), 'utf8'));
  const context = JSON.parse(readFileSync(required('REVIEW_CONTEXT_PATH'), 'utf8'));
  if (snapshot.repository !== repository || snapshot.pullNumber !== pull || snapshot.baseSha !== context.request.base_sha
    || snapshot.headSha !== context.request.head_sha) throw new Error('PR snapshot does not match the review request');
  const { discussion, baseline } = discussionSnapshot;
  const { body, ...metadata } = snapshot.metadata;
  section('request', 'Review request', JSON.stringify(context, null, 2), 'request');
  section('metadata', 'Untrusted PR metadata', JSON.stringify(metadata, null, 2));
  if (typeof body === 'string' && body) section('metadata', 'PR description', body);
  const commits = await run('git', ['-C', target, 'log', '--no-decorate', '--format=fuller',
    `${context.request.comparison_start}..${context.request.head_sha}`, '--']);
  if (commits) section('metadata', 'PR commits', commits, 'reference');
  section('associations', 'PR association index', JSON.stringify(associations, null, 2));
  const workspace = required('REVIEW_WORKSPACE_PATH');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  section('metadata', 'Review runtime paths', JSON.stringify({
    control: fileURLToPath(new URL('../', import.meta.url)), target, base,
  }, null, 2));
  const thread = discussion.inline_comments.find(comment => String(comment.id) === context.request.root_comment_id);
  if (context.request.source === 'thread' && (thread?.in_reply_to_id != null || typeof thread?.path !== 'string')) {
    throw new Error('Thread request root is missing from current PR discussion');
  }
  const previousPath = env.REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH || env.REVIEW_PREVIOUS_WORKSPACE_PATH;
  const manifest = prepareReviewWorkspace({
    workspace, context, previousPath,
    threadPath: context.request.source === 'thread' && typeof thread?.path === 'string' ? thread.path : undefined,
    readChanges: (previousHead, currentHead) => {
      try {
        execFileSync('git', ['-C', target, 'rev-parse', '--verify', '--quiet', `${previousHead}^{commit}`], { stdio: 'pipe' });
      } catch (error) {
        // force-push 可移除历史 head；摘要不可得不改变完整 PR 的审查义务。
        if ((error as { status?: number }).status === 1) return null;
        throw error;
      }
      return execFileSync('git', ['-C', target, '--no-pager', 'diff', '--no-ext-diff', '--no-textconv',
        '--no-renames', '--name-only', '-z', previousHead, currentHead, '--'], { encoding: 'utf8', maxBuffer: Infinity }).split('\0').filter(Boolean);
    },
  });
  section('workspace', 'Workspace resume manifest', JSON.stringify(manifest, null, 2));
  for (const [title, file] of [
    ['Current review notes', manifest.paths.notes],
    ['Current review progress', manifest.paths.progress],
    ['Previous review result', manifest.paths.previous_result],
  ] as const) {
    if (file) section('workspace', title, readFileSync(file, 'utf8'));
  }
  // 审查清单中路径的祖先指令可在启动前确定；后续扩展调查的目录仍按需读取。
  const ruleFiles = new Set(['.agentic-review.md', 'AGENTS.md']);
  const progress: ReviewProgress = JSON.parse(readFileSync(manifest.paths.progress, 'utf8'));
  for (const { path: filename } of progress.ledger) {
    for (let directory = path.posix.dirname(filename); directory !== '.'; directory = path.posix.dirname(directory)) {
      ruleFiles.add(`${directory}/AGENTS.md`);
    }
  }
  for (const filename of ruleFiles) {
    const baseFile = path.join(base, filename);
    const headFile = path.join(target, filename);
    const before = existsSync(baseFile) ? readFileSync(baseFile, 'utf8') : undefined;
    const after = existsSync(headFile) ? readFileSync(headFile, 'utf8') : undefined;
    if (before !== undefined && before !== after) section('rules', `Base ${filename}`, before, 'request');
    if (after !== undefined) section('rules', `${before === after ? 'Base = Head' : 'Head'} ${filename}`, after, 'request');
  }

  // 每个文件、每个实际比较区间是独立材料；大 diff 不挤掉小 patch 或相关讨论。
  // 请求已固定 merge base；统一成两点区间，避免显式请求重复生成相同 full patch。
  const full = `${context.request.comparison_start}..${context.request.head_sha}`;
  const checkpoint = context.request.source === 'automatic' ? env.REVIEW_CHECKPOINT_HEAD : undefined;
  const comparisons = new Map<string, { title: string; use: ReviewMaterial['use'] }>([
    [full, { title: '完整 PR', use: !checkpoint && context.request.source === 'automatic' ? 'changes' : 'reference' }],
  ]);
  if (checkpoint) comparisons.set(`${checkpoint}..${context.request.head_sha}`, { title: '本轮增量', use: 'changes' });
  if (context.request.source === 'pr_comment') {
    for (const range of context.default_plan.ranges) {
      comparisons.set(`${range.comparison_start}..${range.comparison_end}`, { title: '请求区间', use: 'changes' });
    }
  }
  const gitArgs = ['-C', target, '--no-pager', '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
  for (const [range, comparison] of comparisons) {
    const files = (await run('git', [...gitArgs, '--name-only', '-z', range, '--'])).split('\0').filter(Boolean);
    for (const filename of files) {
      const patch = await run('git', [...gitArgs, '--unified=3', range, '--', filename]);
      const use = context.request.source === 'thread' && filename === thread?.path ? 'changes' : comparison.use;
      section('changes', `${comparison.title} ${range}: ${filename}`, patch, use, filename);
    }
  }

  // 变化标记只比较快照，不代表旧记录已经审查或已获确认。
  const previousBaselinePath = previousPath && path.join(previousPath, 'discussion-baseline.json');
  const previous: DiscussionBaseline | undefined = previousBaselinePath && existsSync(previousBaselinePath)
    ? JSON.parse(readFileSync(previousBaselinePath, 'utf8')) : undefined;
  const unchanged = (kind: keyof typeof discussion, id: string | number) =>
    previous?.fingerprints[kind]?.[id] === baseline.fingerprints[kind][id];
  const commentText = (record: typeof discussion.inline_comments[number]) => {
    const { body, ...identity } = record;
    return `## Comment ${record.id}\n\n\`\`\`json\n${JSON.stringify(identity, null, 2)}\n\`\`\`\n\n${body}`;
  };
  for (const { root_comment_id: root, state, comments } of groupReviewThreads(discussion)) {
    const current = comments.some(comment => !unchanged('inline_comments', comment.id)) || (state && !unchanged('threads', state.id));
    const use = root === context.request.root_comment_id ? 'request' : current ? 'discussion' : 'reference';
    const location = comments.find(comment => String(comment.id) === root)?.path;
    section('discussion', `Review thread ${root}`, [`Thread state: ${JSON.stringify(state ?? null)}`, ...comments.map(commentText)].join('\n\n'), use,
      typeof location === 'string' ? location : undefined);
  }
  for (const kind of ['issue_comments', 'reviews'] as const) {
    for (const record of discussion[kind]) {
      section('discussion', `${kind} ${record.id}`, commentText(record), unchanged(kind, record.id) ? 'reference' : 'discussion');
    }
  }
  writeReviewInput(required('REVIEW_INPUT_PATH'), materials);
  // 刷新时按 ID 合并启动原文与增量，直接交付完整的变化 thread；不新增消费游标。
  writeFileSync(`${required('REVIEW_INPUT_PATH')}.discussion.json`, JSON.stringify({
    inline_comments: discussion.inline_comments, threads: discussion.threads,
  }), { mode: 0o600 });
  writeFileSync(path.join(workspace, 'discussion-baseline.json'), JSON.stringify(baseline), { mode: 0o600 });
}
