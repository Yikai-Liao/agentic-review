import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export type Run = (command: string, args: string[]) => Promise<string>;
type RecordWithId = { id: number | string; [key: string]: unknown };
type Discussion = {
  issue_comments: RecordWithId[];
  inline_comments: RecordWithId[];
  reviews: RecordWithId[];
  threads: RecordWithId[];
};
export type DiscussionThreads = Pick<Discussion, 'inline_comments' | 'threads'>;
export type DiscussionBaseline = {
  repository: string;
  pull: string;
  since: string;
  fingerprints: Record<keyof Discussion, Record<string, string>>;
};

const exec = promisify(execFile);
export const runGh: Run = async (command, args) => (await exec(command, args, { encoding: 'utf8', maxBuffer: Infinity })).stdout;
const fingerprint = (record: RecordWithId) => createHash('sha256').update(JSON.stringify(record)).digest('hex');

export function groupReviewThreads(discussion: DiscussionThreads) {
  const groups = new Map<string, { root_comment_id: string; state: RecordWithId | null; comments: RecordWithId[] }>();
  for (const state of discussion.threads) {
    const root = String(state.root_comment_id);
    groups.set(root, { root_comment_id: root, state, comments: [] });
  }
  // REST 评论和 GraphQL 状态可能暂时不同步；两侧原文入口都保留。
  for (const comment of discussion.inline_comments) {
    const root = String(comment.in_reply_to_id ?? comment.id);
    const group = groups.get(root) ?? { root_comment_id: root, state: null, comments: [] };
    group.comments.push(comment);
    groups.set(root, group);
  }
  return [...groups.values()];
}

const selectFields = (record: Record<string, unknown>, fields: readonly string[]) =>
  Object.fromEntries(fields.filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]]));

// 当前 PR、关联 PR 和讨论刷新共用证据表示；正文与定位原样保留，
// 不把每条评论重复的用户头像、关注列表和 API 导航地址带进模型上下文。
function discussionEvidence(record: RecordWithId): RecordWithId {
  const { url, node_id, issue_url, pull_request_url, _links, user, performed_via_github_app, ...evidence } = record;
  for (const [field, fields] of [
    ['user', ['id', 'login', 'type', 'html_url']],
    ['performed_via_github_app', ['id', 'slug', 'name']],
  ] as const) {
    const actor = record[field];
    if (actor === null) evidence[field] = null;
    else if (actor && typeof actor === 'object') evidence[field] = selectFields(actor as Record<string, unknown>, fields);
  }
  return evidence;
}

