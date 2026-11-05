import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createPublication, finishPublication, publicationSummary, type PublicationOperation } from './publication.ts';
import { parseReviewCoverage, pendingCoverage } from './review-coverage.ts';
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseReviewResult, statusLabels, type ReviewResult } from './review-result.ts';
import { parseReviewUsage, reviewMetadataStart, reviewMetadataEnd, type ReviewUsage } from './review-usage.ts';

type FooterMetadata = {
  runUrl: string;
  workspaceUrl: string;
  model: string;
  thinkingLevel?: string;
  durationSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  controlSha?: string;
  priceKnown?: boolean;
};
type PublishOptions = {
  result: ReviewResult;
  repository: string;
  pullNumber: number;
  botLogin: string;
  token: string;
  expectedHeadSha: string;
  footer: string;
  runUrl: string;
  publicationId: string;
  api: string;
  requestSource?: string;
  requestCommentId?: string;
  requestRootCommentId?: string;
  threadReplyOnly?: boolean;
  coverageNotice?: string;
  fetchImpl?: typeof fetch;
  publication?: ReturnType<typeof createPublication>;
};
type ReviewComment = {
  id: number;
  in_reply_to_id: number | null;
  body: string;
  html_url?: string;
  user?: { login?: string };
};
type ReviewThread = {
  id: string;
  isResolved: boolean;
  comments: { nodes: Array<{ databaseId: number }> };
};

async function github<T>(fetchImpl: typeof fetch, api: string, token: string, route: string, init: RequestInit = {}) {
  const response = await fetchImpl(`${api}${route}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body}`);
  return (body ? JSON.parse(body) : undefined) as T;
}

