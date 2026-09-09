import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseReviewResult } from '../../scripts/review-result.ts';
import { readReviewProgress, validateCoverageCompletion } from '../../scripts/review-coverage.ts';
import { persistReviewProgress, validateReviewScope, type ReviewScopeDecision } from '../../scripts/review-request.ts';

type ExtensionAPI = {
  registerTool(tool: {
    name: string;
    [key: string]: unknown;
    execute: (...args: any[]) => Promise<unknown>;
  }): void;
};

export default function reviewTools(pi: ExtensionAPI) {
  let submitted = false;

  pi.registerTool({
    name: 'set_review_scope',
    label: '记录审查范围',
    description: '把 Agent 对本轮自然语言请求的结构化范围判断及时写入 Review 工作区。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['full', 'incremental', 'focused'] },
        rationale: { type: 'string', minLength: 1 },
        explicit_text: { type: 'string' },
        ranges: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: {
              targets: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
              comparison_start: { type: 'string', pattern: '^[0-9a-f]{40}$' },
              comparison_end: { type: 'string', pattern: '^[0-9a-f]{40}$' },
            },
            required: ['targets', 'comparison_start', 'comparison_end'],
            additionalProperties: false,
          },
        },
      },
      required: ['mode', 'rationale', 'explicit_text', 'ranges'],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, input: ReviewScopeDecision) {
      if (submitted) throw new Error('the review was already submitted');
      const workspace = process.env.REVIEW_WORKSPACE_PATH;
      const contextPath = process.env.REVIEW_CONTEXT_PATH;
      const progressPath = process.env.REVIEW_PROGRESS_PATH;
      if (!workspace || !contextPath || !progressPath) throw new Error('Review scope paths are unavailable');
      const coverage = await readReviewProgress(contextPath, progressPath);
      if (Object.keys(input).sort().join(',') !== 'explicit_text,mode,ranges,rationale') throw new Error('Invalid review scope decision fields');
      const scope = { ...input, kind: coverage.request.source === 'thread' ? 'thread' as const : 'pr' as const };
      validateReviewScope(scope, coverage.request);
      if (scope.mode !== coverage.scope?.mode || !isDeepStrictEqual(scope.ranges, coverage.scope?.ranges)) {
        for (const entry of coverage.ledger) {
          if (entry.status === 'out_of_scope') { entry.status = 'pending'; entry.batches = []; }
        }
      }
      await persistReviewProgress(progressPath, { scope: input, ledger: coverage.ledger });
      return { content: [{ type: 'text', text: 'Review scope recorded.' }] };
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
      try {
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
        const parsed = parseReviewResult(content);
        const progressPath = process.env.REVIEW_PROGRESS_PATH;
        const contextPath = process.env.REVIEW_CONTEXT_PATH;
        if (!contextPath || !progressPath) throw new Error('Review context or progress path is unavailable');
        const coverage = await readReviewProgress(contextPath, progressPath);
        if (!coverage.scope) throw new Error('Review scope must be recorded before submit_review');
        await validateCoverageCompletion(coverage, workspacePath, process.env.REVIEW_INVENTORY_DIGEST ?? '');
        if ((coverage.request.source === 'thread') !== (parsed.request_reply !== null)) throw new Error('Review request_reply does not match request source');
        await writeFile(resultPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        submitted = true;

        return {
          content: [{ type: 'text', text: 'Review queued for trusted publication.' }],
          details: { queued: true, source: reviewPath },
        };
      } catch (error) {
        // JSON 语法错误可能携带输入片段；反馈结构错误，不回显文件内容。
        const message = error instanceof SyntaxError ? 'Invalid JSON syntax in review result or progress.'
          : error instanceof Error ? error.message : 'Unknown review submission error';
        return {
          content: [{ type: 'text', text: `Review submission failed: ${message}` }],
          details: { queued: false, error: message },
          isError: true,
        };
      }
    },
  });
}