export async function readDiscussion(repository: string, pull: string, run: Run = runGh, baseline?: DiscussionBaseline) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[1-9]\d*$/.test(pull)) throw new Error('Invalid PR target');
  if (baseline && (baseline.repository !== repository || baseline.pull !== pull ||
      !Number.isFinite(Date.parse(baseline.since)))) throw new Error('Invalid discussion baseline');
  // 固定启动基线；重叠一秒覆盖 GitHub 秒精度的边界，再用指纹剔除重复。
  const since = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000).toISOString();
  const discussion: Discussion = { issue_comments: [], inline_comments: [], reviews: [], threads: [] };
  const routes = [
    ['issue_comments', `issues/${pull}/comments`],
    ['inline_comments', `pulls/${pull}/comments`],
    ['reviews', `pulls/${pull}/reviews`],
  ] as const;
  const [owner, name] = repository.split('/');
  const query = `query($owner:String!,$name:String!,$pull:Int!,$endCursor:String) {
    repository(owner:$owner,name:$name) { pullRequest(number:$pull) {
      reviewThreads(first:100,after:$endCursor) {
        nodes { id isResolved isOutdated resolvedBy { login } comments(first:1) { nodes { databaseId } } }
        pageInfo { hasNextPage endCursor }
      }
    } }
  }`;
  // 四种记录各自完整分页，彼此独立；固定基线仍早于全部请求。
  const responses = await Promise.all([
    ...routes.map(([kind, route]) => {
      // Reviews 没有 since 参数；只在本地比对后输出变化。
      const filter = baseline && kind !== 'reviews' ? `&since=${encodeURIComponent(baseline.since)}` : '';
      return run('gh', ['api', '--paginate', '--slurp', `repos/${repository}/${route}?per_page=100${filter}`]);
    }),
    run('gh', ['api', 'graphql', '--paginate', '--slurp', '-f', `query=${query}`,
      '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pull=${pull}`]),
  ]);
  for (const [index, [kind]] of routes.entries()) {
    const pages = JSON.parse(responses[index]!);
    if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page))) {
      throw new Error(`Invalid ${kind} pages`);
    }
    discussion[kind] = pages.flat().map(record => {
      if (!Number.isInteger(record?.id) || typeof record.body !== 'string') throw new Error(`Invalid ${kind} record`);
      return discussionEvidence(record);
    });
  }
  const pages = JSON.parse(responses[routes.length]!);
  if (!Array.isArray(pages) || !pages.length) throw new Error('Invalid thread pages');
  for (const [index, page] of pages.entries()) {
    const connection = page?.data?.repository?.pullRequest?.reviewThreads;
    if (page?.errors?.length || !Array.isArray(connection?.nodes) ||
        connection.pageInfo?.hasNextPage !== (index < pages.length - 1) ||
        (connection.pageInfo.hasNextPage && !connection.pageInfo.endCursor)) {
      throw new Error('Incomplete thread pages');
    }
    for (const thread of connection.nodes) {
      const root = thread?.comments?.nodes?.[0]?.databaseId;
      if (typeof thread?.id !== 'string' || typeof thread.isResolved !== 'boolean' ||
          typeof thread.isOutdated !== 'boolean' || !Number.isInteger(root)) throw new Error('Invalid thread');
      discussion.threads.push({ id: thread.id, root_comment_id: root, isResolved: thread.isResolved,
        isOutdated: thread.isOutdated, resolvedBy: thread.resolvedBy?.login ?? null });
    }
  }
  // thread 已完整分页读取；缺失 ID 是删除变化，不能被后面的增量过滤抹掉。
  const currentThreadIds = new Set(discussion.threads.map(thread => thread.id));
  const removedThreadIds = Object.keys(baseline?.fingerprints.threads ?? {})
    .filter(id => !currentThreadIds.has(id));
  const fingerprints = {} as DiscussionBaseline['fingerprints'];
  for (const kind of Object.keys(discussion) as Array<keyof Discussion>) {
    fingerprints[kind] = Object.fromEntries(discussion[kind].map(record => [record.id, fingerprint(record)]));
    if (baseline) discussion[kind] = discussion[kind].filter(record => baseline.fingerprints[kind][record.id] !== fingerprint(record));
  }
  return { discussion, removed_thread_ids: removedThreadIds,
    baseline: { repository, pull, since, fingerprints } satisfies DiscussionBaseline };
}

export async function main(run: Run = runGh) {
  const required = (name: string) => {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
    return process.env[name]!;
  };
  const baseline: DiscussionBaseline = JSON.parse(readFileSync(path.join(required('REVIEW_WORKSPACE_PATH'), 'discussion-baseline.json'), 'utf8'));
  const snapshot: DiscussionThreads = JSON.parse(readFileSync(`${required('REVIEW_INPUT_PATH')}.discussion.json`, 'utf8'));
  const { discussion, removed_thread_ids } = await readDiscussion(required('REVIEW_REPOSITORY'), required('REVIEW_PULL_NUMBER'), run, baseline);
  const comments = new Map(snapshot.inline_comments.map(comment => [comment.id, comment]));
  for (const comment of discussion.inline_comments) comments.set(comment.id, comment);
  const states = new Map(snapshot.threads.map(state => [state.id, state]));
  const removed_threads = removed_thread_ids.map(id => {
    const state = states.get(id);
    if (!state) throw new Error('Removed thread is missing from startup snapshot');
    states.delete(id);
    return { id, root_comment_id: state.root_comment_id };
  });
  for (const state of discussion.threads) states.set(state.id, state);
  const changedRoots = new Set([
    ...discussion.inline_comments.map(comment => String(comment.in_reply_to_id ?? comment.id)),
    ...discussion.threads.map(state => String(state.root_comment_id)),
  ]);
  const threads = groupReviewThreads({ inline_comments: [...comments.values()], threads: [...states.values()] })
    .filter(group => changedRoots.has(group.root_comment_id));
  return JSON.stringify({ since: baseline.since, refreshed_at: new Date().toISOString(),
    issue_comments: discussion.issue_comments, reviews: discussion.reviews, threads, removed_threads }, null, 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
}
