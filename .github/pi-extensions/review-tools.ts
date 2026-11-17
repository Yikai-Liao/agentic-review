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
  // Timing starts when the agent starts; only the trusted extension judges the budget, and the model cannot declare it exhausted.
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

  // When the model tries to end without submitting: keep investigating within budget; after the budget, remind once more to submit, then fail truthfully.
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
    label: 'Record review scope',
    description: 'Write the agent\'s structured scope decision for this round\'s natural-language request into the review workspace.',
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
    label: 'Submit review',
    description: 'Takes the review result directly, validates it, saves a workspace copy, and seals it for the trusted publisher. Before the wrap-up notice full coverage is required; after it, partial conclusions with pending files are accepted. On failure, fix the arguments per the error and retry; queued: true means this round is done.',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', minLength: 1, description: 'The model-written part of the summary; the publisher generates the title, finding index, and footer.' },
        comments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', minLength: 1 },
              line: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }], description: 'Line in the PR diff; null when no diff line fits, publishing a file-level discussion on path, which must be a file changed by the PR.' },
              start_line: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
              label: { type: 'string', enum: Object.keys(findingLabels) },
              title: { type: 'string', minLength: 1, maxLength: 120, description: 'One-line title stating trigger and consequence; also used in the summary index.' },
              body: { type: 'string', minLength: 1, description: 'Body after the title; the publisher generates the alert and title line.' },
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
              evidence: { type: 'string', minLength: 10, maxLength: 500, description: 'One-line status reason, written into the status mark on the original finding\'s first line.' },
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
        // With full coverage, submission is allowed any time; with pending files, partial conclusions are rejected before the wrap-up notice.
        if (pending.length && phase() === 'investigate') {
          throw new Error(`Incomplete coverage: ${pending.length} files still pending, e.g. ${pending[0]}. Partial results are accepted only after the wrap-up notice; mark investigated files complete or continue the investigation.`);
        }
        if ((coverage.request.source === 'thread') !== (parsed.request_reply !== null)) throw new Error('Review request_reply does not match request source');
        if (parsed.comments.length) {
          const target = process.env.REVIEW_TARGET_PATH;
          if (!target) throw new Error('Review target path is unavailable');
          await validateCommentLines(target, coverage.request.comparison_start, coverage.request.head_sha, parsed.comments);
        }
        // Create the sealed file exclusively first so a failed concurrent call cannot overwrite the workspace copy.
        const sealed = await open(resultPath, 'wx', 0o600);
        try {
          try {
            await writeFile(path.join(workspace, 'review-result.json'), content, { encoding: 'utf8', mode: 0o600 });
            await sealed.writeFile(content, 'utf8');
          } finally {
            await sealed.close();
          }
        } catch (error) {
          // A failed write or close undoes this claim so a corrected retry is possible.
          await rm(resultPath);
          throw error;
        }
        submitted = true;

        return {
          content: [{ type: 'text', text: 'Review queued for trusted publication.' }],
          details: { queued: true },
        };
      } catch (error) {
        // JSON syntax errors may carry input fragments; report the structural error without echoing file content.
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
