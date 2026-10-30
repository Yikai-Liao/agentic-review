import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const checkName = 'Agentic Review / audit';
const shaPattern = /^[0-9a-f]{40}$/;
const batchSize = 100;

type Checkpoint = { headSha: string; runId: string };

type FindOptions = {
  commits: string[];
  repository: string;
  repositoryId: string;
  pullNumber: string;
  baseSha: string;
  appSlug: string;
  token: string;
  graphql?: string;
  fetchImpl?: typeof fetch;
};

type WorkspaceArtifactOptions = {
  repository: string;
  repositoryId: string;
  pullNumber: string;
  source: 'automatic';
  runId: string;
  runAttempt: string;
  token: string;
  api?: string;
  fetchImpl?: typeof fetch;
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkpointQuery(count: number) {
  const oids = Array.from({ length: count }, (_, index) => `$oid${index}: GitObjectID!`).join(', ');
  const commits = Array.from(
    { length: count },
    (_, index) => `c${index}: object(oid: $oid${index}) { ...Checkpoint }`,
  ).join('\n');
  return `
query Checkpoints($owner: String!, $name: String!, ${oids}) {
  repository(owner: $owner, name: $name) {
    ${commits}
  }
}
fragment Checkpoint on Commit {
  oid
  checkSuites(first: 100, filterBy: { checkName: "${checkName}" }) {
    nodes {
      app { slug }
      checkRuns(first: 10, filterBy: {
        checkName: "${checkName}",
        statuses: [COMPLETED],
        conclusions: [SUCCESS]
      }) {
        nodes { name externalId status conclusion }
      }
    }
  }
}`;
}

function reviewedRunId(
  commit: RecordValue,
  sha: string,
  repositoryId: string,
  pullNumber: string,
  baseSha: string,
  appSlug: string,
) {
  const checkSuites = commit.checkSuites;
  if (commit.oid !== sha || !isRecord(checkSuites) || !Array.isArray(checkSuites.nodes)) {
    throw new Error('Invalid GitHub GraphQL checkpoint response');
  }

  for (const suite of checkSuites.nodes) {
    if (!isRecord(suite) || !isRecord(suite.checkRuns) || !Array.isArray(suite.checkRuns.nodes)) {
      throw new Error('Invalid GitHub GraphQL checkpoint response');
    }
    if (!isRecord(suite.app) || suite.app.slug !== appSlug) continue;

    for (const check of suite.checkRuns.nodes) {
      if (!isRecord(check)) throw new Error('Invalid GitHub GraphQL checkpoint response');
      const parts = typeof check.externalId === 'string' ? check.externalId.split(':') : [];
      if (check.name === checkName
        && check.status === 'COMPLETED'
        && check.conclusion === 'SUCCESS'
        && parts.length === 7
        && parts[0] === repositoryId
        && parts[1] === pullNumber
        && parts[2] === baseSha
        && parts[3] === sha
        && parts[4] === 'automatic'
        && /^[0-9]+$/.test(parts[5]!)
        && /^[0-9]+$/.test(parts[6]!)) {
        return `${parts[5]}:${parts[6]}`;
      }
    }
  }
  return null;
}

export async function findReviewCheckpoint({
  commits, repository, repositoryId, pullNumber, baseSha, appSlug, token,
  graphql = 'https://api.github.com/graphql', fetchImpl = fetch,
}: FindOptions) {
  const [owner, name] = repository.split('/');
  for (let offset = 0; offset < commits.length; offset += batchSize) {
    const batch = commits.slice(offset, offset + batchSize);
    const variables: Record<string, string> = { owner, name };
    batch.forEach((commit, index) => { variables[`oid${index}`] = commit; });
    const response = await fetchImpl(graphql, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ query: checkpointQuery(batch.length), variables }),
    });
    if (!response.ok) throw new Error(`GitHub GraphQL checkpoint lookup failed: ${response.status}`);

    const body: unknown = await response.json();
    if (!isRecord(body) || (Array.isArray(body.errors) && body.errors.length)
      || !isRecord(body.data) || !isRecord(body.data.repository)) {
      throw new Error('Invalid GitHub GraphQL checkpoint response');
    }
    for (const [index, sha] of batch.entries()) {
      const commit = body.data.repository[`c${index}`];
      if (!isRecord(commit)) throw new Error('Invalid GitHub GraphQL checkpoint response');
      const runId = reviewedRunId(commit, sha, repositoryId, pullNumber, baseSha, appSlug);
      if (runId) return { headSha: sha, runId } satisfies Checkpoint;
    }
  }
  return null;
}

