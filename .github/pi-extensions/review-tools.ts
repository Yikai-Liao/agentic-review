import { appendFile, readFile } from 'node:fs/promises';
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
    description: 'Queue a detailed status change for trusted publication to an existing inline review thread.',
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

      const updatesPath = process.env.REVIEW_THREAD_UPDATES_PATH;
      if (!updatesPath || !path.isAbsolute(updatesPath)) {
        throw new Error('Review thread update path is unavailable');
      }
      await appendFile(
        updatesPath,
        `${JSON.stringify({
          root_comment_id: params.root_comment_id,
          status,
          evidence: params.evidence,
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      updatedThreads.add(params.root_comment_id);

      return {
        content: [{ type: 'text', text: 'Thread status update queued for trusted publication.' }],
        details: { status, queued: true },
      };
    },
  });
}
