import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ReviewSnapshot = {
  repository: string;
  pullNumber: string;
  baseSha: string;
  headSha: string;
  metadata: Record<string, unknown>;
};

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
  const pr = await response.json() as { title?: string; body?: string | null; user?: { login: string }; state: string; draft: boolean;
    merged?: boolean; merged_at?: string | null;
    base: { ref?: string; sha: string; repo: { id: number } }; head: { ref?: string; sha: string } };
  if (!(pr.state === 'open' || (pr.state === 'closed' && pr.merged === true))
    || String(pr.base?.repo?.id) !== options.repositoryId) throw new Error('Pull request is not eligible for review');
  const baseSha = pr.base.sha;
  const headSha = pr.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(headSha)) throw new Error('Invalid review snapshot');
  if (options.source === 'automatic' && (baseSha !== options.baseSha || headSha !== options.headSha)) throw new Error('Automatic review snapshot is stale');
  return {
    repository: options.repository, pullNumber: options.pullNumber, baseSha, headSha,
    metadata: { title: pr.title, body: pr.body ?? '', author: { login: pr.user?.login },
      state: pr.state, merged: pr.merged === true, mergedAt: pr.merged_at ?? null,
      baseRefName: pr.base.ref, baseRefOid: baseSha, headRefName: pr.head.ref, headRefOid: headSha },
  } satisfies ReviewSnapshot;
}

export async function main() {
  const snapshot = await resolveReviewSnapshot({
    repository: process.env.REPOSITORY!, repositoryId: process.env.REPOSITORY_ID!, pullNumber: process.env.PULL_NUMBER!,
    source: process.env.TRIGGER_SOURCE!, baseSha: process.env.BASE_SHA ?? '', headSha: process.env.HEAD_SHA ?? '',
    token: process.env.GH_TOKEN!, api: process.env.GITHUB_API_URL,
  });
  const file = process.env.REVIEW_SNAPSHOT_PATH;
  if (!file) throw new Error('Missing REVIEW_SNAPSHOT_PATH');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o400, flag: 'wx' });
  await appendFile(process.env.GITHUB_OUTPUT!, `base_sha=${snapshot.baseSha}\nhead_sha=${snapshot.headSha}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error); process.exitCode = 1; });
