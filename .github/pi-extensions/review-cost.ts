import { rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { findCatalogCost, type CatalogModel, type ModelCost } from '../../scripts/review-pricing.ts';
import { parseReviewUsage, type ModelUsage, type ReviewUsage } from '../../scripts/review-usage.ts';

type AssistantMessage = {
  role: 'assistant';
  usage: ModelUsage;
};

type ExtensionAPI = {
  on(event: 'before_agent_start', handler: (event: { prompt?: string }) => void): void;
  on(event: 'before_provider_request', handler: (event: { payload: unknown }, ctx: {
    model?: { id: string; api: string; cost: ModelCost; compat?: { supportsExplicitPromptCacheMode?: boolean } };
    modelRegistry: { getAll(): readonly CatalogModel[] };
    abort(): void;
  }) => Record<string, unknown> | undefined): void;
  on(event: 'message_end', handler: (event: { message: { role: string } }, ctx: {
    abort(): void;
  }) => void): void;
  on(event: 'turn_end', handler: (event: { message: { role: string } }) => void): void;
};

export default function reviewCost(pi: ExtensionAPI) {
  let prompt: string | undefined;
  let firstRequest = true;
  let summary: ReviewUsage | undefined;
  let usageError: Error | undefined;
  pi.on('before_agent_start', event => {
    prompt = event.prompt;
    firstRequest = true;
  });

  let priced = false;
  let priceKnown = true;
  pi.on('before_provider_request', (event, ctx) => {
    if (!priced && ctx.model) {
      // Explicitly registered models have no price; take catalog prices before the first request, after which the SDK prices by model.cost and tiers as usual.
      // Without a catalog entry the review still runs, but cost must be marked unknown, never shown as 0.
      const cost = findCatalogCost(ctx.model.id, ctx.modelRegistry.getAll());
      if (cost) ctx.model.cost = cost;
      else console.info('[review-price-missing]', ctx.model.id);
      priceKnown = cost !== undefined;
      priced = true;
    }
    if (ctx.model?.api !== 'openai-responses') return;
    const payload = event.payload as Record<string, unknown>;
    const result: Record<string, unknown> = { ...payload, prompt_cache_key: 'agentic-review' };
    if (!ctx.model.compat?.supportsExplicitPromptCacheMode) return result;
    // After compaction removes the fixed rules, the short-term cache parameter must still be kept explicitly.
    result.prompt_cache_options = { mode: 'implicit', ttl: '30m' };
    const input = payload.input as Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>;
    const index = Array.isArray(input) ? input.findIndex(message => message.role === 'user'
      && Array.isArray(message.content) && message.content.length === 1
      && message.content[0].type === 'input_text'
      && message.content[0].text === prompt) : -1;
    if (index === -1) {
      // The first request must locate the rules; after compaction in long reviews the original message may be gone.
      if (firstRequest) {
        ctx.abort();
        throw new Error('Fixed review prompt is missing from the provider request');
      }
      return result;
    }
    if (firstRequest) {
      // Fingerprint the fixed prefix actually sent; never log rules, source, request bodies, or credentials.
      // Incremental material sits after the fixed rules and must not change these fingerprints.
      const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
      const prefix = { model: payload.model, instructions: payload.instructions, tools: payload.tools,
        parallel_tool_calls: payload.parallel_tool_calls, reasoning: payload.reasoning, text: payload.text,
        service_tier: payload.service_tier, prompt_cache_key: result.prompt_cache_key, input: input.slice(0, index + 1) };
      console.info('[review-cache-prefix]', JSON.stringify({
        model: payload.model, prefix: digest(prefix), tools: digest(payload.tools),
        system: digest(input.slice(0, index)), rules: digest(input[index]),
      }));
    }
    firstRequest = false;
    const message = input[index];
    // New models write implicit cache only for the latest message; the fixed rules need their own breakpoint.
    // Only the fixed prefix is kept 12h; dynamic material and later tool interaction keep the 30m implicit cache.
    return { ...result,
      input: input.map((item, position) => position === index
        ? { ...message, content: [{ ...message.content![0], prompt_cache_breakpoint: { mode: 'explicit', ttl: '12h' } }] }
        : item) };
  });

  pi.on('message_end', ({ message: ended }, ctx) => {
    if (ended.role !== 'assistant') return;
    try {
      const usage = (ended as AssistantMessage).usage;
      // The gateway does not distinguish write TTLs; keep the SDK's official catalog estimate, since caching policy does not decide pricing.
      // Validate only the standard statistics already present; the gateway need not return lifetime fields.
      parseReviewUsage({ turns: 1, priceKnown, first: usage, total: usage });
    } catch (error) {
      usageError = error as Error;
      const workspace = process.env.REVIEW_WORKSPACE_PATH;
      if (workspace) rmSync(path.join(workspace, 'review-usage.json'), { force: true });
      ctx.abort();
      throw error;
    }
  });

  pi.on('turn_end', ({ message: ended }) => {
    if (usageError) throw usageError;
    if (ended.role !== 'assistant') return;
    // Per-turn details are already in the session JSONL assistant messages; only accumulate here, never log them.
    const usage = structuredClone((ended as AssistantMessage).usage);
    if (!summary) summary = { turns: 1, priceKnown, first: usage, total: structuredClone(usage) };
    else {
      summary.turns++;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) summary.total[key] += usage[key];
      // Some providers do not report reasoning separately; keep it unknown rather than zero.
      summary.total.reasoning = summary.total.reasoning === undefined || usage.reasoning === undefined
        ? undefined : summary.total.reasoning + usage.reasoning;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) summary.total.cost[key] += usage.cost[key];
    }
    const workspace = process.env.REVIEW_WORKSPACE_PATH;
    if (!workspace) throw new Error('Review workspace is unavailable for usage statistics');
    // Save only existing SDK statistics, no text and no model calls; missing or corrupt data is rejected at publication.
    writeFileSync(path.join(workspace, 'review-usage.json'), `${JSON.stringify(parseReviewUsage(summary))}\n`, { mode: 0o600 });
  });
}
