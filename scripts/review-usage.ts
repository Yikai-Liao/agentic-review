export const reviewMetadataStart = '<!-- agentic-review:run-metadata -->';
export const reviewMetadataEnd = '<!-- /agentic-review:run-metadata -->';

export type ModelUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite12h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export type ReviewUsage = { turns: number; first: ModelUsage; total: ModelUsage };

export function parseReviewUsage(value: unknown): ReviewUsage {
  const summary = value as ReviewUsage | null;
  if (!summary || !Number.isSafeInteger(summary.turns) || summary.turns < 1) throw new Error('Invalid review usage');
  for (const usage of [summary.first, summary.total]) {
    if (!usage) throw new Error('Missing review usage');
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
      if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new Error('Invalid review token usage');
    }
    if (usage.reasoning !== undefined && (!Number.isSafeInteger(usage.reasoning) || usage.reasoning < 0 || usage.reasoning > usage.output)) {
      throw new Error('Invalid review reasoning usage');
    }
    if (usage.cacheWrite12h !== undefined && (!Number.isSafeInteger(usage.cacheWrite12h)
      || usage.cacheWrite12h < 0 || usage.cacheWrite12h > usage.cacheWrite)) {
      throw new Error('Invalid review cache-write lifetime usage');
    }
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
      if (!Number.isFinite(usage.cost?.[key]) || usage.cost[key] < 0) throw new Error('Invalid review usage cost');
    }
  }
  return summary;
}
