import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { checkpointQuery, reviewedCheck } from './find-review-checkpoint.ts';
import { request } from './list-review-associations.ts';
import { fetchReviewCommits } from './prepare-review-sources.ts';

const exec = promisify(execFile);
const batchSize = 50;
// Each source has up to 100 suites × 100 runs; small batches stay within the GraphQL node limit.
const checkBatchSize = 10;
const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export type SourcePullRequest = { number: number; title: string; url: string };

// reviewed: the file matches the reviewed source PR's head in every merge step.
// composition: the source PR was reviewed, but the merged content differs from its head (stacking or conflict resolution produced content its reviewers never saw).
// Other files (unreviewed source, no source PR, not in any first-parent step's net change) are omitted and reviewed normally.
export type SourceAttribution = {
  reviewed: string[];
  composition: Array<{ path: string; pull_requests: SourcePullRequest[] }>;
  pull_requests: SourcePullRequest[];
};

export const emptyAttribution: SourceAttribution = { reviewed: [], composition: [], pull_requests: [] };

// base is the comparison base when the source PR passed review; the source review's diff is merge-base(base, head)..head.
type Source = SourcePullRequest & { head: string; reviewed: boolean; base: string };
type FileState = 'reviewed' | 'composition' | 'direct';
const rank: Record<FileState, number> = { reviewed: 0, composition: 1, direct: 2 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function git(target: string, args: string[]) {
  return (await exec('git', ['-C', target, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })).stdout;
}

// Reads every `rev:path` blob in one process; a missing file at that revision returns null.
function blobIds(target: string, specs: string[]): Promise<Array<string | null>> {
  if (!specs.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', target, 'cat-file', '--batch-check'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file failed: ${code}`));
      const lines = output.split('\n');
      lines.pop();
      if (lines.length !== specs.length) return reject(new Error('Unexpected git cat-file output'));
      resolve(lines.map((line) => (line.endsWith(' missing') ? null : line.split(' ')[0]!)));
    });
    child.stdin.end(`${specs.join('\n')}\n`);
  });
}

function batches<T>(items: T[]) {
  return Array.from({ length: Math.ceil(items.length / batchSize) }, (_, index) => items.slice(index * batchSize, (index + 1) * batchSize));
}

function variablesFor(owner: string, name: string, oids: string[]) {
  const variables: Record<string, string> = { owner, name };
  oids.forEach((oid, index) => { variables[`oid${index}`] = oid; });
  return variables;
}

const declarations = (count: number) => Array.from({ length: count }, (_, index) => `$oid${index}: GitObjectID!`).join(', ');

function mergedSourceQuery(count: number) {
  const commits = Array.from({ length: count }, (_, index) => `c${index}: object(oid: $oid${index}) {
      ... on Commit {
        oid
        associatedPullRequests(first: 100) {
          nodes { number title url state headRefOid mergeCommit { oid } repository { nameWithOwner } }
          pageInfo { hasNextPage }
        }
      }
    }`).join('\n');
  return `query MergedSources($owner: String!, $name: String!, ${declarations(count)}) { repository(owner: $owner, name: $name) { ${commits} } }`;
}

// Whether each first-parent step is exactly the merge commit of a merged PR; if so, returns that source PR.
async function mergedSources(options: AttributeOptions, steps: string[]) {
  const [owner, name] = options.repository.split('/');
  const sources = new Map<string, Source>();
  for (const batch of batches(steps)) {
    const result = await request(options.graphql ?? 'https://api.github.com/graphql', options.token,
      mergedSourceQuery(batch.length), variablesFor(owner!, name!, batch), options.fetchImpl ?? fetch);
    batch.forEach((step, index) => {
      const commit = result[`c${index}`];
      if (!isRecord(commit) || commit.oid !== step || !isRecord(commit.associatedPullRequests)
        || !Array.isArray(commit.associatedPullRequests.nodes) || !isRecord(commit.associatedPullRequests.pageInfo)) {
        throw new Error('Invalid GitHub GraphQL source response');
      }
      if (commit.associatedPullRequests.pageInfo.hasNextPage) throw new Error(`Too many pull requests associated with ${step}`);
      for (const node of commit.associatedPullRequests.nodes) {
        if (!isRecord(node) || !Number.isSafeInteger(node.number) || typeof node.title !== 'string' || typeof node.url !== 'string'
          || typeof node.state !== 'string' || typeof node.headRefOid !== 'string' || !shaPattern.test(node.headRefOid)
          || !isRecord(node.repository) || typeof node.repository.nameWithOwner !== 'string') {
          throw new Error('Invalid GitHub GraphQL source response');
        }
        const merge = isRecord(node.mergeCommit) ? node.mergeCommit.oid : null;
        if (node.state === 'MERGED' && merge === step && node.repository.nameWithOwner === options.repository) {
          sources.set(step, { number: node.number as number, title: node.title, url: node.url, head: node.headRefOid, reviewed: false, base: '' });
        }
      }
    });
  }
  return sources;
}

