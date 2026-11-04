type ExtensionAPI = {
  on(event: 'session_compact_failed', handler: (event: { errorMessage?: string }, ctx: { abort(): void }) => void): void;
};

export default function reviewRuntime(pi: ExtensionAPI) {
  // Pi 已完成摘要重试后仍失败时中止审查，保留既有的不完整上下文保护；先记录原因，便于从日志定位。
  pi.on('session_compact_failed', (event, ctx) => {
    console.error(`[review-runtime] compaction failed: ${event.errorMessage ?? 'aborted'}`);
    ctx.abort();
  });
}
