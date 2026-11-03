import timers from 'node:timers/promises';

export const maxServerRetryDelayMs = 120000;

type Message = { role: string; provider?: string; stopReason?: string; errorMessage?: string };
type Context = { signal?: AbortSignal; abort(): void };
type ExtensionAPI = {
  on(event: 'message_end', handler: (event: { message: Message }, ctx: Context) => { message: Message } | undefined): void;
  on(event: 'before_provider_request', handler: (event: unknown, ctx: Context) => Promise<void>): void;
};

export default function reviewRetry(pi: ExtensionAPI) {
  let retryAt = 0;

  pi.on('message_end', ({ message }, ctx) => {
    if (message.role !== 'assistant' || message.provider !== 'openai' || message.stopReason !== 'error') return;
    retryAt = 0;
    const error = message.errorMessage ?? '';
    // Pi 1.3.0 为 HTTP 错误保留此前缀。到达会话层时 provider 已耗尽重试，
    // 或拒绝了超过上限的服务端等待；保留原错误并停止，不能重新复制 HTTP 预算。
    if (/^OpenAI API error \(\d{3}\):|^Server requested \d+s retry delay/.test(error)) {
      ctx.abort();
      return;
    }
    if (!/Rate limit reached[\s\S]*on tokens per min \(TPM\):/i.test(error)) return;
    const hint = /Please try again in (\d+(?:\.\d+)?)(ms|s)\b/i.exec(error);
    if (hint) {
      const delay = Math.ceil(Number(hint[1]) * (hint[2].toLowerCase() === 'ms' ? 1 : 1000));
      if (delay > maxServerRetryDelayMs) {
        ctx.abort();
        return;
      }
      retryAt = Date.now() + delay;
    }
    // 仅替换帮助链接：Pi 原生分类器会把 URL 中的 billing 当成账单错误。
    // 正文中的 billing、insufficient_quota 等永久错误仍由 Pi 原样识别。
    const normalized = error.replace(/https:\/\/platform\.openai\.com\/account\/billing\b\S*/g, 'OpenAI 账单帮助页');
    if (normalized !== error) return { message: { ...message, errorMessage: normalized } };
  });

  pi.on('before_provider_request', async (_event, ctx) => {
    const delay = retryAt - Date.now();
    retryAt = 0;
    if (delay <= 0) return;
    console.info(`[review-retry] Waiting ${delay}ms for the provider rate limit to reset`);
    try {
      // Pi 已执行自己的指数退避；这里只补足服务端要求的剩余等待。
      await timers.setTimeout(delay, undefined, { signal: ctx.signal });
    } catch (error) {
      // Pi 会记录并吞掉普通 hook 异常；取消等待时同时中止请求。
      ctx.abort();
      throw error;
    }
  });
}
