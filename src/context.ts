import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type ReviewContext = {
  root: string;
  baseSha: string;
  headSha: string;
};

export async function prepareContext(cwd: string, baseSha: string, headSha: string, contextRoot?: string): Promise<ReviewContext> {
  await Promise.all([assertCommit(cwd, baseSha), assertCommit(cwd, headSha)]);
  const checkedOutHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  if (checkedOutHead !== headSha) throw new Error(`工作区不是待审 head: ${checkedOutHead}`);
  const root = contextRoot ?? process.env.REVIEW_CONTEXT_PATH ?? `${cwd}/.review`;
  await rm(root, { recursive: true, force: true });
  await mkdir(`${root}/base`, { recursive: true });
  await mkdir(`${root}/policy`, { recursive: true });
  await mkdir(`${root}/results`, { recursive: true });

  const archive = `${root}/base.tar`;
  const diff = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', `${baseSha}...${headSha}`]);
  const changedFiles = await git(cwd, ['diff', '--name-only', `${baseSha}...${headSha}`]);
  await exec('git', ['-C', cwd, 'archive', '--format=tar', `--output=${archive}`, baseSha]);
  await exec('tar', ['-xf', archive, '-C', `${root}/base`]);
  await rm(archive);
  await writeFile(`${root}/pr.diff`, diff);
  await writeFile(`${root}/changed-files.txt`, changedFiles);
  await writeFile(`${root}/metadata.json`, `${JSON.stringify({ baseSha, headSha }, null, 2)}\n`);
  return { root, baseSha, headSha };
}

async function assertCommit(cwd: string, sha: string): Promise<void> {
  await git(cwd, ['cat-file', '-e', `${sha}^{commit}`]);
}

async function git(cwd: string, args: string[], maxBuffer = 128 * 1024 * 1024): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer });
  return stdout;
}
