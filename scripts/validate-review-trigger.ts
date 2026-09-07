type Comment = { id: number; body: string; in_reply_to_id?: number | null; issue_url?: string; pull_request_url?: string };

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function validateReviewTrigger(options: {
  repository: string;
  pullNumber: string;
  source: string;
  commentId: string;
  commentRootId: string;
  body: string;
  token: string;
  api?: string;
  fetchImpl?: typeof fetch;
}) {
  if (!/^(thread|pr_comment)$/.test(options.source) || !/^\d+$/.test(options.commentId) || !/^\d+$/.test(options.commentRootId)) throw new Error('Invalid review trigger metadata');
  const route = options.source === 'thread'
    ? `/repos/${options.repository}/pulls/comments/${options.commentId}`
    : `/repos/${options.repository}/issues/comments/${options.commentId}`;
  const response = await (options.fetchImpl ?? fetch)(`${options.api ?? 'https://api.github.com'}${route}`, { headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`Review trigger lookup failed: ${response.status}`);
  const comment = await response.json() as Comment;
  const expectedIssue = `/repos/${options.repository}/issues/${options.pullNumber}`;
  if (options.source === 'thread') {
    if (comment.pull_request_url !== `${options.api ?? 'https://api.github.com'}${`/repos/${options.repository}/pulls/${options.pullNumber}`}`) throw new Error('Review thread is not on the requested pull request');
    if (String(comment.in_reply_to_id ?? comment.id) !== options.commentRootId) throw new Error('Review thread root does not match request');
  } else if (comment.issue_url !== `${options.api ?? 'https://api.github.com'}${expectedIssue}` || String(comment.id) !== options.commentRootId) {
    throw new Error('Review comment is not on the requested pull request');
  }
}

export async function main() {
  await validateReviewTrigger({
    repository: required('REPOSITORY'), pullNumber: required('PULL_NUMBER'), source: required('TRIGGER_SOURCE'),
    commentId: required('COMMENT_ID'), commentRootId: required('COMMENT_ROOT_ID'), body: process.env.COMMENT_BODY ?? '', token: required('GH_TOKEN'),
    api: process.env.GITHUB_API_URL,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error); process.exitCode = 1; });
