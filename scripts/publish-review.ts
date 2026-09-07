import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseReviewResult, statusLabels, type ReviewResult } from './review-result.ts';

type FooterMetadata = {
  runUrl: string;
  workspaceUrl: string;
  model: string;
  thinkingLevel?: string;
  durationSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  piVersion?: string;
  actionVersion?: string;
};
type PublishOptions = {
  result: ReviewResult;
  repository: string;
  pullNumber: number;
  botLogin: string;
  token: string;
  expectedHeadSha: string;
  footer: string;
  api: string;
  fetchImpl?: typeof fetch;
};
type ReviewComment = {
  id: number;
  in_reply_to_id: number | null;
  body: string;
  user?: { login?: string };
};
type ReviewThread = {
  id: string;
  comments: { nodes: Array<{ databaseId: number }> };
};

async function github<T>(fetchImpl: typeof fetch, api: string, token: string, route: string, init: RequestInit = {}) {
  const response = await fetchImpl(`${api}${route}`, {
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
  return (body ? JSON.parse(body) : undefined) as T;
}

async function reviewComments(
  fetchImpl: typeof fetch,
  api: string,
  token: string,
  repository: string,
  pullNumber: number,
) {
  const comments: ReviewComment[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await github<ReviewComment[]>(
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

async function reviewThreads(
  fetchImpl: typeof fetch,
  api: string,
  token: string,
  repository: string,
  pullNumber: number,
) {
  const [owner, repo] = repository.split('/');
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  do {
    const result: any = await github(fetchImpl, api, token, '/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: 'query($owner:String!,$repo:String!,$pull:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$pull){reviewThreads(first:100,after:$cursor){nodes{id comments(first:1){nodes{databaseId}}}pageInfo{hasNextPage endCursor}}}}}',
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

async function reviewThreadState(fetchImpl: typeof fetch, api: string, token: string, threadId: string) {
  const result: any = await github(fetchImpl, api, token, '/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: 'query($thread:ID!){node(id:$thread){... on PullRequestReviewThread{id isResolved}}}',
      variables: { thread: threadId },
    }),
  });
  if (result.errors?.length) throw new Error(`GitHub GraphQL: ${JSON.stringify(result.errors)}`);
  if (!result.data.node) throw new Error(`${threadId} is no longer a review thread`);
  return result.data.node as { id: string; isResolved: boolean };
}

function formatNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatDuration(value: number) {
  let seconds = Math.round(value);
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return [hours && `${hours}h`, minutes && `${minutes}m`, `${seconds}s`].filter(Boolean).join(' ');
}

export function buildFooter({
  runUrl,
  workspaceUrl,
  model,
  thinkingLevel,
  durationSeconds,
  inputTokens,
  outputTokens,
  cost,
  piVersion,
  actionVersion,
}: FooterMetadata) {
  const parts = [`[View action run](${runUrl})`, `[审查工作稿](${workspaceUrl})`, `Model: ${model}`];
  if (thinkingLevel && thinkingLevel !== 'off') parts[2] += ` (thinking: ${thinkingLevel})`;
  if (Number.isFinite(durationSeconds)) parts.push(`Time: ${formatDuration(durationSeconds!)}`);
  if (Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) {
    parts.push(`Tokens: ${formatNumber(inputTokens! + outputTokens!)}`);
  }
  if (Number.isFinite(cost) && cost !== 0) parts.push(`Cost: $${Math.abs(cost!).toFixed(2)}`);
  if (piVersion) parts.push(`Pi SDK v${piVersion}`);
  if (actionVersion) parts.push(`Action v${actionVersion}`);
  return parts.join(' | ');
}

export async function publishReview({
  result,
  repository,
  pullNumber,
  botLogin,
  token,
  expectedHeadSha,
  footer,
  api,
  fetchImpl = fetch,
}: PublishOptions) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) throw new Error('Invalid repository');
  if (!Number.isInteger(pullNumber) || pullNumber < 1) throw new Error('Invalid pull number');
  if (!/^[A-Za-z0-9-]+\[bot\]$/.test(botLogin)) throw new Error('Invalid review bot login');
  if (!/^[0-9a-f]{40}$/.test(expectedHeadSha)) throw new Error('Invalid review head');

  const preparedUpdates: Array<{
    update: ReviewResult['thread_updates'][number];
    thread: ReviewThread;
    previousStatus?: string;
  }> = [];
  if (result.thread_updates.length) {
    const [comments, threads] = await Promise.all([
      reviewComments(fetchImpl, api, token, repository, pullNumber),
      reviewThreads(fetchImpl, api, token, repository, pullNumber),
    ]);
    for (const update of result.thread_updates) {
      const root = comments.find((comment) => comment.id === update.root_comment_id && comment.in_reply_to_id == null);
      const thread = threads.find((item) => item.comments.nodes[0]?.databaseId === update.root_comment_id);
      if (!root || !thread) throw new Error(`${update.root_comment_id} is not a root comment in this PR`);
      if (root.user?.login?.toLowerCase() !== botLogin.toLowerCase()) {
        throw new Error(`${update.root_comment_id} was not created by ${botLogin}`);
      }
      preparedUpdates.push({
        update,
        thread,
        previousStatus: comments
          .filter((comment) =>
            comment.in_reply_to_id === update.root_comment_id &&
            comment.user?.login?.toLowerCase() === botLogin.toLowerCase() &&
            comment.body.startsWith('**Pi thread 状态更新：'))
          .at(-1)?.body,
      });
    }
  }

  const review = await github<{ html_url: string }>(
    fetchImpl,
    api,
    token,
    `/repos/${repository}/pulls/${pullNumber}/reviews`,
    {
      method: 'POST',
      body: JSON.stringify({
        body: `${result.body}\n\n---\n\n${footer}`,
        commit_id: expectedHeadSha,
        event: 'COMMENT',
        comments: result.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: 'RIGHT',
          body: comment.body,
          ...(comment.start_line === null ? {} : { start_line: comment.start_line, start_side: 'RIGHT' }),
        })),
      }),
    },
  );

  for (const { update, thread, previousStatus } of preparedUpdates) {
    const status = `**Pi thread 状态更新：${statusLabels[update.status]}**`;
    if (!previousStatus?.startsWith(status)) {
      await github(
        fetchImpl,
        api,
        token,
        `/repos/${repository}/pulls/${pullNumber}/comments/${update.root_comment_id}/replies`,
        { method: 'POST', body: JSON.stringify({ body: `${status}\n\n${update.evidence}` }) },
      );
    }

    const shouldResolve = update.status === 'resolved';
    const currentThread = await reviewThreadState(fetchImpl, api, token, thread.id);
    if (currentThread.isResolved !== shouldResolve) {
      const mutation = shouldResolve
        ? 'mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id}}}'
        : 'mutation($thread:ID!){unresolveReviewThread(input:{threadId:$thread}){thread{id}}}';
      const response: any = await github(fetchImpl, api, token, '/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: mutation, variables: { thread: thread.id } }),
      });
      if (response.errors?.length) throw new Error(`GitHub GraphQL: ${JSON.stringify(response.errors)}`);
    }
  }
  return review.html_url;
}

