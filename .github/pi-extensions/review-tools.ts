import { appendFile } from 'node:fs/promises';
import path from 'node:path';

type ExtensionAPI = {
  registerTool(tool: {
    name: string;
    [key: string]: unknown;
    execute: (...args: any[]) => Promise<unknown>;
  }): void;
};

type Update = {
  root_comment_id: number;
  status: 'suggest_resolve' | 'severity_increased' | 'reintroduced';
  evidence: string;
};

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
    async execute(_toolCallId, params: Update) {
      if (updatedThreads.has(params.root_comment_id)) {
        throw new Error('this thread was already updated during the current review');
      }
      const updatesPath = process.env.REVIEW_THREAD_UPDATES_PATH;
      if (!updatesPath || !path.isAbsolute(updatesPath)) {
        throw new Error('Review thread update path is unavailable');
      }
      await appendFile(updatesPath, `${JSON.stringify(params)}\n`, { encoding: 'utf8', mode: 0o600 });
      updatedThreads.add(params.root_comment_id);

      return {
        content: [{ type: 'text', text: 'Thread status update queued for trusted publication.' }],
        details: { status: params.status, queued: true },
      };
    },
  });
}