async function listPullRecords<T>(fetchImpl: typeof fetch, api: string, token: string, route: string) {
  const records: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await github<T[]>(fetchImpl, api, token, `${route}?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`Invalid GitHub list: ${route}`);
    records.push(...batch);
    if (batch.length < 100) return records;
  }
}

async function reviewThreads(
  fetchImpl: typeof fetch,
  api: string,
  token: string,
  repository: string,
  pullNumber: number,
) {
  const [owner, repo] = repository.split('/');
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  do {
    const result: any = await github(fetchImpl, api, token, '/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: 'query($owner:String!,$repo:String!,$pull:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$pull){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:1){nodes{databaseId}}}pageInfo{hasNextPage endCursor}}}}}',
        variables: { owner, repo, pull: pullNumber, cursor },
      }),
    });
    if (result.errors?.length) throw new Error(`GitHub GraphQL: ${JSON.stringify(result.errors)}`);
    const page = result.data?.repository?.pullRequest?.reviewThreads;
    if (!Array.isArray(page?.nodes) || page.nodes.some((thread: ReviewThread) => typeof thread?.isResolved !== 'boolean')
        || typeof page.pageInfo?.hasNextPage !== 'boolean' ||
        (page.pageInfo.hasNextPage && (typeof page.pageInfo.endCursor !== 'string' || !page.pageInfo.endCursor))) {
      throw new Error('Incomplete review thread page');
    }
    threads.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}

function formatNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatDuration(value: number) {
  let seconds = Math.round(value);
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return [hours && `${hours}h`, minutes && `${minutes}m`, `${seconds}s`].filter(Boolean).join(' ');
}

export function buildFooter({
  runUrl,
  workspaceUrl,
  model,
  thinkingLevel,
  durationSeconds,
  inputTokens,
  outputTokens,
  cost,
  controlSha,
  priceKnown,
}: FooterMetadata) {
  const parts = [`[View action run](${runUrl})`, `[审查工作稿](${workspaceUrl})`, `Model: ${model}`];
  if (thinkingLevel && thinkingLevel !== 'off') parts[2] += ` (thinking: ${thinkingLevel})`;
  if (Number.isFinite(durationSeconds)) parts.push(`Time: ${formatDuration(durationSeconds!)}`);
  if (Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) {
    parts.push(`Tokens: ${formatNumber(inputTokens! + outputTokens!)}`);
  }
  if (cost === undefined || priceKnown === false) parts.push('Cost (est.): 未提供');
  else {
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Invalid review cost');
    parts.push(`Cost (est.): ${dollars(cost)}`);
  }
  if (controlSha) parts.push(`Rules: ${controlSha.slice(0, 7)}`);
  return parts.join(' | ');
}

const dollars = (value: number) => value > 0 && value < 0.0001 ? '<$0.0001' : `$${value.toFixed(4)}`;

// PR 上只保留一行运行信息；固定标记让下一轮输入剔除它，费用明细写入 Check 供复盘。
const metadataBlock = (line: string) => `${reviewMetadataStart}\n${line}\n${reviewMetadataEnd}`;

export function usageDetails(usage: ReviewUsage) {
  parseReviewUsage(usage);
  const { first, total } = usage;
  const firstInput = first.input + first.cacheRead + first.cacheWrite;
  const hit = firstInput === 0 ? '无输入' : `${(100 * first.cacheRead / firstInput).toFixed(1)}%`;
  const cost = (value: number) => usage.priceKnown ? dollars(value) : '未提供';
  const tokens = (value: number) => value.toLocaleString('en-US');
  return [
    `${usage.turns} 个审查回合；首轮缓存命中 ${hit}。`, '',
    '| 审查回合用量 | Token | 费用估算 |', '| --- | ---: | ---: |',
    ...([
      ['普通输入', 'input'], ['缓存读取', 'cacheRead'], ['缓存写入', 'cacheWrite'], ['输出（含推理）', 'output'],
    ] as const).map(([label, key]) => `| ${label} | ${tokens(total[key])} | ${cost(total.cost[key])} |`), '',
    `首轮输入：普通 ${tokens(first.input)}；缓存读取 ${tokens(first.cacheRead)}；缓存写入 ${tokens(first.cacheWrite)}。`,
    total.reasoning === undefined ? '推理 Token：未提供。' : `推理 Token：${tokens(total.reasoning)}，已包含在输出中。`,
    '以上为审查回合统计；总费用采用 Action 汇总。',
  ].join('\n');
}

type CheckRecord = {
  footer?: string;
  usage?: ReviewUsage;
  coverage?: { reviewed: number; total: number; sourceReviewed: number };
  result?: ReviewResult;
  operations: PublicationOperation[];
};

// Check 随提交长期保留并可经 API 查询，是复盘运行数据的固定来源；PR 正文只面向读者。
// 操作数受结果 schema 的条目上限约束，不含错误原文，正文远低于 Check output 上限。
export function checkText({ footer, usage, coverage, result, operations }: CheckRecord) {
  const counts = (['succeeded', 'failed', 'blocked'] as const)
    .map(status => [status, operations.filter(item => item.status === status)] as const);
  const labels = { succeeded: '成功', failed: '失败', blocked: '前置失败，未执行' };
  const statusCounts = result && (Object.keys(statusLabels) as Array<keyof typeof statusLabels>)
    .map(status => [statusLabels[status], result.thread_updates.filter(item => item.status === status).length] as const)
    .filter(([, count]) => count).map(([label, count]) => `${label} ${count}`).join('，');
  return [
    ...(footer ? ['## 运行', '', footer, ''] : []),
    ...(result ? ['## 审查结果', '',
      `新问题 ${result.comments.length} 条；历史问题状态变化 ${result.thread_updates.length} 条${statusCounts ? `（${statusCounts}）` : ''}。`, ''] : []),
    ...(coverage ? ['## 覆盖', '',
      `已审查 ${coverage.reviewed}/${coverage.total} 个文件；来源 PR 已审而未重复审查 ${coverage.sourceReviewed} 个。`, ''] : []),
    ...(usage ? ['## 用量', '', usageDetails(usage), ''] : []),
    '## 发布操作', '',
    counts.map(([status, items]) => `${labels[status]} ${items.length}`).join('；') + '。',
    ...counts.filter(([status]) => status !== 'succeeded').flatMap(([status, items]) =>
      items.map(item => `- ${labels[status]}：${item.id}`)),
    '', '错误详情见本次运行的 Actions 摘要与 `publication-report.json`。',
  ].join('\n');
}

export async function publishReview({
  result,
  repository,
  pullNumber,
  botLogin,
  token,
  expectedHeadSha,
  footer,
  runUrl,
  publicationId,
  api,
  requestSource = 'automatic',
  requestCommentId = '',
  requestRootCommentId = '',
  threadReplyOnly = false,
  coverageNotice = '',
  fetchImpl = fetch,
  publication = createPublication(),
}: PublishOptions) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) throw new Error('Invalid repository');
  if (!Number.isInteger(pullNumber) || pullNumber < 1) throw new Error('Invalid pull number');
  if (!/^[A-Za-z0-9-]+\[bot\]$/.test(botLogin)) throw new Error('Invalid review bot login');
  if (!/^[0-9a-f]{40}$/.test(expectedHeadSha)) throw new Error('Invalid review head');

  if (!publicationId) throw new Error('Missing publication identity');
  // 整体 schema 是公共前置条件；操作异常不影响其他独立写入。
  parseReviewResult(JSON.stringify(result));
  const { run } = publication;
  const route = `/repos/${repository}/pulls/${pullNumber}`;
  const request = <T>(endpoint: string, init?: RequestInit) => github<T>(fetchImpl, api, token, endpoint, init);
  const isBot = (item: { user?: { login?: string } }) => item.user?.login?.toLowerCase() === botLogin.toLowerCase();
  const marker = (id: string, content: unknown) => `<!-- agentic-review-publication:${createHash('sha256')
    .update(JSON.stringify([publicationId, repository, pullNumber, expectedHeadSha, id, content])).digest('hex')} -->`;
  const needsComments = result.comments.length > 0 || result.thread_updates.length > 0 || requestSource === 'thread';
  const needsReview = !threadReplyOnly || result.comments.length > 0;
  const [comments, threads, reviews] = await Promise.all([
    needsComments ? run('读取 PR 评论', [], () =>
      listPullRecords<ReviewComment>(fetchImpl, api, token, `${route}/comments`)) : undefined,
    result.thread_updates.length ? run('读取 PR thread', [], () =>
      reviewThreads(fetchImpl, api, token, repository, pullNumber)) : undefined,
    needsReview ? run('读取已发布 Review', [], () => listPullRecords<{
      id: number; node_id: string; body: string; html_url: string; user?: { login?: string };
    }>(fetchImpl, api, token, `${route}/reviews`)) : undefined,
  ]);
  // 只有失败需要提醒读者；全部成功时 GitHub 上的状态本身就是执行结果。
  const notice = () => {
    const failed = publication.operations.filter(item => item.status !== 'succeeded').length;
    return failed
      ? `> [!WARNING]\n> 发布未全部完成：${failed} 项操作失败或因前置失败未执行。下文是审查判断，不能据此认定 finding 已发布或 thread 已关闭；实际执行结果见运行报告。`
      : '';
  };
  const compose = (...parts: string[]) => parts.filter(Boolean).join('\n\n');

  for (const [index, comment] of result.comments.entries()) {
    const id = `finding ${index + 1} (${comment.path}:${comment.line})`;
    await run(id, [comments!], async () => {
      const tag = marker(id, comment);
      const existing = comments!.value!.find(item => isBot(item) && item.in_reply_to_id == null && item.body.includes(tag));
      if (existing) return existing.html_url;
      const response = await request<{ html_url: string }>(`${route}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          path: comment.path, line: comment.line,
          commit_id: expectedHeadSha, side: 'RIGHT', body: `${comment.body}\n\n${tag}`,
          ...(comment.start_line === null ? {} : { start_line: comment.start_line, start_side: 'RIGHT' }),
        }),
      });
      return response.html_url;
    });
  }

  for (const update of result.thread_updates) {
    const id = `thread ${update.root_comment_id}`;
    const root = await run(`${id} 归属校验`, [comments!], async () => {
      const found = comments!.value!.find(item => item.id === update.root_comment_id && item.in_reply_to_id == null);
      if (!found) throw new Error(`${update.root_comment_id} is not a root comment in this PR`);
      return found;
    });
    // 状态同步与证据回复并行；两项均结束后再汇总失败并发布最终正文。
    await Promise.all([
      run(`${id} 状态同步`, [root, threads!], async () => {
        const thread = threads!.value!.find(item => item.comments.nodes[0]?.databaseId === update.root_comment_id);
        if (!thread) throw new Error(`${update.root_comment_id} has no review thread in this PR`);
        const shouldResolve = update.status === 'resolved';
        if (thread.isResolved === shouldResolve) return;
        const mutation = shouldResolve
          ? 'mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id}}}'
          : 'mutation($thread:ID!){unresolveReviewThread(input:{threadId:$thread}){thread{id}}}';
        const response: any = await request('/graphql', {
          method: 'POST', body: JSON.stringify({ query: mutation, variables: { thread: thread.id } }),
        });
        if (response.errors?.length) throw new Error(`GitHub GraphQL: ${JSON.stringify(response.errors)}`);
        const payload = shouldResolve ? response.data?.resolveReviewThread : response.data?.unresolveReviewThread;
        if (payload?.thread?.id !== thread.id) throw new Error('Missing thread mutation result');
      }),
      run(`${id} 证据回复`, [root], async () => {
        const tag = marker(`${id} evidence`, update);
        const replies = comments!.value!.filter(item => item.in_reply_to_id === update.root_comment_id && isBot(item));
        if (replies.some(item => item.body.includes(tag))) return;
        const status = `${statusUpdatePrefix}${statusLabels[update.status]}**`;
        if (replies.filter(item => item.body.startsWith(statusUpdatePrefix)).at(-1)?.body.startsWith(status)) return;
        // 同轮总评已有完整运行信息，回复只链接运行。
        await request(`${route}/comments/${update.root_comment_id}/replies`, {
          method: 'POST', body: JSON.stringify({
            body: `${compose(status, update.evidence, metadataBlock(`[View action run](${runUrl})`))}\n${tag}`,
          }),
        });
      }),
    ]);
  }

  if (requestSource === 'thread') {
    await run('请求回复', [comments!], async () => {
      if (!/^[0-9]+$/.test(requestRootCommentId)) throw new Error('Thread request is missing its root comment');
      const root = comments!.value!.find(item => item.id === Number(requestRootCommentId) && item.in_reply_to_id == null);
      if (!root) throw new Error(`${requestRootCommentId} is not a root comment in this PR`);
      const tag = marker(`request ${requestCommentId}`, result.request_reply);
      const existing = comments!.value!.find(item => item.in_reply_to_id === root.id && isBot(item) && item.body.includes(tag));
      // 只回复 thread 时没有 Review 正文，覆盖缺口随回复公开。
      const coverage = !needsReview ? coverageNotice : '';
      const body = `${compose(notice(), coverage, result.request_reply!.body, metadataBlock(footer))}\n${tag}`;
      if (existing) {
        if (existing.body !== body) await request(`/repos/${repository}/pulls/comments/${existing.id}`, {
          method: 'PATCH', body: JSON.stringify({ body }),
        });
        return;
      }
      await request(`${route}/comments/${root.id}/replies`, {
        method: 'POST', body: JSON.stringify({ body }),
      });
    });
  }

  let reviewUrl = '';
  if (needsReview) {
    const review = await run('Review 正文', [reviews!], async () => {
      const tag = marker('summary', result);
      const existing = reviews!.value!.find(item => isBot(item) && item.body.includes(tag));
      // 自动总评标记与发布标记同处首行，模型正文从第二行开始，不能冒充。
      const head = requestSource === 'automatic' ? `${tag}${automaticSummaryMarker}` : tag;
      const body = `${head}\n${compose(notice(), coverageNotice, result.body)}\n\n---\n\n${metadataBlock(footer)}`;
      if (existing) {
        if (existing.body !== body) await request(`${route}/reviews/${existing.id}`, {
          method: 'PUT', body: JSON.stringify({ body }),
        });
        return { id: existing.id, url: existing.html_url };
      }
      const response = await request<{ id: number; html_url: string }>(`${route}/reviews`, {
        method: 'POST', body: JSON.stringify({ body, commit_id: expectedHeadSha, event: 'COMMENT' }),
      });
      return { id: response.id, url: response.html_url };
    });
    reviewUrl = review.value?.url ?? '';
    // 自动审查的最新总评代表当前结论，更早的自动总评折叠为 outdated，原文保留供展开和复盘。
    // 评论请求的答复可能只覆盖局部范围，既不折叠其他总评，也不被自动总评折叠。
    if (requestSource === 'automatic') {
      const outdated = await run('读取旧 Review 折叠状态', [review], async () => {
        const candidates = reviews!.value!.filter(item => isBot(item) && item.id < review.value!.id
          && item.body.split('\n', 1)[0].endsWith(automaticSummaryMarker));
        const folded = new Set<string>();
        for (let index = 0; index < candidates.length; index += 100) {
          const response: any = await request('/graphql', {
            method: 'POST', body: JSON.stringify({
              query: 'query($ids:[ID!]!){nodes(ids:$ids){... on PullRequestReview{id isMinimized}}}',
              variables: { ids: candidates.slice(index, index + 100).map(item => item.node_id) },
            }),
          });
          if (response.errors?.length) throw new Error(`GitHub GraphQL: ${JSON.stringify(response.errors)}`);
          const nodes = response.data?.nodes;
          if (!Array.isArray(nodes) || nodes.length !== Math.min(100, candidates.length - index)
              || nodes.some((node: any) => typeof node?.id !== 'string' || typeof node.isMinimized !== 'boolean')) {
            throw new Error('Invalid review minimized state');
          }
          for (const node of nodes) if (node.isMinimized) folded.add(node.id);
        }
        return candidates.filter(item => !folded.has(item.node_id));
      });
      for (const item of outdated.value ?? []) {
        await run(`折叠旧 Review ${item.id}`, [outdated], async () => {
          const response: any = await request('/graphql', {
            method: 'POST', body: JSON.stringify({
              query: 'mutation($id:ID!){minimizeComment(input:{subjectId:$id,classifier:OUTDATED}){minimizedComment{isMinimized}}}',
              variables: { id: item.node_id },
            }),
          });
          if (response.errors?.length) throw new Error(`GitHub GraphQL: ${JSON.stringify(response.errors)}`);
          if (response.data?.minimizeComment?.minimizedComment?.isMinimized !== true) throw new Error('Missing minimize result');
        });
      }
    }
  }
  return { reviewUrl, operations: publication.operations };
}

