type ThreadStatus = keyof typeof statusLabels;
export type ReviewResult = {
  body: string;
  comments: Array<{ path: string; line: number; start_line: number | null; body: string }>;
  thread_updates: Array<{ root_comment_id: number; status: ThreadStatus; evidence: string }>;
  request_reply: { body: string } | null;
};

export const statusLabels = {
  resolved: '✅ 已关闭',
  severity_increased: '⚠️ 风险升级',
  reintroduced: '🔁 问题重现',
} as const;

export function parseReviewResult(text: string): ReviewResult {
  if (Buffer.byteLength(text) > 1_000_000) throw new Error('Review result is too large');
  const result: any = JSON.parse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid review result');
  const fields = Object.keys(result).sort().join(',');
  if (fields !== 'body,comments,request_reply,thread_updates') {
    throw new Error('Invalid review result fields');
  }
  if (typeof result.body !== 'string' || !result.body.trim() || result.body.length > 60_000) {
    throw new Error('Invalid review body');
  }
  if (!Array.isArray(result.comments) || result.comments.length > 100) throw new Error('Invalid review comments');
  result.comments.forEach((comment: any) => {
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)) throw new Error('Invalid review comment');
    if (Object.keys(comment).sort().join(',') !== 'body,line,path,start_line') {
      throw new Error('Invalid review comment fields');
    }
    if (typeof comment.path !== 'string' || !comment.path || comment.path.startsWith('/') ||
        comment.path.includes('\\') || comment.path.split('/').includes('..')) {
      throw new Error('Invalid review comment path');
    }
    if (!Number.isInteger(comment.line) || comment.line < 1) throw new Error('Invalid review comment line');
    if (comment.start_line !== null &&
        (!Number.isInteger(comment.start_line) || comment.start_line < 1 || comment.start_line > comment.line)) {
      throw new Error('Invalid review comment start_line');
    }
    if (typeof comment.body !== 'string' || !comment.body.trim() || comment.body.length > 65_536) {
      throw new Error('Invalid review comment body');
    }
  });
  if (!Array.isArray(result.thread_updates) || result.thread_updates.length > 100) {
    throw new Error('Invalid thread updates');
  }
  const seen = new Set<number>();
  result.thread_updates.forEach((update: any) => {
    if (!update || typeof update !== 'object' || Array.isArray(update) ||
        Object.keys(update).sort().join(',') !== 'evidence,root_comment_id,status') {
      throw new Error('Invalid thread update fields');
    }
    if (!Number.isInteger(update.root_comment_id) || update.root_comment_id < 1) {
      throw new Error('Invalid root_comment_id');
    }
    if (!Object.hasOwn(statusLabels, update.status)) throw new Error('Invalid thread status');
    if (typeof update.evidence !== 'string' || update.evidence.length < 10 || update.evidence.length > 5000) {
      throw new Error('Invalid thread evidence');
    }
    if (seen.has(update.root_comment_id)) throw new Error('Duplicate thread update');
    seen.add(update.root_comment_id);
  });
  if (result.request_reply !== null &&
      (!result.request_reply || typeof result.request_reply !== 'object' || Array.isArray(result.request_reply) ||
       Object.keys(result.request_reply).join(',') !== 'body' ||
       typeof result.request_reply.body !== 'string' || !result.request_reply.body.trim())) {
    throw new Error('Invalid request reply');
  }
  return result;
}
