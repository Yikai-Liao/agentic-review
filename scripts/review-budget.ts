// Central review time budget: the trusted extension keeps time, and the model only receives phase notices and can never declare the budget exhausted.
export type ReviewPhase = 'investigate' | 'wrap_up' | 'submit_only';

// The wrap-up phase is reserved for refreshing discussion, consolidating root causes, and submitting; after the deadline only submission is allowed.
export const wrapUpReserveSeconds = 180;

export function reviewBudgetSeconds(value: string | undefined): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= wrapUpReserveSeconds) {
    throw new Error(`REVIEW_TIME_BUDGET_SECONDS must be an integer greater than ${wrapUpReserveSeconds}`);
  }
  return seconds;
}

export function reviewPhase(startedAt: number | undefined, now: number, budgetSeconds: number): ReviewPhase {
  if (startedAt === undefined) return 'investigate';
  const elapsed = (now - startedAt) / 1000;
  if (elapsed >= budgetSeconds) return 'submit_only';
  return elapsed >= budgetSeconds - wrapUpReserveSeconds ? 'wrap_up' : 'investigate';
}

export const budgetMessages = {
  continue: '`submit_review` has not been called yet. When every entry in `review-progress.json` is complete, call `submit_review` now; while files are pending and no wrap-up notice has arrived, do not stop because the scope is large, time is short, or work is unfinished. Keep investigating in risk order and mark each finished group complete.',
  wrapUp: `The time budget has entered wrap-up; in about ${wrapUpReserveSeconds / 60} minutes only \`submit_review\` is allowed. Start no new investigation: run the discussion refresh script, consolidate conclusions for the reviewed part from the evidence you have, keep unfinished files pending, then call \`submit_review\`. The publisher lists unreviewed files from file progress, so the body need not restate coverage.`,
  submitNow: 'The time budget is exhausted and every tool except `submit_review` is rejected. Call `submit_review` now with the evidence you have; keep unfinished files pending.',
} as const;
