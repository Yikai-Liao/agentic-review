import timers from 'node:timers/promises';

export const maxServerRetryDelayMs = 120000;
export const maxStreamRetries = 3;

type Message = { role: string; provider?: string; stopReason?: string; errorMessage?: string };
type Context = { signal?: AbortSignal; abort(): void };
type BoundaryEntry = { sourceEntry: { id: string }; messages: Message[] };
type Boundary = {
  outcome: string;
  entries: unknown[];
  context: { contextMessages: Message[]; contextEntries: BoundaryEntry[] };
};
type ExtensionAPI = {
  on(event: 'before_agent_start', handler: () => void): void;
  on(event: 'message_end', handler: (event: { message: Message }) => void): void;
  on(event: 'agent_before_settle', handler: (event: Boundary) => { continue: true; entries: unknown[] } | undefined): void;
  on(event: 'before_provider_request', handler: (event: unknown, ctx: Context) => Promise<void>): void;
  on(event: 'session_before_compact', handler: (event: { signal: AbortSignal }, ctx: Context) => Promise<void>): void;
  on(event: 'session_compact_failed', handler: (event: unknown, ctx: Context) => void): void;
};

export default function reviewRetry(pi: ExtensionAPI) {
  let retryAt = 0;
  let retries = 0;
  let compactionFailed = false;

  pi.on('before_agent_start', () => {
    retryAt = 0;
    retries = 0;
    compactionFailed = false;
  });

  pi.on('message_end', ({ message }) => {
    if (message.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted') retries = 0;
  });

  pi.on('agent_before_settle', event => {
    if (event.outcome !== 'error' || compactionFailed || retries >= maxStreamRetries) return;
    const message = [...event.context.contextMessages].reverse().find(item => item.role === 'assistant');
    if (message?.provider !== 'openai' || message.stopReason !== 'error') return;
    const error = message.errorMessage ?? '';
    // HTTP 错误由 provider 处理；普通回合才在公开会话边界恢复流内 TPM 失败。
    // 不能开启全局会话重试：Pi 1.3.0 的摘要调用会继承它并重复 HTTP 预算。
    if (/^OpenAI API error \(\d{3}\):|^Server requested \d+s retry delay/.test(error)) return;
    if (!/Rate limit reached[\s\S]*on tokens per min \(TPM\):/i.test(error)) return;
    // 帮助链接不能充当账单错误证据；保留原错误，只在分类时排除 URL。
    const body = error.replace(/https?:\/\/\S+/g, '');
    if (/insufficient_quota|billing|quota exceeded|out of budget/i.test(body)) return;
    const hint = /Please try again in (\d+(?:\.\d+)?)(ms|s)\b/i.exec(error);
    const delay = hint ? Math.ceil(Number(hint[1]) * (hint[2].toLowerCase() === 'ms' ? 1 : 1000)) : 2000 * 2 ** retries;
    if (delay > maxServerRetryDelayMs) return;
    const failed = [...event.context.contextEntries].reverse().find(entry => entry.messages.includes(message));
    if (!failed) return;
    retries++;
    retryAt = Date.now() + delay;
    // Pi 提交 context_edit 并原生继续，不注入提示，也不重放已完成的工具调用。
    return { continue: true, entries: [...event.entries,
      { type: 'context_edit', targetId: failed.sourceEntry.id, replacement: null }] };
  });

  async function wait(signal: AbortSignal | undefined, ctx: Context) {
    const delay = retryAt - Date.now();
    retryAt = 0;
    if (delay <= 0) return;
    console.info(`[review-retry] Waiting ${delay}ms before resuming the model request (${retries}/${maxStreamRetries})`);
    try {
      await timers.setTimeout(delay, undefined, { signal });
    } catch (error) {
      // Pi 会记录并吞掉普通 hook 异常；取消等待时同时中止请求。
      ctx.abort();
      throw error;
    }
  }

  pi.on('before_provider_request', (_event, ctx) => wait(ctx.signal, ctx));
  // 会话继续前可能先压缩；摘要同样必须等满已有的 TPM 等待提示。
  pi.on('session_before_compact', (event, ctx) => wait(event.signal, ctx));
  pi.on('session_compact_failed', (_event, ctx) => {
    compactionFailed = true;
    ctx.abort();
  });
}
