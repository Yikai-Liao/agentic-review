import { readFile } from 'node:fs/promises';
import path from 'node:path';

type ExtensionAPI = {
  registerTool(tool: {
    name: string;
    [key: string]: unknown;
    execute: (...args: any[]) => Promise<unknown>;
  }): void;
};

const statusLabels = {
  suggest_resolve: '✅ 建议关闭',
  severity_increased: '⚠️ 风险升级',
  reintroduced: '🔁 问题重现',
} as const;

type Status = keyof typeof statusLabels;
type Thread = { id: string; isResolved: boolean; rootCommentId: number | null };
type Comment = { id: number; inReplyToId?: number | null; body: string };

function discussionFile(name: string): string {
  const directory = process.env.REVIEW_DISCUSSION_PATH;
  if (!directory || !path.isAbsolute(directory)) throw new Error('Review discussion path is unavailable');
  return path.join(directory, name);
}

async function readNdjson<T>(name: string): Promise<T[]> {
  return (await readFile(discussionFile(name), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export default function reviewTools(pi: ExtensionAPI) {
  const updatedThreads = new Set<number>();

  pi.registerTool({
    name: 'reply_to_review_thread',
    label: 'Reply to review thread',
    description: 'Post a detailed status change to an existing inline review thread. Cannot resolve a thread.',
    parameters: {
      type: 'object',
      properties: {
        root_comment_id: { type: 'integer', minimum: 1 },
        status: {
          type: 'string',
          enum: ['suggest_resolve', 'severity_increased', 'reintroduced'],
        },
        evidence: { type: 'string', minLength: 10, maxLength: 5000 },
      },
      required: ['root_comment_id', 'status', 'evidence'],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const threads = await readNdjson<Thread>('threads.ndjson');
      const comments = await readNdjson<Comment>('review-comments.ndjson');
      const thread = threads.find((item) => item.rootCommentId === params.root_comment_id);
      const root = comments.find(
        (comment) => comment.id === params.root_comment_id && !comment.inReplyToId,
      );
      if (!thread || !root) throw new Error('root_comment_id is not a root inline comment in the current PR');
      if (updatedThreads.has(params.root_comment_id)) throw new Error('this thread was already updated during the current review');
      if (thread.isResolved && params.status === 'suggest_resolve') {
        throw new Error('this thread is already resolved');
      }

      const status = params.status as Status;
      const previousStatus = comments
        .filter(
          (comment) =>
            comment.inReplyToId === params.root_comment_id &&
            comment.body.startsWith('**Pi thread 状态更新：'),
        )
        .at(-1)?.body;
      if (previousStatus?.startsWith(`**Pi thread 状态更新：${statusLabels[status]}**`)) {
        throw new Error('the requested thread status has not changed');
      }

      const token = process.env.INPUT_GITHUB_TOKEN;
      const repository = process.env.GITHUB_REPOSITORY;
      const pullNumber = process.env.REVIEW_PULL_NUMBER;
      if (!token || !repository || !pullNumber) throw new Error('GitHub review context is unavailable');

      const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
      const response = await fetch(
        `${api}/repos/${repository}/pulls/${pullNumber}/comments/${params.root_comment_id}/replies`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            body: `**Pi thread 状态更新：${statusLabels[status]}**\n\n${params.evidence}`,
          }),
        },
      );
      if (!response.ok) throw new Error(`GitHub reply failed: ${response.status} ${await response.text()}`);

      const result = (await response.json()) as { html_url: string };
      updatedThreads.add(params.root_comment_id);
      const shouldReopen = thread.isResolved && status !== 'suggest_resolve';
      if (shouldReopen) {
        const reopenResponse = await fetch(`${api}/graphql`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: 'mutation($thread:ID!){unresolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}',
            variables: { thread: thread.id },
          }),
        });
        const reopenResult = (await reopenResponse.json()) as { errors?: Array<{ message: string }> };
        if (!reopenResponse.ok || reopenResult.errors?.length) {
          throw new Error(`GitHub reopen failed: ${reopenResponse.status} ${JSON.stringify(reopenResult.errors)}`);
        }
      }

      return {
        content: [{ type: 'text', text: `Thread updated${shouldReopen ? ' and reopened' : ''}: ${result.html_url}` }],
        details: { status, reopened: shouldReopen, url: result.html_url },
      };
    },
  });
}
