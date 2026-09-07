import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseReviewResult } from '../../scripts/review-result.ts';
import { readReviewThreads } from '../../scripts/read-review-threads.ts';

type ExtensionAPI = {
  registerTool(tool: {
    name: string;
    [key: string]: unknown;
    execute: (...args: any[]) => Promise<unknown>;
  }): void;
};

export default function reviewTools(pi: ExtensionAPI, readThreads = readReviewThreads) {
  let submitted = false;
  let threadsRefreshed = false;

  pi.registerTool({
    name: 'refresh_review_threads',
    label: '刷新 Review 讨论',
    description: '代码调查完成后、生成最终 JSON 前调用；只读获取当前 PR 全部 thread 状态和完整回复，按最新决定归纳历史问题。',
    parameters: { type: 'object', properties: {}, additionalProperties: false } as any,
    async execute() {
      if (submitted) throw new Error('the review was already submitted');
      threadsRefreshed = false;
      const threads = await readThreads();
      threadsRefreshed = true;
      return { content: [{ type: 'text', text: JSON.stringify(threads) }], details: { refreshed: true } };
    },
  });

  pi.registerTool({
    name: 'submit_review',
    label: '提交 Review',
    description: '校验并封存私有 Review 工作区内的最终 JSON；校验失败时按中央协议修正后重试，成功后交给可信发布器。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description: 'REVIEW_WORKSPACE_PATH 内最终 JSON 文件的路径。',
        },
      },
      required: ['path'],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, { path: inputPath }: { path: string }) {
      if (submitted) throw new Error('the review was already submitted');

      const workspace = process.env.REVIEW_WORKSPACE_PATH;
      const resultPath = process.env.REVIEW_RESULT_PATH;
      if (!workspace || !path.isAbsolute(workspace) || !resultPath || !path.isAbsolute(resultPath)) {
        throw new Error('Review paths are unavailable');
      }

      const workspacePath = await realpath(workspace);
      const reviewPath = await realpath(path.resolve(inputPath));
      const relative = path.relative(workspacePath, reviewPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Review file must be inside REVIEW_WORKSPACE_PATH');
      }

      const info = await stat(reviewPath);
      if (!info.isFile() || info.size > 1_000_000) throw new Error('Review file must be a regular file no larger than 1 MB');
      const content = await readFile(reviewPath, 'utf8');
      parseReviewResult(content);
      if (!threadsRefreshed) throw new Error('Call refresh_review_threads and reconcile the latest replies before submitting');
      await writeFile(resultPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      submitted = true;

      return {
        content: [{ type: 'text', text: 'Review queued for trusted publication.' }],
        details: { queued: true, source: reviewPath },
      };
    },
  });
}