const statusUpdatePrefix = '**状态更新：';
const automaticSummaryMarker = '<!-- agentic-review:automatic-summary -->';

// 覆盖缺口来自可信文件进度，不取自模型正文；未审查文件全部列出，读者无需打开工作稿。
export function coverageNotice(pending: string[], total: number) {
  if (!pending.length) return '';
  return [
    '> [!WARNING]',
    `> 本轮在时间预算内只完成了部分审查：已覆盖 ${total - pending.length}/${total} 个文件，下列 ${pending.length} 个文件尚未审查，本轮结论不涵盖它们。在 PR 评论区发起新的评论请求（thread 内回复不续审）会接着审查剩余文件，若期间有新提交，只有直接变化的文件需要重新审查；续审结论不会更新该提交的 \`Agentic Review / audit\` 检查，推送新提交或重新运行自动审查才会重新评定。`,
    '',
    `<details><summary>未审查文件（${pending.length}）</summary>`,
    '',
    ...pending.map((file) => `- \`${file}\``),
    '',
    '</details>',
  ].join('\n');
}

// 跳过数量取自可信文件进度，叠加审查文件仍在待审范围内，不属于这里的计数。
export function sourceReviewedNotice(count: number) {
  return count ? `> ${count} 个文件因来源 PR 已审而未重复审查。` : '';
}

