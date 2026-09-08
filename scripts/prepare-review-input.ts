import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDiscussion } from './refresh-review-discussion.ts';

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
  section('Review request', readFileSync(required('REVIEW_COVERAGE_PATH'), 'utf8'));
  const { discussion, baseline } = readDiscussion(repository, pull, run);
  section('Trusted PR discussion snapshot', JSON.stringify(discussion, null, 2));
  for (const filename of ['.agentic-review.md', 'AGENTS.md']) {
    for (const [label, directory] of [['Base', base], ['Head', target]]) {
      const source = path.join(directory, filename);
      if (existsSync(source)) section(`${label} ${filename}`, readFileSync(source, 'utf8'));
    }
  }
  writeFileSync(required('REVIEW_INPUT_PATH'), `${sections.join('\n\n')}\n`);
  const workspace = required('REVIEW_WORKSPACE_PATH');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(workspace, 'discussion-baseline.json'), JSON.stringify(baseline), { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
