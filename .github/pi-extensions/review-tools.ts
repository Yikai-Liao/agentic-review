import { open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { findingLabels, parseReviewResult, type ReviewResult } from '../../scripts/review-result.ts';
import { validateCommentLines } from '../../scripts/review-diff-lines.ts';
import { pendingCoverage, readReviewProgress } from '../../scripts/review-coverage.ts';
import { budgetMessages, reviewBudgetSeconds, reviewPhase } from '../../scripts/review-budget.ts';
import { persistReviewProgress, validateReviewScope, type ReviewScopeDecision } from '../../scripts/review-request.ts';

type BoundaryResult = {
  entries: Array<{ type: 'custom_message'; customType: string; content: string; display: boolean }>;
  continue: true;
} | undefined;

type ExtensionAPI = {
  registerTool(tool: {
    name: string;
    [key: string]: unknown;
    execute: (...args: any[]) => Promise<unknown>;
  }): void;
  on(event: 'agent_start', handler: () => void): void;
  on(event: 'turn_end' | 'agent_before_settle', handler: (event: { outcome: string }) => BoundaryResult): void;
  on(event: 'tool_call', handler: (event: { toolName: string }) => { block: true; reason: string } | undefined): void;
};

const notice = (content: string): BoundaryResult => ({
  entries: [{ type: 'custom_message', customType: 'review-budget', content, display: false }],
  continue: true,
});

export default function reviewTools(pi: ExtensionAPI, now = Date.now) {
  let submitted = false;
  // 计时从 Agent 启动开始；预算只由可信扩展判断，模型不能自行宣布用尽。
  const budget = reviewBudgetSeconds(process.env.REVIEW_TIME_BUDGET_SECONDS);
  let startedAt: number | undefined;
  let wrapUpSent = false;
  let submitNowSent = false;
  const phase = () => reviewPhase(startedAt, now(), budget);

  pi.on('agent_start', () => { startedAt ??= now(); });

  pi.on('turn_end', () => {
    if (submitted || wrapUpSent || phase() === 'investigate') return undefined;
    wrapUpSent = true;
    return notice(budgetMessages.wrapUp);
  });

  // 模型未提交就要结束时：预算内继续调查；预算用尽后只再提醒一次提交，仍不提交则如实失败。
  pi.on('agent_before_settle', (event) => {
    if (submitted || event.outcome !== 'completed') return undefined;
    const current = phase();
    if (current === 'investigate') return notice(budgetMessages.continue);
    if (current === 'wrap_up') {
      wrapUpSent = true;
      return notice(budgetMessages.wrapUp);
    }
    if (submitNowSent) return undefined;
    submitNowSent = true;
    return notice(budgetMessages.submitNow);
  });

  pi.on('tool_call', (event) => {
    if (submitted || event.toolName === 'submit_review' || phase() !== 'submit_only') return undefined;
    return { block: true, reason: budgetMessages.submitNow };
  });

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
          if (entry.status === 'out_of_scope') entry.status = 'pending';
        }
      }
      await persistReviewProgress(progressPath, { scope: input, ledger: coverage.ledger });
      return { content: [{ type: 'text', text: 'Review scope recorded.' }] };
    },
  });

  pi.registerTool({
    name: 'submit_review',
    label: '提交 Review',
    description: '直接接收审查结果，校验后保存工作稿副本并封存，交给可信发布器。收尾通知前要求完整覆盖；收尾后接受保留 pending 的部分结论。失败时按具体错误修正参数后重试；queued: true 即本轮完成。',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', minLength: 1, description: '总评中由模型撰写的部分；标题、问题索引和页脚由发布器生成。' },
        comments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', minLength: 1 },
              line: { type: 'integer', minimum: 1 },
              start_line: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
              label: { type: 'string', enum: Object.keys(findingLabels) },
              title: { type: 'string', minLength: 1, maxLength: 120, description: '一行标题，写触发与后果；同时用作总评索引。' },
              body: { type: 'string', minLength: 1, description: '标题之后的正文；Alert 和标题行由发布器生成。' },
            },
            required: ['path', 'line', 'start_line', 'label', 'title', 'body'],
            additionalProperties: false,
          },
        },
        thread_updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              root_comment_id: { type: 'integer', minimum: 1 },
              status: { type: 'string', enum: ['resolved', 'severity_increased', 'reintroduced'] },
              evidence: { type: 'string', minLength: 10, maxLength: 500, description: '一行状态原因，写进原问题首行的状态标注。' },
            },
            required: ['root_comment_id', 'status', 'evidence'],
            additionalProperties: false,
          },
        },
        request_reply: { anyOf: [
          { type: 'object', properties: { body: { type: 'string', minLength: 1 } }, required: ['body'], additionalProperties: false },
          { type: 'null' },
        ] },
      },
      required: ['body', 'comments', 'thread_updates', 'request_reply'],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, input: ReviewResult) {
      try {
        if (submitted) throw new Error('the review was already submitted');

        const workspace = process.env.REVIEW_WORKSPACE_PATH;
        const resultPath = process.env.REVIEW_RESULT_PATH;
        if (!workspace || !path.isAbsolute(workspace) || !resultPath || !path.isAbsolute(resultPath)) {
          throw new Error('Review paths are unavailable');
        }

        const content = `${JSON.stringify(input)}\n`;
        const parsed = parseReviewResult(content);
        const progressPath = process.env.REVIEW_PROGRESS_PATH;
        const contextPath = process.env.REVIEW_CONTEXT_PATH;
        if (!contextPath || !progressPath) throw new Error('Review context or progress path is unavailable');
        const coverage = await readReviewProgress(contextPath, progressPath);
        if (!coverage.scope) throw new Error('Review scope must be recorded before submit_review');
        const pending = pendingCoverage(coverage, process.env.REVIEW_INVENTORY_DIGEST ?? '');
        // 覆盖完整时任何时刻都可提交；仍有 pending 时，收尾通知前不接受部分结论。
        if (pending.length && phase() === 'investigate') {
          throw new Error(`Incomplete coverage: ${pending.length} files still pending, e.g. ${pending[0]}. Partial results are accepted only after the wrap-up notice; mark investigated files complete or continue the investigation.`);
        }
        if ((coverage.request.source === 'thread') !== (parsed.request_reply !== null)) throw new Error('Review request_reply does not match request source');
        if (parsed.comments.length) {
          const target = process.env.REVIEW_TARGET_PATH;
          if (!target) throw new Error('Review target path is unavailable');
          await validateCommentLines(target, coverage.request.comparison_start, coverage.request.head_sha, parsed.comments);
        }
        // 先独占创建封存文件，失败的并发调用不能覆盖工作稿副本。
        const sealed = await open(resultPath, 'wx', 0o600);
        try {
          try {
            await writeFile(path.join(workspace, 'review-result.json'), content, { encoding: 'utf8', mode: 0o600 });
            await sealed.writeFile(content, 'utf8');
          } finally {
            await sealed.close();
          }
        } catch (error) {
          // 写入或关闭失败都撤销本次占位，允许修正后重试。
          await rm(resultPath);
          throw error;
        }
        submitted = true;

        return {
          content: [{ type: 'text', text: 'Review queued for trusted publication.' }],
          details: { queued: true },
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
