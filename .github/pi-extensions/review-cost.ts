import { writeFileSync } from 'node:fs';
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
  on(event: 'turn_end', handler: (event: {
    turnIndex: number;
    message: { role: string };
  }) => void): void;
};

export default function reviewCost(pi: ExtensionAPI) {
  let prompt: string | undefined;
  let firstRequest = true;
  let summary: ReviewUsage | undefined;
  pi.on('before_agent_start', event => {
    prompt = event.prompt;
    firstRequest = true;
  });

  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.api !== 'openai-responses') return;
    const payload = event.payload as Record<string, unknown>;
    const result = { ...payload, prompt_cache_key: 'agentic-review' };
    if (!ctx.model.compat?.supportsExplicitPromptCacheMode) return result;
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
    firstRequest = false;
    const message = input[index];
    // 新模型只给最新消息写 implicit 缓存；固定规则需要独立断点。
    // 保留 implicit 模式与默认 TTL，后续工具交互仍复用增长中的前缀。
    return { ...result, input: input.map((item, position) => position === index
      ? { ...message, content: [{ ...message.content![0], prompt_cache_breakpoint: { mode: 'explicit' } }] }
      : item) };
  });

  pi.on('turn_end', ({ turnIndex, message: ended }) => {
    if (ended.role !== 'assistant') return;
    const message = ended as AssistantMessage;
    const { input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost } = message.usage;
    // 使用 Pi 已按模型目录和服务档位计算的费用，不复制单价或输出会话正文。
    console.info('[review-usage]', JSON.stringify({
      turn: turnIndex,
      model: `${message.provider}/${message.model}`,
      responseId: message.responseId,
      stopReason: message.stopReason,
      tokens: { input, output, cacheRead, cacheWrite, reasoning, total: totalTokens },
      cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite, total: cost.total },
    }));
    const usage = structuredClone(message.usage);
    if (!summary) summary = { turns: 1, first: usage, total: structuredClone(usage) };
    else {
      summary.turns++;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) summary.total[key] += usage[key];
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
