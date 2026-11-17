import { mkdir } from 'node:fs/promises';
import { runGh, type Run } from './refresh-review-discussion.ts';

// Static review checks out only LFS pointers; no hooks run and no LFS filter downloads objects.
const checkoutOptions = ['-c', 'core.hooksPath=/dev/null',
  '-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false'];

export async function fetchReviewCommits(target: string, commits: string[], run: Run = runGh) {
  const missing: string[] = [];
  for (const sha of new Set(commits)) {
    try {
      await run('git', ['-C', target, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    } catch (error) {
      if ((error as { code?: number }).code !== 1) throw error;
      missing.push(sha);
    }
  }
  if (missing.length) {
    await run('git', ['-C', target, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      'fetch', '--no-tags', 'origin', ...missing]);
  }
}

export async function prepareReviewBase(target: string, base: string, sha: string, run: Run = runGh) {
  await fetchReviewCommits(target, [sha], run);
  // Share the target repository's downloaded Git objects; creating worktrees runs no target repository hooks.
  await run('git', ['-C', target, ...checkoutOptions, 'worktree', 'add', '--detach', base, sha]);
}

export async function checkoutReviewTarget(target: string, repositoryUrl: string, base: string, head: string, run: Run = runGh) {
  await mkdir(target, { recursive: true });
  await run('git', ['-C', target, 'init', '--quiet']);
  await run('git', ['-C', target, 'remote', 'add', 'origin', repositoryUrl]);
  // The pinned SHAs come from the trusted snapshot; fetch only these two versions and their history, never unrelated branches or tags.
  await run('git', ['-C', target, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    'fetch', '--no-tags', 'origin', base, head]);
  await run('git', ['-C', target, ...checkoutOptions, 'checkout', '--detach', head]);
}
