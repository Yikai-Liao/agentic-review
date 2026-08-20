import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const statusLabels = {
  suggest_resolve: '✅ 建议关闭',
  severity_increased: '⚠️ 风险升级',
  reintroduced: '🔁 问题重现',
};

export function parseUpdates(text) {
  if (Buffer.byteLength(text) > 100_000) throw new Error('Thread update queue is too large');
  const seen = new Set();
  const lines = text.split('\n').filter(Boolean);
  if (lines.length > 100) throw new Error('Too many thread updates');
  return lines.map((line) => {
    const update = JSON.parse(line);
    const keys = Object.keys(update).sort().join(',');
    if (keys !== 'evidence,root_comment_id,status') throw new Error('Invalid thread update fields');
    if (!Number.isInteger(update.root_comment_id) || update.root_comment_id < 1) {
      throw new Error('Invalid root_comment_id');
    }
    if (!Object.hasOwn(statusLabels, update.status)) throw new Error('Invalid thread status');
    if (typeof update.evidence !== 'string' || update.evidence.length < 10 || update.evidence.length > 5000) {
      throw new Error('Invalid thread evidence');
    }
    if (seen.has(update.root_comment_id)) throw new Error('Duplicate thread update');
    seen.add(update.root_comment_id);
    return update;
  });
}

async function github(fetchImpl, api, token, path, init = {}) {
  const response = await fetchImpl(`${api}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body}`);
  return body ? JSON.parse(body) : undefined;
}

async function reviewComments(fetchImpl, api, token, repository, pullNumber) {
  const comments = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await github(
      fetchImpl,
      api,
      token,
      `/repos/${repository}/pulls/${pullNumber}/comments?per_page=100&page=${page}`,
    );
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error('Too many review comments');
}

async function reviewThreads(fetchImpl, api, token, repository, pullNumber) {
  const [owner, repo] = repository.split('/');
  const threads = [];
  let cursor = null;
  do {
    const result = await github(fetchImpl, api, token, '/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: 'query($owner:String!,$repo:String!,$pull:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$pull){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:1){nodes{databaseId}}}pageInfo{hasNextPage endCursor}}}}}',
        variables: { owner, repo, pull: pullNumber, cursor },
      }),
    });
    if (result.errors?.length) throw new Error(`GitHub GraphQL: ${JSON.stringify(result.errors)}`);
    const page = result.data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}

export async function publishThreadUpdates({ updates, repository, pullNumber, botLogin, token, api, fetchImpl = fetch }) {
  if (!updates.length) return [];
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) throw new Error('Invalid repository');
  if (!Number.isInteger(pullNumber) || pullNumber < 1) throw new Error('Invalid pull number');
  if (!/^[A-Za-z0-9-]+\[bot\]$/.test(botLogin)) throw new Error('Invalid review bot login');

  const [comments, threads] = await Promise.all([
    reviewComments(fetchImpl, api, token, repository, pullNumber),
    reviewThreads(fetchImpl, api, token, repository, pullNumber),
  ]);
  const urls = [];
  for (const update of updates) {
    const root = comments.find(
      (comment) => comment.id === update.root_comment_id && comment.in_reply_to_id == null,
    );
    const thread = threads.find(
      (item) => item.comments.nodes[0]?.databaseId === update.root_comment_id,
    );
    if (!root || !thread) throw new Error(`${update.root_comment_id} is not a root comment in this PR`);
    if (root.user?.login?.toLowerCase() !== botLogin.toLowerCase()) {
      throw new Error(`${update.root_comment_id} was not created by ${botLogin}`);
    }
    if (thread.isResolved && update.status === 'suggest_resolve') {
      throw new Error(`${update.root_comment_id} is already resolved`);
    }
    const previousStatus = comments
      .filter(
        (comment) =>
          comment.in_reply_to_id === update.root_comment_id &&
          comment.user?.login?.toLowerCase() === botLogin.toLowerCase() &&
          comment.body.startsWith('**Pi thread 状态更新：'),
      )
      .at(-1)?.body;
    if (previousStatus?.startsWith(`**Pi thread 状态更新：${statusLabels[update.status]}**`)) {
      throw new Error(`${update.root_comment_id} status has not changed`);
    }

    const reply = await github(
      fetchImpl,
      api,
      token,
      `/repos/${repository}/pulls/${pullNumber}/comments/${update.root_comment_id}/replies`,
      {
        method: 'POST',
        body: JSON.stringify({
          body: `**Pi thread 状态更新：${statusLabels[update.status]}**\n\n${update.evidence}`,
        }),
      },
    );
    urls.push(reply.html_url);

    const resolutionMutation = update.status === 'suggest_resolve'
      ? 'mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}'
      : thread.isResolved
        ? 'mutation($thread:ID!){unresolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}'
        : undefined;
    if (resolutionMutation) {
      const resolution = await github(fetchImpl, api, token, '/graphql', {
        method: 'POST',
        body: JSON.stringify({
          query: resolutionMutation,
          variables: { thread: thread.id },
        }),
      });
      if (resolution.errors?.length) throw new Error(`GitHub GraphQL: ${JSON.stringify(resolution.errors)}`);
    }
  }
  return urls;
}

async function main() {
  const queue = process.env.REVIEW_THREAD_UPDATES_PATH;
  const repository = process.env.REPOSITORY;
  const pullNumber = Number(process.env.PULL_NUMBER);
  const botLogin = process.env.REVIEW_BOT_LOGIN;
  const token = process.env.GH_TOKEN;
  if (!queue || !repository || !botLogin || !token) throw new Error('Missing publication environment');

  let text;
  try {
    text = await readFile(queue, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const urls = await publishThreadUpdates({
    updates: parseUpdates(text),
    repository,
    pullNumber,
    botLogin,
    token,
    api: process.env.GITHUB_API_URL ?? 'https://api.github.com',
  });
  for (const url of urls) console.log(`Published thread update: ${url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
