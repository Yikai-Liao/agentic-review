import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { checkpointQuery, reviewedRunId } from './find-review-checkpoint.ts';
import { request } from './list-review-associations.ts';
import { fetchReviewCommits } from './prepare-review-sources.ts';

const exec = promisify(execFile);
const batchSize = 50;
// 每个来源最多 100 个 suite × 100 条记录；批次缩小以留在 GraphQL 节点上限内。
const checkBatchSize = 10;
const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export type SourcePullRequest = { number: number; title: string; url: string };

// reviewed：文件在每个合入步骤里都与已审来源 PR 的 head 一致。
// composition：来源 PR 已审，但合入后的内容与其 head 不同（叠加或冲突解决产生了审查者没见过的内容）。
// 其余文件（来源未审、无来源 PR、不在任何第一父步骤的净变化里）不出现在结果中，按普通审查处理。
export type SourceAttribution = {
  reviewed: string[];
  composition: Array<{ path: string; pull_requests: SourcePullRequest[] }>;
  pull_requests: SourcePullRequest[];
};

export const emptyAttribution: SourceAttribution = { reviewed: [], composition: [], pull_requests: [] };

type Source = SourcePullRequest & { head: string; reviewed: boolean };
type FileState = 'reviewed' | 'composition' | 'direct';
const rank: Record<FileState, number> = { reviewed: 0, composition: 1, direct: 2 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function git(target: string, args: string[]) {
  return (await exec('git', ['-C', target, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })).stdout;
}

// 一次进程读取全部 `rev:path` 的 blob；缺失（文件在该版本不存在）返回 null。
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

// 每个第一父步骤是否恰好是某个已合入 PR 的合入提交；是则返回该来源 PR。
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
          sources.set(step, { number: node.number as number, title: node.title, url: node.url, head: node.headRefOid, reviewed: false });
        }
      }
    });
  }
  return sources;
}

// 来源 PR 的 head 上有同一 Review App 完成的 automatic audit，才算已审。
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
      source.reviewed = reviewedRunId(commit, source.head, options.repositoryId, String(source.number), undefined, options.appSlug) !== null;
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
  // 已审来源的 head 可能不在共享 Git 对象库中（squash 合入后分支已删除），补取后才能比较内容。
  await fetchReviewCommits(target, reviewedSources.map((source) => source.head));

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
    // 含换行的路径无法放进 cat-file 的行协议，保守地按普通审查处理。
    const comparable = files.filter((file) => !file.includes('\n'));
    files.filter((file) => file.includes('\n')).forEach((file) => raise(file, 'direct'));
    // 来源审查的是 head 相对其分叉点的改动。合入结果等于 head，且合入前的基线一侧自分叉点起未变，
    // 合入才与审查看到的改动一致；基线一侧已有不同内容却被 head 整体覆盖时，被丢弃的改动没有被审过。
    const fork = (await git(target, ['merge-base', `${step}^1`, source.head])).trim();
    const ids = await blobIds(target, comparable.flatMap((file) => [`${step}:${file}`, `${source.head}:${file}`, `${step}^1:${file}`, `${fork}:${file}`]));
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
  // thread 请求只审查被讨论的文件，不使用来源归因。
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
