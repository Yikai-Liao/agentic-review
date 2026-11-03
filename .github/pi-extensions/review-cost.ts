import { rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseReviewUsage, type ModelUsage, type ReviewUsage } from '../../scripts/review-usage.ts';

type AssistantMessage = {
  role: 'assistant';
  provider: string;
  model: string;
  responseId?: string;
  stopReason: string;
  usage: ModelUsage;
};

type ExtensionAPI = {
  on(event: 'before_agent_start', handler: (event: { prompt?: string }) => void): void;
  on(event: 'before_provider_request', handler: (event: { payload: unknown }, ctx: {
    model?: { api: string; compat?: { supportsExplicitPromptCacheMode?: boolean } };
    abort(): void;
  }) => Record<string, unknown> | undefined): void;
  on(event: 'provider_stream_event', handler: (event: { api: string; data: unknown }) => void): void;
  on(event: 'message_end', handler: (event: { message: { role: string } }, ctx: {
    abort(): void;
  }) => { message: AssistantMessage } | undefined): void;
  on(event: 'turn_end', handler: (event: {
    turnIndex: number;
    message: { role: string };
  }) => void): void;
};

export default function reviewCost(pi: ExtensionAPI) {
  let prompt: string | undefined;
  let firstRequest = true;
  let summary: ReviewUsage | undefined;
  let lifetimeAccounting = false;
  let cacheAccountingError: Error | undefined;
  let responseUsage: {
    id: string;
    usage: { input_tokens_details?: {
      cache_write_tokens?: number;
      cache_write_tokens_details?: { ttl_30m_tokens: number; ttl_12h_tokens: number };
    } };
  } | undefined;
  pi.on('before_agent_start', event => {
    prompt = event.prompt;
    firstRequest = true;
  });

  pi.on('before_provider_request', (event, ctx) => {
    responseUsage = undefined;
    lifetimeAccounting = false;
    if (ctx.model?.api !== 'openai-responses') return;
    const payload = event.payload as Record<string, unknown>;
    const result: Record<string, unknown> = { ...payload, prompt_cache_key: 'agentic-review' };
    if (!ctx.model.compat?.supportsExplicitPromptCacheMode) return result;
    lifetimeAccounting = true;
    // compaction 移除固定规则后仍需短期缓存参数，与生命周期统计保持同一契约。
    result.prompt_cache_options = { mode: 'implicit', ttl: '30m' };
    const input = payload.input as Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>;
    const index = Array.isArray(input) ? input.findIndex(message => message.role === 'user'
      && Array.isArray(message.content) && message.content.length === 1
      && message.content[0].type === 'input_text' && message.content[0].text === prompt) : -1;
    if (index === -1) {
      // 首次必须能定位规则；长审查 compaction 后原消息可能已被移除。
      if (firstRequest) {
        ctx.abort();
        throw new Error('Fixed review prompt is missing from the provider request');
      }
      return result;
    }
    if (firstRequest) {
      // 对实际发送的固定前缀取指纹；不记录规则、源码、请求正文或凭据。
      // 增量材料位于固定规则之后，不应改变这些指纹。
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
    // 新模型只给最新消息写 implicit 缓存；固定规则需要独立断点。
    // 仅固定前缀保留 12h；动态材料和后续工具交互继续使用 30m implicit 缓存。
    return { ...result,
      input: input.map((item, position) => position === index
        ? { ...message, content: [{ ...message.content![0], prompt_cache_breakpoint: { mode: 'explicit', ttl: '12h' } }] }
        : item) };
  });

  pi.on('provider_stream_event', event => {
    if (event.api !== 'openai-responses' || !lifetimeAccounting) return;
    const data = event.data as { response?: typeof responseUsage };
    if (data.response?.usage) responseUsage = data.response;
  });

  pi.on('message_end', ({ message: ended }, ctx) => {
    if (ended.role !== 'assistant' || !lifetimeAccounting) return;
    const message = ended as AssistantMessage;
    // 请求在返回 usage 前失败时，没有可校正的已报告用量。
    if (!responseUsage && message.usage.totalTokens === 0) return;
    try {
      const details = responseUsage?.usage.input_tokens_details;
      const writes = details?.cache_write_tokens_details;
      if (!writes || responseUsage?.id !== message.responseId
        || !Number.isSafeInteger(writes.ttl_30m_tokens) || writes.ttl_30m_tokens < 0
        || !Number.isSafeInteger(writes.ttl_12h_tokens) || writes.ttl_12h_tokens < 0
        || writes.ttl_30m_tokens + writes.ttl_12h_tokens !== message.usage.cacheWrite
        || details?.cache_write_tokens !== message.usage.cacheWrite) {
        throw new Error(`Missing or invalid OpenAI cache-write lifetime usage: ${JSON.stringify({
          responseId: message.responseId, usageResponseId: responseUsage?.id,
          cacheWrite: message.usage.cacheWrite, reportedCacheWrite: details?.cache_write_tokens,
          ttl30m: writes?.ttl_30m_tokens, ttl12h: writes?.ttl_12h_tokens,
        })}`);
      }
      const usage = structuredClone(message.usage);
      usage.cacheWrite12h = writes.ttl_12h_tokens;
      // Pi 1.3.0 将所有 OpenAI 写入按 30m 计价；12h 写入是其两倍。
      // 沿用 SDK 已选好的分档和服务档位价格，只补服务端报告的 12h 写入差额。
      const extra = usage.cacheWrite === 0 ? 0 : usage.cost.cacheWrite * writes.ttl_12h_tokens / usage.cacheWrite;
      usage.cost.cacheWrite += extra;
      usage.cost.total += extra;
      // 在 Pi 持久化与 Action 汇总前，使用官方 message_end 接口替换 usage。
      return { message: { ...message, usage } };
    } catch (error) {
      cacheAccountingError = error as Error;
      const workspace = process.env.REVIEW_WORKSPACE_PATH;
      if (workspace) rmSync(path.join(workspace, 'review-usage.json'), { force: true });
      ctx.abort();
      throw error;
    }
  });

  pi.on('turn_end', ({ turnIndex, message: ended }) => {
    if (cacheAccountingError) throw cacheAccountingError;
    if (ended.role !== 'assistant') return;
    const message = ended as AssistantMessage;
    const { input, output, cacheRead, cacheWrite, cacheWrite12h, reasoning, totalTokens, cost } = message.usage;
    // 使用 Pi 已按模型目录和服务档位计算的费用，不复制单价或输出会话正文。
    console.info('[review-usage]', JSON.stringify({
      turn: turnIndex,
      model: `${message.provider}/${message.model}`,
      responseId: message.responseId,
      stopReason: message.stopReason,
      tokens: { input, output, cacheRead, cacheWrite, cacheWrite12h, reasoning, total: totalTokens },
      cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite, total: cost.total },
    }));
    const usage = structuredClone(message.usage);
    if (!summary) summary = { turns: 1, first: usage, total: structuredClone(usage) };
    else {
      summary.turns++;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) summary.total[key] += usage[key];
      summary.total.cacheWrite12h = summary.total.cacheWrite12h === undefined || usage.cacheWrite12h === undefined
        ? undefined : summary.total.cacheWrite12h + usage.cacheWrite12h;
      // 部分 provider 不报告推理分项；缺失保持未知，不能写成零。
      summary.total.reasoning = summary.total.reasoning === undefined || usage.reasoning === undefined
        ? undefined : summary.total.reasoning + usage.reasoning;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) summary.total.cost[key] += usage.cost[key];
    }
    const workspace = process.env.REVIEW_WORKSPACE_PATH;
    if (!workspace) throw new Error('Review workspace is unavailable for usage statistics');
    // 只保存已有 SDK 统计，不保存正文，不调用模型；缺失或损坏会在发布时被拒绝。
    writeFileSync(path.join(workspace, 'review-usage.json'), `${JSON.stringify(parseReviewUsage(summary))}\n`, { mode: 0o600 });
  });
}
