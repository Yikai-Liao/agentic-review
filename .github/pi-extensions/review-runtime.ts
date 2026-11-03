type ExtensionAPI = {
  on(event: 'session_compact_failed', handler: (event: unknown, ctx: { abort(): void }) => void): void;
};

export default function reviewRuntime(pi: ExtensionAPI) {
  // Pi 已完成摘要重试后仍失败时中止审查，保留既有的不完整上下文保护。
  pi.on('session_compact_failed', (_event, ctx) => ctx.abort());
}
