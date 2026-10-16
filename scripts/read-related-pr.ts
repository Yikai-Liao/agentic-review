import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readDiscussion } from './refresh-review-discussion.ts';

// gh pr view --comments 不含行内评论和回复；沿用当前 PR 的完整分页读取。
export function main(
  repository = process.argv[2],
  pull = process.argv[3],
  run = (command: string, args: string[]) =>
    execFileSync(command, args, { encoding: 'utf8', maxBuffer: Infinity }),
) {
  if (!repository || !pull) throw new Error('Usage: read-related-pr.ts <owner/repo> <pull-number>');
  const { discussion } = readDiscussion(repository, pull, run);
  const metadata = JSON.parse(run('gh', ['pr', 'view', pull, '--repo', repository,
    '--json', 'number,title,url,body,state,baseRefName,headRefName,baseRefOid,headRefOid']));
  return JSON.stringify({ repository, number: Number(pull), metadata, ...discussion }, null, 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(main());