function optionalNumber(value: string | undefined) {
  return value === undefined || value === '' ? undefined : Number(value);
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function main() {
  const publication = createPublication();
  const input = await publication.run('发布前校验', [], async () => {
    const resultPath = requiredEnv('REVIEW_RESULT_PATH');
    await access(resultPath).catch(() => {
      throw new Error('Agent 结束时没有调用 submit_review，没有可发布的审查结果');
    });
    const result = parseReviewResult(await readFile(resultPath, 'utf8'));
    const coveragePath = requiredEnv('REVIEW_COVERAGE_PATH');
    const coverage = parseReviewCoverage(JSON.parse(await readFile(coveragePath, 'utf8')));
    // 请求由同一可信 job 的准备步骤绑定，发布目标不取自模型结果。
    const request = coverage.request;
    if (!coverage.scope) throw new Error('Missing published review scope');
    if (request.source === 'thread' && !result.request_reply) throw new Error('Thread review must include request_reply');
    if (request.source !== 'thread' && result.request_reply !== null) throw new Error('Non-thread review cannot include request_reply');
    const pending = pendingCoverage(coverage, requiredEnv('REVIEW_INVENTORY_DIGEST'));
    const total = coverage.ledger.filter((entry) => entry.status !== 'out_of_scope' || coverage.scope!.mode === 'full').length;
    const sourceReviewed = coverage.ledger.filter((entry) => entry.status === 'source_reviewed').length;
    const usage = parseReviewUsage(JSON.parse(await readFile(path.join(path.dirname(coveragePath), 'review-usage.json'), 'utf8')));
    const footer = buildFooter({
      runUrl: requiredEnv('REVIEW_RUN_URL'), workspaceUrl: requiredEnv('REVIEW_WORKSPACE_URL'),
      model: requiredEnv('REVIEW_MODEL'), thinkingLevel: process.env.REVIEW_THINKING_LEVEL,
      durationSeconds: optionalNumber(process.env.REVIEW_DURATION_SECONDS),
      inputTokens: optionalNumber(process.env.REVIEW_INPUT_TOKENS),
      outputTokens: optionalNumber(process.env.REVIEW_OUTPUT_TOKENS), cost: optionalNumber(process.env.REVIEW_COST),
      controlSha: process.env.GITHUB_SHA, priceKnown: usage.priceKnown,
    });
    const record = { footer, usage, result, coverage: { reviewed: total - pending.length, total, sourceReviewed } };
    const options: PublishOptions = {
      publication, publicationId: requiredEnv('REVIEW_RUN_URL'), result, footer, runUrl: requiredEnv('REVIEW_RUN_URL'),
      repository: request.repository, pullNumber: request.pull_number, expectedHeadSha: request.head_sha,
      botLogin: requiredEnv('REVIEW_BOT_LOGIN'), token: requiredEnv('GH_TOKEN'),
      api: process.env.GITHUB_API_URL ?? 'https://api.github.com',
      requestSource: request.source, requestCommentId: request.comment_id ?? '',
      requestRootCommentId: request.root_comment_id ?? '',
      threadReplyOnly: request.source === 'thread' && coverage.scope.mode === 'focused',
      coverageNotice: [sourceReviewedNotice(sourceReviewed), coverageNotice(pending, total)].filter(Boolean).join('\n\n'),
    };
    return { coverage, coveragePath, options, pending, total, record };
  });
  let reviewUrl = '';
  if (input.status === 'succeeded' && process.env.GITHUB_OUTPUT) {
    // Check 结论只认可信覆盖：有未审查文件时不能成为 success。
    await appendFile(process.env.GITHUB_OUTPUT, `coverage_pending=${input.value!.pending.length}\ncoverage_total=${input.value!.total}\n`);
  }
  if (input.status === 'succeeded') {
    try {
      reviewUrl = (await publishReview(input.value!.options)).reviewUrl;
    } catch (error) {
      await publication.run('发布器初始化或调度', [], async () => { throw error; });
    }
  } else {
    await publication.run('发布写入', [input], async () => {});
  }
  const report = { reviewUrl, operations: publication.operations };
  await finishPublication(publication, {
    saveReport: async () => {
      const reportPath = path.join(path.dirname(requiredEnv('REVIEW_COVERAGE_PATH')), 'publication-report.json');
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    },
    writeSummary: process.env.GITHUB_STEP_SUMMARY
      ? () => appendFile(process.env.GITHUB_STEP_SUMMARY!, publicationSummary(report.operations, 'GitHub 发布操作')) : undefined,
    // 经步骤输出交给 Check completion；Agent 不能写入本步骤的输出。
    writeCheckText: process.env.GITHUB_OUTPUT ? () => {
      const delimiter = `check_text_${randomUUID()}`;
      const text = checkText({ ...input.value?.record, operations: report.operations });
      return appendFile(process.env.GITHUB_OUTPUT!, `check_text<<${delimiter}\n${text}\n${delimiter}\n`);
    } : undefined,
    saveCoverage: input.status === 'succeeded' ? async (complete) => {
      const { coverage, coveragePath, pending } = input.value!;
      await writeFile(coveragePath, `${JSON.stringify({
        ...coverage, status: complete ? 'published' : 'draft',
        complete_audit: complete && !pending.length && coverage.request.source === 'automatic' && coverage.scope!.mode === 'full',
        updated_at: new Date().toISOString(),
      })}\n`, { encoding: 'utf8', mode: 0o600 });
    } : undefined,
  });
  const summary = publicationSummary(report.operations);
  console.log(`Review URL: ${report.reviewUrl}`);
  if (report.operations.some(item => item.status !== 'succeeded')) {
    console.error(summary);
    process.exitCode = 1;
  } else {
    console.log(summary);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
