import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDiscussion } from './refresh-review-discussion.ts';
import { prepareReviewWorkspace } from './prepare-review-workspace.ts';

export function main(run = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: Infinity })) {
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
  section('Untrusted PR metadata', run('gh', ['pr', 'view', pull, '--repo', repository, '--json', 'title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,commits']));
  const associations = JSON.parse(readFileSync(required('REVIEW_ASSOCIATIONS_PATH'), 'utf8'));
  section('PR association index', JSON.stringify(associations, null, 2));
  const context = JSON.parse(readFileSync(required('REVIEW_CONTEXT_PATH'), 'utf8'));
  section('Review request', JSON.stringify(context));
  const { discussion, baseline } = readDiscussion(repository, pull, run);
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
  }), null, 2));
  for (const filename of ['.agentic-review.md', 'AGENTS.md']) {
    for (const [label, directory] of [['Base', base], ['Head', target]]) {
      const source = path.join(directory, filename);
      if (existsSync(source)) section(`${label} ${filename}`, readFileSync(source, 'utf8'));
    }
  }
  writeFileSync(required('REVIEW_INPUT_PATH'), `${sections.join('\n\n')}\n`);
  writeFileSync(path.join(workspace, 'discussion-baseline.json'), JSON.stringify(baseline), { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
