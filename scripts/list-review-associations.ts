import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const batchSize = 100;
const repositoryPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

type Association = {
  repository: string;
  number: number;
  title: string;
  url: string;
};

type AssociationIndex = {
  pull_requests: Association[];
  issues: Association[];
};

type ListOptions = {
  commits: string[];
  repository: string;
  pullNumber: number;
  token: string;
  graphql?: string;
  fetchImpl?: typeof fetch;
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compare(left: Association, right: Association) {
  if (left.repository !== right.repository) return left.repository < right.repository ? -1 : 1;
  return left.number - right.number;
}

function parseAssociation(value: unknown, kind: 'pull request' | 'issue'): Association {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.number) || (value.number as number) < 1
    || typeof value.title !== 'string'
    || typeof value.url !== 'string'
    || !isRecord(value.repository)
    || typeof value.repository.nameWithOwner !== 'string'
    || !repositoryPattern.test(value.repository.nameWithOwner)) {
    throw new Error(`Invalid GitHub ${kind} association`);
  }
  return {
    repository: value.repository.nameWithOwner,
    number: value.number as number,
    title: value.title,
    url: value.url,
  };
}

async function request(
  graphql: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
) {
  const response = await fetchImpl(graphql, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL association lookup failed: ${response.status}`);

  const body: unknown = await response.json();
  if (!isRecord(body) || (Array.isArray(body.errors) && body.errors.length)
    || !isRecord(body.data) || !isRecord(body.data.repository)) {
    throw new Error('Invalid GitHub GraphQL association response');
  }
  return body.data.repository;
}

function pullRequestQuery(count: number) {
  const oids = Array.from({ length: count }, (_, index) => `$oid${index}: GitObjectID!`).join(', ');
  const commits = Array.from(
    { length: count },
    (_, index) => `c${index}: object(oid: $oid${index}) {
      ... on Commit {
        oid
        associatedPullRequests(first: 100) {
          nodes { number title url repository { nameWithOwner } }
          pageInfo { hasNextPage }
        }
      }
    }`,
  ).join('\n');
  return `
query AssociatedPullRequests($owner: String!, $name: String!, ${oids}) {
  repository(owner: $owner, name: $name) {
    ${commits}
  }
}`;
}

const issueQuery = `
query AssociatedIssues($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 100, after: $after) {
        nodes { number title url repository { nameWithOwner } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export async function listReviewAssociations({
  commits,
  repository,
  pullNumber,
  token,
  graphql = 'https://api.github.com/graphql',
  fetchImpl = fetch,
}: ListOptions): Promise<AssociationIndex> {
  const [owner, name] = repository.split('/');
  const pullRequests = new Map<string, Association>();
  for (let offset = 0; offset < commits.length; offset += batchSize) {
    const batch = commits.slice(offset, offset + batchSize);
    const variables: Record<string, string> = { owner, name };
    batch.forEach((commit, index) => { variables[`oid${index}`] = commit; });
    const result = await request(graphql, token, pullRequestQuery(batch.length), variables, fetchImpl);

    for (const [index, sha] of batch.entries()) {
      const commit = result[`c${index}`];
      if (!isRecord(commit) || commit.oid !== sha || !isRecord(commit.associatedPullRequests)
        || !Array.isArray(commit.associatedPullRequests.nodes)
        || !isRecord(commit.associatedPullRequests.pageInfo)
        || typeof commit.associatedPullRequests.pageInfo.hasNextPage !== 'boolean') {
        throw new Error('Invalid GitHub GraphQL association response');
      }
      if (commit.associatedPullRequests.pageInfo.hasNextPage) {
        throw new Error(`More than 100 pull requests are associated with commit ${sha}`);
      }
      for (const value of commit.associatedPullRequests.nodes) {
        const association = parseAssociation(value, 'pull request');
        if (association.repository === repository && association.number === pullNumber) continue;
        pullRequests.set(`${association.repository}#${association.number}`, association);
      }
    }
  }

  const issues = new Map<string, Association>();
  let after: string | null = null;
  do {
    const result = await request(graphql, token, issueQuery, {
      owner, name, number: pullNumber, after,
    }, fetchImpl);
    if (!isRecord(result.pullRequest) || !isRecord(result.pullRequest.closingIssuesReferences)) {
      throw new Error('Invalid GitHub GraphQL association response');
    }
    const { nodes, pageInfo } = result.pullRequest.closingIssuesReferences;
    if (!Array.isArray(nodes) || !isRecord(pageInfo)
      || typeof pageInfo.hasNextPage !== 'boolean'
      || (pageInfo.hasNextPage && typeof pageInfo.endCursor !== 'string')) {
      throw new Error('Invalid GitHub GraphQL association response');
    }
    for (const value of nodes) {
      const association = parseAssociation(value, 'issue');
      issues.set(`${association.repository}#${association.number}`, association);
    }
    after = pageInfo.hasNextPage ? pageInfo.endCursor as string : null;
  } while (after);

  return {
    pull_requests: [...pullRequests.values()].sort(compare),
    issues: [...issues.values()].sort(compare),
  };
}

export async function main() {
  const {
    REVIEW_TARGET_PATH: targetPath,
    REVIEW_REPOSITORY: repository,
    REVIEW_PULL_NUMBER: pullNumberValue,
    REVIEW_BASE_SHA: baseSha,
    REVIEW_HEAD_SHA: headSha,
    REVIEW_ASSOCIATIONS_PATH: output,
    GH_TOKEN: token,
    GITHUB_GRAPHQL_URL: graphql,
  } = process.env;
  if (!targetPath || !repository || !pullNumberValue || !baseSha || !headSha || !output || !token) {
    throw new Error('Missing review association environment');
  }
  const pullNumber = Number(pullNumberValue);
  if (!path.isAbsolute(targetPath) || !path.isAbsolute(output)
    || !repositoryPattern.test(repository)
    || !Number.isSafeInteger(pullNumber) || pullNumber < 1
    || !shaPattern.test(baseSha) || !shaPattern.test(headSha)) {
    throw new Error('Invalid review association environment');
  }

  const { stdout: mergeBaseOutput } = await exec('git', ['-C', targetPath, 'merge-base', baseSha, headSha]);
  const mergeBase = mergeBaseOutput.trim();
  if (!shaPattern.test(mergeBase)) throw new Error('Invalid merge base');
  const { stdout } = await exec('git', ['-C', targetPath, 'rev-list', '--topo-order', headSha, `^${mergeBase}`]);
  const commits = stdout.trim() ? stdout.trim().split('\n') : [];
  const associations = await listReviewAssociations({
    commits,
    repository,
    pullNumber,
    token,
    graphql,
  });
  await writeFile(output, `${JSON.stringify(associations, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
