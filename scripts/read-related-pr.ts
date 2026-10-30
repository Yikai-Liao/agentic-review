import { pathToFileURL } from 'node:url';
import { readDiscussion, runGh, type Run } from './refresh-review-discussion.ts';

// gh pr view --comments 不含行内评论和回复；沿用当前 PR 的完整分页读取。
export async function main(
  repository = process.argv[2],
  pull = process.argv[3],
  run: Run = runGh,
) {
  if (!repository || !pull) throw new Error('Usage: read-related-pr.ts <owner/repo> <pull-number>');
  const { discussion } = await readDiscussion(repository, pull, run);
  const metadata = JSON.parse(await run('gh', ['pr', 'view', pull, '--repo', repository,
    '--json', 'number,title,url,body,state,baseRefName,headRefName,baseRefOid,headRefOid']));
  return JSON.stringify({ repository, number: Number(pull), metadata, ...discussion }, null, 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
}