export async function findReviewWorkspaceArtifact({
  repository, repositoryId, pullNumber, source, runId, runAttempt, token, api = 'https://api.github.com', fetchImpl = fetch,
}: WorkspaceArtifactOptions) {
  const response = await fetchImpl(
    `${api}/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub artifact lookup failed: ${response.status}`);

  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.artifacts)) {
    throw new Error('Invalid GitHub artifact response');
  }
  for (const item of body.artifacts) {
    if (!isRecord(item)
      || typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id < 1
      || typeof item.name !== 'string' || typeof item.expired !== 'boolean') {
      throw new Error('Invalid GitHub artifact response');
    }
  }
  const name = `review-completed-workspace-${repositoryId}-${pullNumber}-${source}-${runId}-${runAttempt}`;
  const artifact = body.artifacts.find((item) => item.name === name && !item.expired);
  if (!artifact) return null;
  return String(artifact.id);
}

export async function findReviewWorkspaceArtifactSafely(
  options: WorkspaceArtifactOptions,
  warn = console.warn,
) {
  try {
    return await findReviewWorkspaceArtifact(options);
  } catch (error) {
    warn(`Previous review workspace lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function findReviewCheckpointSafely(options: FindOptions, warn = console.warn) {
  try {
    return await findReviewCheckpoint(options);
  } catch (error) {
    warn(`Review checkpoint lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function main() {
  const {
    REVIEW_TARGET_PATH: targetPath,
    REPOSITORY: repository,
    REPOSITORY_ID: repositoryId,
    PULL_NUMBER: pullNumber,
    BASE_SHA: baseSha,
    HEAD_SHA: headSha,
    REVIEW_APP_SLUG: appSlug,
    GH_TOKEN: token,
    CONTROL_REPOSITORY: controlRepository,
    CONTROL_TOKEN: controlToken,
    GITHUB_GRAPHQL_URL: graphql,
    GITHUB_API_URL: api,
    GITHUB_OUTPUT: output,
  } = process.env;
  if (!targetPath || !repository || !repositoryId || !pullNumber || !baseSha || !headSha || !appSlug
    || !token || !controlRepository || !controlToken || !output) {
    throw new Error('Missing review checkpoint environment');
  }
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)
    || !/^[0-9]+$/.test(repositoryId)
    || !/^[0-9]+$/.test(pullNumber)
    || !shaPattern.test(baseSha)
    || !shaPattern.test(headSha)
    || !/^[A-Za-z0-9-]+$/.test(appSlug)
    || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(controlRepository)) {
    throw new Error('Invalid review checkpoint environment');
  }

  const { stdout: mergeBaseOutput } = await exec('git', ['-C', targetPath, 'merge-base', baseSha, headSha]);
  const mergeBase = mergeBaseOutput.trim();
  if (!shaPattern.test(mergeBase)) throw new Error('Invalid merge base');
  const { stdout } = await exec('git', ['-C', targetPath, 'rev-list', '--topo-order', headSha, `^${mergeBase}`]);
  const commits = stdout.trim() ? stdout.trim().split('\n') : [];
  // 候选均为当前 head 的祖先；merge 的净变化（含冲突解决）仍进入 focus diff。
  // 未改完成项可延续；间接影响由 Agent 沿增量按需重开。
  let checkpoint = await findReviewCheckpointSafely({
    commits,
    repository,
    repositoryId,
    pullNumber,
    baseSha,
    appSlug,
    token,
    graphql,
  });
  const [checkpointRunId, checkpointRunAttempt] = checkpoint?.runId.split(':') ?? [];
  const artifactId = checkpoint
    ? await findReviewWorkspaceArtifactSafely({
      repository: controlRepository,
      repositoryId,
      pullNumber,
      source: 'automatic',
      runId: checkpointRunId!,
      runAttempt: checkpointRunAttempt!,
      token: controlToken,
      api,
    })
    : null;
  if (!artifactId) checkpoint = null;
  await appendFile(output, [
    `head_sha=${checkpoint?.headSha ?? ''}`,
    `run_id=${checkpoint ? checkpointRunId : ''}`,
    `run_attempt=${checkpoint ? checkpointRunAttempt : ''}`,
    `workspace_artifact_id=${artifactId ?? ''}`,
    '',
  ].join('\n'));
}
