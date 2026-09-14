import { appendFile } from 'node:fs/promises';

export async function resolveReviewSnapshot(options: {
  repository: string;
  repositoryId: string;
  pullNumber: string;
  source: string;
  baseSha: string;
  headSha: string;
  token: string;
  api?: string;
  fetchImpl?: typeof fetch;
}) {
  if (!['automatic', 'pr_comment', 'thread'].includes(options.source)) throw new Error('Invalid review trigger source');
  const response = await (options.fetchImpl ?? fetch)(
    `${options.api ?? 'https://api.github.com'}/repos/${options.repository}/pulls/${options.pullNumber}`,
    { headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/vnd.github+json' } },
  );
  if (!response.ok) throw new Error(`Review snapshot lookup failed: ${response.status}`);
  const pr = await response.json() as { state: string; draft: boolean; base: { sha: string; repo: { id: number } }; head: { sha: string } };
  if (pr.state !== 'open' || String(pr.base?.repo?.id) !== options.repositoryId) throw new Error('Pull request is not eligible for review');
  const baseSha = pr.base.sha;
  const headSha = pr.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(headSha)) throw new Error('Invalid review snapshot');
  if (options.source === 'automatic' && (baseSha !== options.baseSha || headSha !== options.headSha)) throw new Error('Automatic review snapshot is stale');
  return { baseSha, headSha };
}

export async function main() {
  const snapshot = await resolveReviewSnapshot({
    repository: process.env.REPOSITORY!, repositoryId: process.env.REPOSITORY_ID!, pullNumber: process.env.PULL_NUMBER!,
    source: process.env.TRIGGER_SOURCE!, baseSha: process.env.BASE_SHA ?? '', headSha: process.env.HEAD_SHA ?? '',
    token: process.env.GH_TOKEN!, api: process.env.GITHUB_API_URL,
  });
  await appendFile(process.env.GITHUB_OUTPUT!, `base_sha=${snapshot.baseSha}\nhead_sha=${snapshot.headSha}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error); process.exitCode = 1; });
