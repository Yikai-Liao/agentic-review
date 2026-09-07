import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseReviewResult } from '../../scripts/review-result.ts';
import { readFile as readTextFile } from 'node:fs/promises';
import { persistReviewCoverage, validateReviewScope, type ReviewCoverage, type ReviewScope } from '../../scripts/review-request.ts';

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
        kind: { type: 'string', enum: ['pr', 'thread'] },
        mode: { type: 'string', enum: ['full', 'incremental', 'focused'] },
        rationale: { type: 'string', minLength: 1 },
        inherited_from_run: { type: ['string', 'null'] },
        explicit_text: { type: 'string' },
        targets: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
        comparison_start: { type: 'string', pattern: '^[0-9a-f]{40}$' },
        comparison_end: { type: 'string', pattern: '^[0-9a-f]{40}$' },
      },
      required: ['kind', 'mode', 'rationale', 'inherited_from_run', 'explicit_text', 'targets', 'comparison_start', 'comparison_end'],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, input: Omit<ReviewScope, 'id' | 'decided_at'>) {
      if (submitted) throw new Error('the review was already submitted');
      const workspace = process.env.REVIEW_WORKSPACE_PATH;
      const coveragePath = process.env.REVIEW_COVERAGE_PATH;
      if (!workspace || !coveragePath) throw new Error('Review scope paths are unavailable');
      const coverage = JSON.parse(await readTextFile(coveragePath, 'utf8')) as ReviewCoverage;
      const id = `${coverage.request.run_id}:${coverage.request.run_attempt}:scope`;
      const scope: ReviewScope = { ...input, id, decided_at: new Date().toISOString() };
      validateReviewScope(scope, coverage.request);
      const output = `${JSON.stringify({ ...coverage, scope, status: 'draft', completed_batches: coverage.completed_batches, complete_audit: false, updated_at: scope.decided_at })}\n`;
      await persistReviewCoverage(coveragePath, JSON.parse(output) as ReviewCoverage);
      return { content: [{ type: 'text', text: 'Review scope recorded.' }], details: { scope_id: id } };
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
      const parsed = parseReviewResult(content);
      const coveragePath = process.env.REVIEW_COVERAGE_PATH;
      if (coveragePath) {
        const coverage = JSON.parse(await readTextFile(coveragePath, 'utf8')) as ReviewCoverage;
        if (!coverage.scope) throw new Error('Review scope must be recorded before submit_review');
        validateReviewScope(coverage.scope, coverage.request);
        if (parsed.scope_id !== coverage.scope.id) throw new Error('Review result scope_id does not match recorded scope');
      }
      await writeFile(resultPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      submitted = true;

      return {
        content: [{ type: 'text', text: 'Review queued for trusted publication.' }],
        details: { queued: true, source: reviewPath },
      };
    },
  });
}
