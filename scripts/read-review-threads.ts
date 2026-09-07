import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// 两个连接独立分页：GraphQL 取 thread 状态与 root ID，REST 取完整回复。
export async function readReviewThreads(run = async (args: string[]) =>
  (await exec('gh', args, { maxBuffer: Infinity })).stdout) {
  const repository = process.env.REVIEW_REPOSITORY ?? '';
  const pull = process.env.REVIEW_PULL_NUMBER ?? '';
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository) || !/^[1-9]\d*$/.test(pull)) {
    throw new Error('Invalid review repository or pull number');
  }
  const [owner, name] = repository.split('/');
  const query = 'query($owner:String!,$name:String!,$pull:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$pull){reviewThreads(first:100,after:$endCursor){nodes{id isResolved isOutdated resolvedBy{login} comments(first:1){nodes{databaseId}}}pageInfo{hasNextPage endCursor}}}}}';
  const [states, comments] = await Promise.all([
    run(['api', 'graphql', '--paginate', '--slurp', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pull=${pull}`]),
    run(['api', '--paginate', '--slurp', `repos/${repository}/pulls/${pull}/comments?per_page=100`]),
  ]);
  const repliesByRoot = new Map<number, any[]>();
  for (const comment of JSON.parse(comments).flat()) {
    const root = comment.in_reply_to_id ?? comment.id;
    const replies = repliesByRoot.get(root) ?? [];
    replies.push({ id: comment.id, body: comment.body, created_at: comment.created_at, updated_at: comment.updated_at, html_url: comment.html_url });
    repliesByRoot.set(root, replies);
  }
  return JSON.parse(states).flatMap((page: any) => {
    if (page.errors?.length) throw new Error('GitHub review thread query failed');
    return page.data.repository.pullRequest.reviewThreads.nodes.map((thread: any) => {
      const root = thread.comments.nodes[0].databaseId;
      const replies = repliesByRoot.get(root);
      if (!Number.isSafeInteger(root) || typeof thread.isResolved !== 'boolean' ||
          !replies?.some((comment) => comment.id === root)) throw new Error('Incomplete review thread snapshot');
      return {
        id: thread.id,
        root_comment_id: root,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        resolvedBy: thread.resolvedBy,
        comments: replies,
      };
    });
  });
}
