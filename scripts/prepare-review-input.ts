import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDiscussion, runGh, type Run } from './refresh-review-discussion.ts';
import { prepareReviewWorkspace } from './prepare-review-workspace.ts';
import { writeReviewInput } from './write-review-input.ts';

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
  const sections: string[] = ['# Review input'];
  const section = (title: string, text: string) => sections.push(`## ${title}\n\n${text}`);
  const associations = JSON.parse(readFileSync(required('REVIEW_ASSOCIATIONS_PATH'), 'utf8'));
  const context = JSON.parse(readFileSync(required('REVIEW_CONTEXT_PATH'), 'utf8'));
  const [metadata, { discussion, baseline }] = await Promise.all([
    run('gh', ['pr', 'view', pull, '--repo', repository, '--json', 'title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,commits']),
    readDiscussion(repository, pull, run),
  ]);
  section('Untrusted PR metadata', metadata);
  section('PR association index', JSON.stringify(associations, null, 2));
  section('Review request', JSON.stringify(context));
  section('Trusted PR discussion snapshot', JSON.stringify(discussion, null, 2));
  const workspace = required('REVIEW_WORKSPACE_PATH');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const thread = discussion.inline_comments.find((comment) => String(comment.id) === context.request.root_comment_id);
  if (context.request.source === 'thread' && (thread?.in_reply_to_id != null || typeof thread?.path !== 'string')) {
    throw new Error('Thread request root is missing from current PR discussion');
  }
  section('Workspace resume manifest', JSON.stringify(prepareReviewWorkspace({
    workspace, context,
    previousPath: env.REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH || env.REVIEW_PREVIOUS_WORKSPACE_PATH,
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
  }), null, 2));
  for (const filename of ['.agentic-review.md', 'AGENTS.md']) {
    for (const [label, directory] of [['Base', base], ['Head', target]]) {
      const source = path.join(directory, filename);
      if (existsSync(source)) section(`${label} ${filename}`, readFileSync(source, 'utf8'));
    }
  }
  writeReviewInput(required('REVIEW_INPUT_PATH'), `${sections.join('\n\n')}\n`);
  writeFileSync(path.join(workspace, 'discussion-baseline.json'), JSON.stringify(baseline), { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
