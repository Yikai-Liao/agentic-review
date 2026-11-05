type ThreadStatus = keyof typeof statusLabels;
export type FindingLabel = keyof typeof findingLabels;
export type ReviewResult = {
  body: string;
  comments: Array<{ path: string; line: number | null; start_line: number | null; label: FindingLabel; title: string; body: string }>;
  thread_updates: Array<{ root_comment_id: number; status: ThreadStatus; evidence: string }>;
  request_reply: { body: string } | null;
};

export const statusLabels = {
  resolved: '✅ 已关闭',
  severity_increased: '⚠️ 风险升级',
  reintroduced: '🔁 问题重现',
} as const;

// 标签决定 Alert 和总评索引分组；发布器据此生成标题行，模型只写标签、标题和正文。
// 顺序即总评索引内的排序。
export const findingLabels = {
  P0: { alert: 'CAUTION', group: 'fix' },
  P1: { alert: 'CAUTION', group: 'fix' },
  T1: { alert: 'CAUTION', group: 'fix' },
  P2: { alert: 'WARNING', group: 'fix' },
  T2: { alert: 'WARNING', group: 'fix' },
  缺陷: { alert: 'WARNING', group: 'fix' },
  验证缺口: { alert: 'WARNING', group: 'fix' },
  需人工确认: { alert: 'IMPORTANT', group: 'confirm' },
  待决事项: { alert: 'IMPORTANT', group: 'confirm' },
  改进机会: { alert: 'TIP', group: 'improve' },
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
    if (Object.keys(comment).sort().join(',') !== 'body,label,line,path,start_line,title') {
      throw new Error('Invalid review comment fields');
    }
    if (typeof comment.path !== 'string' || !comment.path || comment.path.startsWith('/') ||
        comment.path.includes('\\') || comment.path.split('/').includes('..')) {
      throw new Error('Invalid review comment path');
    }
    // line 为 null 表示无法绑定 diff 行，发布为该文件上的文件级讨论。
    if (comment.line !== null && (!Number.isInteger(comment.line) || comment.line < 1)) {
      throw new Error('Invalid review comment line');
    }
    if (comment.start_line !== null && (comment.line === null ||
        !Number.isInteger(comment.start_line) || comment.start_line < 1 || comment.start_line > comment.line)) {
      throw new Error('Invalid review comment start_line');
    }
    if (!Object.hasOwn(findingLabels, comment.label)) {
      throw new Error(`Invalid review comment label; use one of ${Object.keys(findingLabels).join(', ')}`);
    }
    // 标题原样进入讨论首行和总评索引，必须是一行纯文本。
    if (typeof comment.title !== 'string' || !comment.title.trim() || comment.title.length > 120
        || /[\r\n]|\*\*/.test(comment.title)) {
      throw new Error('Invalid review comment title: use one line of at most 120 characters without **');
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
    // 关闭原因写进原问题首行的状态标注，限定为一段短文本。
    if (typeof update.evidence !== 'string' || update.evidence.length < 10 || update.evidence.length > 500
        || /[\r\n]/.test(update.evidence)) {
      throw new Error('Invalid thread evidence: use one line of 10-500 characters');
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
