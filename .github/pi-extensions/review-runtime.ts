type ExtensionAPI = {
  on(event: 'session_compact_failed', handler: (event: { errorMessage?: string }, ctx: { abort(): void }) => void): void;
};

export default function reviewRuntime(pi: ExtensionAPI) {
  // Abort the review when Pi's summary retries still fail, keeping the existing incomplete-context protection; log the reason first for diagnosis.
  pi.on('session_compact_failed', (event, ctx) => {
    console.error(`[review-runtime] compaction failed: ${event.errorMessage ?? 'aborted'}`);
    ctx.abort();
  });
}
