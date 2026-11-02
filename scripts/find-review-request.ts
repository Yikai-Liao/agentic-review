function record(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function findLatestReviewWorkspace(options: {
  repositoryId: string;
  pullNumber: string;
  controlRepository: string;
  token: string;
  currentRun?: string;
  api?: string;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const prefixes = [
    `review-workspace-${options.repositoryId}-${options.pullNumber}-`,
    `review-completed-workspace-${options.repositoryId}-${options.pullNumber}-`,
  ];
  const artifacts: Array<Record<string, any>> = [];
  for (let page = 1; ; page++) {
    const response = await fetchImpl(`${options.api ?? 'https://api.github.com'}/repos/${options.controlRepository}/actions/artifacts?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub request workspace lookup failed: ${response.status}`);
    const body = await response.json() as any;
    if (!record(body) || !Array.isArray(body.artifacts)) throw new Error('Invalid GitHub request workspace response');
    for (const artifact of body.artifacts) {
      if (!record(artifact) || typeof artifact.name !== 'string' || typeof artifact.id !== 'number' || typeof artifact.expired !== 'boolean') throw new Error('Invalid GitHub request workspace response');
      if (prefixes.some((prefix) => artifact.name.startsWith(prefix)) && !artifact.expired) artifacts.push(artifact);
    }
    if (body.artifacts.length < 100) break;
  }
  const candidates = artifacts.map((artifact) => {
    const prefix = prefixes.find((candidate) => artifact.name.startsWith(candidate));
    const parts = artifact.name.slice(prefix?.length ?? artifact.name.length).split('-');
    const source = parts.at(-3);
    const runId = parts.at(-2);
    const runAttempt = parts.at(-1);
    return !['automatic', 'pr_comment'].includes(source ?? '') || !/^\d+$/.test(runId ?? '') || !/^\d+$/.test(runAttempt ?? '') || `${runId}:${runAttempt}` === options.currentRun
      ? null
      : { artifactId: String(artifact.id), runId: runId!, runAttempt: runAttempt!, source: source!, published: prefix === prefixes[1], createdAt: typeof artifact.created_at === 'string' ? artifact.created_at : '' };
  }).filter((candidate): candidate is { artifactId: string; runId: string; runAttempt: string; source: string; published: boolean; createdAt: string } => candidate !== null);
  return candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || Number(b.runId) - Number(a.runId))[0] ?? null;
}
