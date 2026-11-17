import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupReviewThreads, readDiscussion, runGh, type DiscussionBaseline, type Run } from './refresh-review-discussion.ts';
import type { SourceAttribution } from './attribute-review-sources.ts';
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
  // Source-reviewed files are reflected in the ledger; request material does not list them again.
  const { source_reviewed: _sourceReviewed, ...requestContext } = context;
  section('request', 'Review request', JSON.stringify(requestContext, null, 2), 'request');
  section('metadata', 'Untrusted PR metadata', JSON.stringify(metadata, null, 2));
  if (typeof body === 'string' && body) section('metadata', 'PR description', body);
  const commits = await run('git', ['-C', target, 'log', '--no-decorate', '--format=fuller',
    `${context.request.comparison_start}..${context.request.head_sha}`, '--']);
  if (commits) section('metadata', 'PR commits', commits, 'reference');
  section('associations', 'PR association index', JSON.stringify(associations, null, 2));
  const attribution: SourceAttribution = JSON.parse(readFileSync(required('REVIEW_ATTRIBUTION_PATH'), 'utf8'));
  if (attribution.pull_requests.length) {
    // Files from reviewed source PRs are not reviewed one by one; files whose stacked content differs from the source head need composition checks.
    section('associations', 'Source review attribution', JSON.stringify({
      source_reviewed_files: context.source_reviewed.length,
      reviewed_pull_requests: attribution.pull_requests,
      composition_files: attribution.composition,
    }, null, 2));
  }
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
        // A force-push can remove the earlier head; an unavailable summary does not change whole-PR review obligations.
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
  // Ancestor instructions of listed paths are known before startup; directories reached later are still read on demand.
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

  // Each file and each actual comparison range is separate material, so a large diff never crowds out small patches or related discussion.
  // The request already pins the merge base; use two-dot ranges so explicit requests never regenerate the same full patch.
  const full = `${context.request.comparison_start}..${context.request.head_sha}`;
  const checkpoint = context.request.source === 'automatic' ? env.REVIEW_CHECKPOINT_HEAD : undefined;
  const comparisons = new Map<string, { title: string; use: ReviewMaterial['use'] }>([
    [full, { title: 'Whole PR', use: !checkpoint && context.request.source === 'automatic' ? 'changes' : 'reference' }],
  ]);
  if (checkpoint) comparisons.set(`${checkpoint}..${context.request.head_sha}`, { title: 'This round\'s increment', use: 'changes' });
  if (context.request.source === 'pr_comment') {
    for (const range of context.default_plan.ranges) {
      comparisons.set(`${range.comparison_start}..${range.comparison_end}`, { title: 'Requested range', use: 'changes' });
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

  // Change markers only compare snapshots; they do not mean old records were reviewed or confirmed.
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
  // Refresh merges startup text and increments by ID and delivers complete changed threads, with no consumption cursor.
  writeFileSync(`${required('REVIEW_INPUT_PATH')}.discussion.json`, JSON.stringify({
    inline_comments: discussion.inline_comments, threads: discussion.threads,
  }), { mode: 0o600 });
  writeFileSync(path.join(workspace, 'discussion-baseline.json'), JSON.stringify(baseline), { mode: 0o600 });
}
