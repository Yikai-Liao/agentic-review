import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const checkName = 'Agentic Review / audit';
const shaPattern = /^[0-9a-f]{40}$/;

export async function findReviewCheckpoint({
  commits, repository, repositoryId, pullNumber, baseSha, appSlug, token,
  api = 'https://api.github.com', fetchImpl = fetch,
}) {
  for (const commit of commits) {
    const url = new URL(`${api.replace(/\/$/, '')}/repos/${repository}/commits/${commit}/check-runs`);
    url.searchParams.set('check_name', checkName);
    url.searchParams.set('filter', 'all');
    url.searchParams.set('per_page', '100');
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub check lookup failed: ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.check_runs)) throw new Error('Invalid GitHub check response');

    const reviewed = body.check_runs.some((check) => {
      const parts = check.external_id?.split(':');
      return check.name === checkName
        && check.app?.slug === appSlug
        && check.status === 'completed'
        && check.conclusion === 'success'
        && check.head_sha === commit
        && parts?.length === 5
        && parts[0] === repositoryId
        && parts[1] === pullNumber
        && parts[2] === baseSha
        && parts[3] === commit
        && /^[0-9]+$/.test(parts[4]);
    });
    if (reviewed) return commit;
  }
  return null;
}

export async function findReviewCheckpointSafely(options, warn = console.warn) {
  try {
    return await findReviewCheckpoint(options);
  } catch (error) {
    warn(`Review checkpoint lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function main() {
  const {
    REVIEW_TARGET_PATH: targetPath,
    REPOSITORY: repository,
    REPOSITORY_ID: repositoryId,
    PULL_NUMBER: pullNumber,
    BASE_SHA: baseSha,
    HEAD_SHA: headSha,
    REVIEW_APP_SLUG: appSlug,
    GH_TOKEN: token,
    GITHUB_API_URL: api,
    GITHUB_OUTPUT: output,
  } = process.env;
  if (!targetPath || !repository || !repositoryId || !pullNumber || !baseSha || !headSha || !appSlug || !token || !output) {
    throw new Error('Missing review checkpoint environment');
  }
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)
    || !/^[0-9]+$/.test(repositoryId)
    || !/^[0-9]+$/.test(pullNumber)
    || !shaPattern.test(baseSha)
    || !shaPattern.test(headSha)
    || !/^[A-Za-z0-9-]+$/.test(appSlug)) {
    throw new Error('Invalid review checkpoint environment');
  }

  const { stdout: mergeBaseOutput } = await exec('git', ['-C', targetPath, 'merge-base', baseSha, headSha]);
  const mergeBase = mergeBaseOutput.trim();
  if (!shaPattern.test(mergeBase)) throw new Error('Invalid merge base');
  const { stdout } = await exec('git', ['-C', targetPath, 'rev-list', '--topo-order', headSha, `^${mergeBase}`]);
  const commits = stdout.trim() ? stdout.trim().split('\n') : [];
  let checkpoint = await findReviewCheckpointSafely({
    commits,
    repository,
    repositoryId,
    pullNumber,
    baseSha,
    appSlug,
    token,
    api,
  });
  if (checkpoint) {
    const { stdout: merges } = await exec('git', [
      '-C', targetPath, 'rev-list', '--merges', `${checkpoint}..${headSha}`,
    ]);
    if (merges.trim()) checkpoint = null;
  }
  await appendFile(output, `head_sha=${checkpoint ?? ''}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
