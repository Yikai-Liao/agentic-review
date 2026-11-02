type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

type AssistantMessage = {
  role: 'assistant';
  provider: string;
  model: string;
  responseId?: string;
  stopReason: string;
  usage: Usage;
};

type ExtensionAPI = {
  on(event: 'before_provider_request', handler: (event: { payload: unknown }, ctx: {
    model?: { api: string };
  }) => Record<string, unknown> | undefined): void;
  on(event: 'turn_end', handler: (event: {
    turnIndex: number;
    message: { role: string };
  }) => void): void;
};

export default function reviewCost(pi: ExtensionAPI) {
  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.api !== 'openai-responses') return;
    // Pi 默认按随机 session ID 隔离缓存；中央 Review 的固定前缀需要跨 PR 复用。
    // 只替换缓存分组，保留 SDK 的会话标头、完整输入和缓存生命周期。
    return { ...event.payload as Record<string, unknown>, prompt_cache_key: 'agentic-review' };
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
  });
}