function optionalNumber(value: string | undefined) {
  return value === undefined || value === '' ? undefined : Number(value);
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const result = parseReviewResult(await readFile(requiredEnv('REVIEW_RESULT_PATH'), 'utf8'));
  const footer = buildFooter({
    runUrl: requiredEnv('REVIEW_RUN_URL'),
    workspaceUrl: requiredEnv('REVIEW_WORKSPACE_URL'),
    model: requiredEnv('REVIEW_MODEL'),
    thinkingLevel: process.env.REVIEW_THINKING_LEVEL,
    durationSeconds: optionalNumber(process.env.REVIEW_DURATION_SECONDS),
    inputTokens: optionalNumber(process.env.REVIEW_INPUT_TOKENS),
    outputTokens: optionalNumber(process.env.REVIEW_OUTPUT_TOKENS),
    cost: optionalNumber(process.env.REVIEW_COST),
    piVersion: process.env.REVIEW_PI_VERSION,
    actionVersion: process.env.REVIEW_ACTION_VERSION,
  });
  const url = await publishReview({
    result,
    repository: requiredEnv('REPOSITORY'),
    pullNumber: Number(requiredEnv('PULL_NUMBER')),
    botLogin: requiredEnv('REVIEW_BOT_LOGIN'),
    token: requiredEnv('GH_TOKEN'),
    expectedHeadSha: requiredEnv('HEAD_SHA'),
    footer,
    api: process.env.GITHUB_API_URL ?? 'https://api.github.com',
  });
  console.log(`Published review: ${url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
