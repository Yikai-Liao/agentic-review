import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDiscussion } from './refresh-review-discussion.ts';

export function selectInputDiff(mode: string, full: string, focus: string): string {
  switch (mode) {
    case 'initial':
    case 'incremental_all': return full;
    case 'incremental': return focus;
    case 'incremental_unchanged': return '';
    default: throw new Error(`Invalid review mode: ${mode}`);
  }
}

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
  const mode = required('REVIEW_MODE');
  const diff = selectInputDiff(mode, required('REVIEW_DIFF_PATH'), required('REVIEW_FOCUS_DIFF_PATH'));
  const sections: string[] = ['# Review input'];
  const section = (title: string, text: string) => sections.push(`## ${title}\n\n${text}`);
  section('Review mode', mode);
  section('Available diff files', `完整 diff：${required('REVIEW_DIFF_PATH')}（始终可读；增量轮按影响面选择读取范围，finding 行号以此为准）。\n本轮直接展开：${diff || '无净代码变化'}。`);
  section('Untrusted PR metadata', run('gh', ['pr', 'view', pull, '--repo', repository, '--json', 'title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,commits']));
  section('Complete changed file list', run('git', ['-C', target, 'diff', '--no-ext-diff', '--no-textconv', '--name-status', '--find-renames', '--find-copies', `${required('REVIEW_BASE_SHA')}...${required('REVIEW_HEAD_SHA')}`]));
  const { discussion, baseline } = readDiscussion(repository, pull, run);
  section('Trusted PR discussion snapshot', JSON.stringify(discussion, null, 2));
  for (const filename of ['.agentic-review.md', 'AGENTS.md']) {
    for (const [label, directory] of [['Base', base], ['Head', target]]) {
      const source = path.join(directory, filename);
      if (existsSync(source)) section(`${label} ${filename}`, readFileSync(source, 'utf8'));
    }
  }
  if (diff) section(mode === 'incremental' ? 'Focus diff' : 'Full diff', readFileSync(diff, 'utf8'));
  writeFileSync(required('REVIEW_INPUT_PATH'), `${sections.join('\n\n')}\n`);
  const workspace = required('REVIEW_WORKSPACE_PATH');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(workspace, 'discussion-baseline.json'), JSON.stringify(baseline), { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