// A source PR counts as reviewed only when its head has a completed automatic audit by the same Review App.
async function markReviewed(options: AttributeOptions, sources: Source[]) {
  const [owner, name] = options.repository.split('/');
  for (let offset = 0; offset < sources.length; offset += checkBatchSize) {
    const batch = sources.slice(offset, offset + checkBatchSize);
    const result = await request(options.graphql ?? 'https://api.github.com/graphql', options.token,
      checkpointQuery(batch.length, 100),
      variablesFor(owner!, name!, batch.map((source) => source.head)), options.fetchImpl ?? fetch);
    batch.forEach((source, index) => {
      const commit = result[`c${index}`];
      if (!isRecord(commit)) throw new Error('Invalid GitHub GraphQL checkpoint response');
      const check = reviewedCheck(commit, source.head, options.repositoryId, String(source.number), undefined, options.appSlug);
      source.reviewed = check !== null;
      source.base = check?.baseSha ?? '';
    });
  }
}

export type AttributeOptions = {
  targetPath: string;
  repository: string;
  repositoryId: string;
  mergeBase: string;
  headSha: string;
  appSlug: string;
  token: string;
  graphql?: string;
  fetchImpl?: typeof fetch;
};

export async function attributeReviewSources(options: AttributeOptions): Promise<SourceAttribution> {
  const { targetPath: target, mergeBase, headSha } = options;
  const steps = (await git(target, ['rev-list', '--first-parent', headSha, `^${mergeBase}`])).split('\n').filter(Boolean);
  const sources = await mergedSources(options, steps);
  await markReviewed(options, [...sources.values()]);
  const reviewedSources = [...sources.values()].filter((source) => source.reviewed);
  // A reviewed source head may be missing from the shared object store (branch deleted after a squash merge); fetch it before comparing.
  await fetchReviewCommits(target, reviewedSources.flatMap((source) => [source.head, source.base]));

  const states = new Map<string, FileState>();
  const touched = new Map<string, Map<number, SourcePullRequest>>();
  const raise = (file: string, state: FileState) => {
    const previous = states.get(file);
    if (!previous || rank[state] > rank[previous]) states.set(file, state);
  };
  for (const step of steps) {
    const files = (await git(target, ['diff', '--name-only', '--no-renames', '-z', `${step}^1`, step, '--'])).split('\0').filter(Boolean);
    const source = sources.get(step);
    if (!source?.reviewed) {
      files.forEach((file) => raise(file, 'direct'));
      continue;
    }
    // Paths with newlines cannot use cat-file's line protocol, so they are conservatively reviewed normally.
    const comparable = files.filter((file) => !file.includes('\n'));
    files.filter((file) => file.includes('\n')).forEach((file) => raise(file, 'direct'));
    // The source review covered merge-base(base at review time, head)..head. Only when the merged result equals head
    // and the pre-merge base side has not moved from that start does this step match what the review saw; otherwise
    // (other history carried in by a rebased source, or taking the source version wholesale and dropping base-side
    // changes) the source reviewers never saw this content.
    const reviewStart = (await git(target, ['merge-base', source.base, source.head])).trim();
    const ids = await blobIds(target, comparable.flatMap((file) => [`${step}:${file}`, `${source.head}:${file}`, `${step}^1:${file}`, `${reviewStart}:${file}`]));
    comparable.forEach((file, index) => {
      const same = ids[index * 4] === ids[index * 4 + 1] && ids[index * 4 + 2] === ids[index * 4 + 3];
      raise(file, same ? 'reviewed' : 'composition');
      if (!same) touched.set(file, (touched.get(file) ?? new Map()).set(source.number, source));
    });
  }

  const reviewed = [...states].filter(([, state]) => state === 'reviewed').map(([file]) => file).sort();
  const composition = [...states].filter(([, state]) => state === 'composition').map(([file]) => ({
    path: file, pull_requests: [...touched.get(file)!.values()].map(({ number, title, url }) => ({ number, title, url })).sort((a, b) => a.number - b.number),
  })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const involved = new Map<number, SourcePullRequest>();
  for (const source of reviewedSources) involved.set(source.number, { number: source.number, title: source.title, url: source.url });
  return { reviewed, composition, pull_requests: [...involved.values()].sort((a, b) => a.number - b.number) };
}

export async function main() {
  const {
    REVIEW_TARGET_PATH: targetPath, REVIEW_REPOSITORY: repository, REVIEW_REPOSITORY_ID: repositoryId,
    REVIEW_BASE_SHA: baseSha, REVIEW_HEAD_SHA: headSha, REVIEW_APP_SLUG: appSlug, REVIEW_TRIGGER_SOURCE: source,
    REVIEW_ATTRIBUTION_PATH: output, GH_TOKEN: token, GITHUB_GRAPHQL_URL: graphql,
  } = process.env;
  if (!targetPath || !repository || !repositoryId || !baseSha || !headSha || !appSlug || !source || !output || !token) {
    throw new Error('Missing review attribution environment');
  }
  if (!path.isAbsolute(targetPath) || !path.isAbsolute(output) || !repositoryPattern.test(repository) || !/^[0-9]+$/.test(repositoryId)
    || !shaPattern.test(baseSha) || !shaPattern.test(headSha) || !/^[A-Za-z0-9-]+$/.test(appSlug)) {
    throw new Error('Invalid review attribution environment');
  }
  // Thread requests review only the discussed file and skip source attribution.
  let attribution = emptyAttribution;
  if (source !== 'thread') {
    const mergeBase = (await git(targetPath, ['merge-base', baseSha, headSha])).trim();
    if (!shaPattern.test(mergeBase)) throw new Error('Invalid merge base');
    attribution = await attributeReviewSources({ targetPath, repository, repositoryId, mergeBase, headSha, appSlug, token, graphql });
  }
  await writeFile(output, `${JSON.stringify(attribution)}\n`, { encoding: 'utf8', mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
