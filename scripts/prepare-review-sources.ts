import { mkdir } from 'node:fs/promises';
import { runGh, type Run } from './refresh-review-discussion.ts';

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
  // 共用目标仓库已下载的 Git 对象；创建工作树时不执行目标仓库 hook。
  await run('git', ['-C', target, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', base, sha]);
}

export async function checkoutReviewTarget(target: string, repositoryUrl: string, base: string, head: string, run: Run = runGh) {
  await mkdir(target, { recursive: true });
  await run('git', ['-C', target, 'init', '--quiet']);
  await run('git', ['-C', target, 'remote', 'add', 'origin', repositoryUrl]);
  // 固定 SHA 已由可信快照解析；只下载这两个版本及其历史，不拉取无关分支与 tag。
  await run('git', ['-C', target, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    'fetch', '--no-tags', 'origin', base, head]);
  await run('git', ['-C', target, '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', head]);
}
