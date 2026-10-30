import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDiscussion, runGh, type DiscussionBaseline, type Run } from './refresh-review-discussion.ts';
import { prepareReviewWorkspace } from './prepare-review-workspace.ts';
import { writeReviewInput, type ReviewMaterial } from './write-review-input.ts';

export async function main(run: Run = runGh) {
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
  const [metadataText, { discussion, baseline }] = await Promise.all([
    run('gh', ['pr', 'view', pull, '--repo', repository, '--json', 'title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,commits']),
    readDiscussion(repository, pull, run),
  ]);
  const { body, commits, ...metadata } = JSON.parse(metadataText);
  section('request', 'Review request', JSON.stringify(context, null, 2), 'request');
  section('metadata', 'Untrusted PR metadata', JSON.stringify(metadata, null, 2));
  if (body) section('metadata', 'PR description', body);
  if (commits) section('metadata', 'PR commits', JSON.stringify(commits, null, 2), 'reference');
  section('associations', 'PR association index', JSON.stringify(associations, null, 2));
  const workspace = required('REVIEW_WORKSPACE_PATH');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
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
  for (const filename of ['.agentic-review.md', 'AGENTS.md']) {
    const baseFile = path.join(base, filename);
    const headFile = path.join(target, filename);
    const before = existsSync(baseFile) ? readFileSync(baseFile, 'utf8') : undefined;
    const after = existsSync(headFile) ? readFileSync(headFile, 'utf8') : undefined;
    if (before !== undefined && before !== after) section('rules', `Base ${filename}`, before, 'request');
    if (after !== undefined) section('rules', `${before === after ? 'Base = Head' : 'Head'} ${filename}`, after, 'request');
  }

  // 每个文件、每个实际比较区间是独立材料；大 diff 不挤掉小 patch 或相关讨论。
  const full = `${context.request.base_sha}...${context.request.head_sha}`;
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
  const threads = new Map(discussion.threads.map(state => [String(state.root_comment_id), state]));
  // REST 评论与 GraphQL thread 分别读取；即使暂时只有状态，也保留其原始入口。
  const groups = new Map<string, typeof discussion.inline_comments>([...threads.keys()].map(root => [root, []]));
  for (const comment of discussion.inline_comments) {
    const root = String(comment.in_reply_to_id ?? comment.id);
    const comments = groups.get(root) ?? [];
    comments.push(comment);
    groups.set(root, comments);
  }
  const commentText = (record: typeof discussion.inline_comments[number]) => {
    const { body, ...identity } = record;
    return `## Comment ${record.id}\n\n\`\`\`json\n${JSON.stringify(identity, null, 2)}\n\`\`\`\n\n${body}`;
  };
  for (const [root, comments] of groups) {
    const state = threads.get(root);
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
  writeFileSync(path.join(workspace, 'discussion-baseline.json'), JSON.stringify(baseline), { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
