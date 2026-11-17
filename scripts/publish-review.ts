import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createPublication, finishPublication, publicationSummary, type PublicationOperation } from './publication.ts';
import { parseReviewCoverage, pendingCoverage } from './review-coverage.ts';
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { findingLabels, parseReviewResult, statusLabels, type FindingLabel, type ReviewResult } from './review-result.ts';
import { parseReviewUsage, reviewMetadataStart, reviewMetadataEnd, type ReviewUsage } from './review-usage.ts';
import { findingLabelFromText, findingLabelText, parseReviewLanguage, reviewText, statusLabelText, type ReviewLanguage } from './review-language.ts';

type FooterMetadata = {
  language?: ReviewLanguage;
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
// 页脚分两行：第一行是可点开的链接与审查位置，第二行是运行信息。
export type Footer = { links: string; details: string };
type PublishOptions = {
  language?: ReviewLanguage;
  result: ReviewResult;
  repository: string;
  pullNumber: number;
  botLogin: string;
  token: string;
  expectedHeadSha: string;
  previousHeadSha?: string;
  footer: Footer;
  runUrl: string;
  runId: number;
  // 返回同一 head 上本 App 首次开始执行最晚的自动审查运行号；评论请求不取代完整审查。
  latestAutomaticRun: () => Promise<number>;
  publicationId: string;
  api: string;
  requestSource?: string;
  requestCommentId?: string;
  requestRootCommentId?: string;
  threadReplyOnly?: boolean;
  coverage?: { reviewed: number; total: number; sourceReviewed: number };
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

function formatDuration(value: number, language: ReviewLanguage) {
  let seconds = Math.round(value);
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return language === 'en'
    ? [hours && `${hours}h`, minutes && `${minutes}m`, `${seconds}s`].filter(Boolean).join(' ')
    : [hours && `${hours} 小时`, minutes && `${minutes} 分`, `${seconds} 秒`].filter(Boolean).join(' ');
}

export function buildFooter({
  language = 'zh-CN',
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
}: FooterMetadata): Footer {
  const details = [thinkingLevel && thinkingLevel !== 'off' ? reviewText(language, `${model}（推理 ${thinkingLevel}）`, `${model} (reasoning ${thinkingLevel})`) : model];
  if (Number.isFinite(durationSeconds)) details.push(reviewText(language, `用时 ${formatDuration(durationSeconds!, language)}`, `Duration ${formatDuration(durationSeconds!, language)}`));
  if (Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) {
    details.push(`${formatNumber(inputTokens! + outputTokens!)} token`);
  }
  if (cost === undefined || priceKnown === false) details.push(reviewText(language, '费用未提供', 'Cost unavailable'));
  else {
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Invalid review cost');
    details.push(reviewText(language, `费用约 ${dollars(cost)}`, `Estimated cost ${dollars(cost)}`));
  }
  if (controlSha) details.push(reviewText(language, `规则 \`${controlSha.slice(0, 7)}\``, `Rules \`${controlSha.slice(0, 7)}\``));
  return { links: `${runLinkText(runUrl, language)} · [${reviewText(language, '审查工作稿', 'Review workspace')}](${workspaceUrl})`, details: details.join(' · ') };
}

const runLinkText = (runUrl: string, language: ReviewLanguage) => `[${reviewText(language, '运行记录', 'Workflow run')}](${runUrl})`;
const dollars = (value: number) => value > 0 && value < 0.0001 ? '<$0.0001' : `$${value.toFixed(4)}`;

// 固定标记让下一轮输入剔除运行信息；费用明细写入 Check 供复盘。
const metadataBlock = (text: string) => `${reviewMetadataStart}\n${text}\n${reviewMetadataEnd}`;

export function usageDetails(usage: ReviewUsage, language: ReviewLanguage = 'zh-CN') {
  parseReviewUsage(usage);
  const { first, total } = usage;
  const firstInput = first.input + first.cacheRead + first.cacheWrite;
  const hit = firstInput === 0 ? reviewText(language, '无输入', 'no input') : `${(100 * first.cacheRead / firstInput).toFixed(1)}%`;
  const cost = (value: number) => usage.priceKnown ? dollars(value) : reviewText(language, '未提供', 'unavailable');
  const tokens = (value: number) => value.toLocaleString('en-US');
  return [
    reviewText(language, `${usage.turns} 个审查回合；首轮缓存命中 ${hit}。`, `${usage.turns} review turns; first-turn cache hit ${hit}.`), '',
    reviewText(language, '| 审查回合用量 | Token | 费用估算 |', '| Review usage | Tokens | Estimated cost |'), '| --- | ---: | ---: |',
    ...([
      ['普通输入', 'input'], ['缓存读取', 'cacheRead'], ['缓存写入', 'cacheWrite'], ['输出（含推理）', 'output'],
    ] as const).map(([label, key]) => `| ${reviewText(language, label, { input: 'Input', cacheRead: 'Cache read', cacheWrite: 'Cache write', output: 'Output (including reasoning)' }[key])} | ${tokens(total[key])} | ${cost(total.cost[key])} |`), '',
    reviewText(language, `首轮输入：普通 ${tokens(first.input)}；缓存读取 ${tokens(first.cacheRead)}；缓存写入 ${tokens(first.cacheWrite)}。`, `First-turn input: ${tokens(first.input)} uncached; ${tokens(first.cacheRead)} cache read; ${tokens(first.cacheWrite)} cache write.`),
    total.reasoning === undefined ? reviewText(language, '推理 Token：未提供。', 'Reasoning tokens: unavailable.')
      : reviewText(language, `推理 Token：${tokens(total.reasoning)}，已包含在输出中。`, `Reasoning tokens: ${tokens(total.reasoning)}, included in output.`),
    reviewText(language, '以上为审查回合统计；总费用采用 Action 汇总。', 'Usage covers review turns; total cost comes from the Action summary.'),
  ].join('\n');
}

type CheckRecord = {
  language?: ReviewLanguage;
  footer?: Footer;
  usage?: ReviewUsage;
  coverage?: { reviewed: number; total: number; sourceReviewed: number };
  result?: ReviewResult;
  operations: PublicationOperation[];
};

// Check 随提交长期保留并可经 API 查询，是复盘运行数据的固定来源；PR 正文只面向读者。
// 操作数受结果 schema 的条目上限约束，不含错误原文，正文远低于 Check output 上限。
export function checkText({ footer, usage, coverage, result, operations, language = 'zh-CN' }: CheckRecord) {
  const counts = (['succeeded', 'failed', 'blocked'] as const)
    .map(status => [status, operations.filter(item => item.status === status)] as const);
  const labels = language === 'en' ? { succeeded: 'Succeeded', failed: 'Failed', blocked: 'Blocked by a failed prerequisite' }
    : { succeeded: '成功', failed: '失败', blocked: '前置失败，未执行' };
  const statusCounts = result && (Object.keys(statusLabels) as Array<keyof typeof statusLabels>)
    .map(status => [statusLabelText(status, language), result.thread_updates.filter(item => item.status === status).length] as const)
    .filter(([, count]) => count).map(([label, count]) => `${label} ${count}`).join(reviewText(language, '，', ', '));
  return [
    ...(footer ? [reviewText(language, '## 运行', '## Run'), '', footer.links, '', footer.details, ''] : []),
    ...(result ? [reviewText(language, '## 审查结果', '## Review result'), '',
      reviewText(language, `新问题 ${result.comments.length} 条；历史问题状态变化 ${result.thread_updates.length} 条${statusCounts ? `（${statusCounts}）` : ''}。`,
        `${result.comments.length} new findings; ${result.thread_updates.length} historical status changes${statusCounts ? ` (${statusCounts})` : ''}.`), ''] : []),
    ...(coverage ? [reviewText(language, '## 覆盖', '## Coverage'), '',
      reviewText(language, `已审查 ${coverage.reviewed}/${coverage.total} 个文件；来源 PR 已审而未重复审查 ${coverage.sourceReviewed} 个。`, `Reviewed ${coverage.reviewed}/${coverage.total} files; ${coverage.sourceReviewed} already reviewed in source PRs.`), ''] : []),
    ...(usage ? [reviewText(language, '## 用量', '## Usage'), '', usageDetails(usage, language), ''] : []),
    reviewText(language, '## 发布操作', '## Publication operations'), '',
    counts.map(([status, items]) => `${labels[status]} ${items.length}`).join(reviewText(language, '；', '; ')) + reviewText(language, '。', '.'),
    ...counts.filter(([status]) => status !== 'succeeded').flatMap(([status, items]) =>
      items.map(item => `- ${labels[status]}${reviewText(language, '：', ': ')}${item.id}`)),
    '', reviewText(language, '错误详情见本次运行的 Actions 摘要与 `publication-report.json`。', 'See the Actions summary and `publication-report.json` for error details.'),
  ].join('\n');
}

export async function publishReview({
  language = 'zh-CN',
  result,
  repository,
  pullNumber,
  botLogin,
  token,
  expectedHeadSha,
  previousHeadSha = '',
  footer,
  runUrl,
  runId,
  latestAutomaticRun,
  publicationId,
  api,
  requestSource = 'automatic',
  requestCommentId = '',
  requestRootCommentId = '',
  threadReplyOnly = false,
  coverage,
  coverageNotice = '',
  fetchImpl = fetch,
  publication = createPublication(),
}: PublishOptions) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) throw new Error('Invalid repository');
  if (!Number.isInteger(pullNumber) || pullNumber < 1) throw new Error('Invalid pull number');
  if (!/^[A-Za-z0-9-]+\[bot\]$/.test(botLogin)) throw new Error('Invalid review bot login');
  if (!/^[0-9a-f]{40}$/.test(expectedHeadSha)) throw new Error('Invalid review head');
  if (previousHeadSha && !/^[0-9a-f]{40}$/.test(previousHeadSha)) throw new Error('Invalid previous review head');

  if (!publicationId) throw new Error('Missing publication identity');
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid review run id');
  // 整体 schema 是公共前置条件；操作异常不影响其他独立写入。
  parseReviewResult(JSON.stringify(result));
  const { run } = publication;
  const route = `/repos/${repository}/pulls/${pullNumber}`;
  const request = <T>(endpoint: string, init?: RequestInit) => github<T>(fetchImpl, api, token, endpoint, init);
  const isBot = (item: { user?: { login?: string } }) => item.user?.login?.toLowerCase() === botLogin.toLowerCase();
  const marker = (id: string, content: unknown) => `${publicationTagPrefix}${createHash('sha256')
    .update(JSON.stringify([publicationId, repository, pullNumber, expectedHeadSha, id, content])).digest('hex')} -->`;
  const short = (sha: string) => `\`${sha.slice(0, 7)}\``;
  const needsReview = !threadReplyOnly || result.comments.length > 0;
  // 总评的问题索引取自当前讨论状态，因此发布总评也需要评论和 thread 列表。
  const needsComments = needsReview || result.thread_updates.length > 0 || requestSource === 'thread';
  const [comments, threads, reviews] = await Promise.all([
    needsComments ? run('读取 PR 评论', [], () =>
      listPullRecords<ReviewComment>(fetchImpl, api, token, `${route}/comments`)) : undefined,
    needsReview || result.thread_updates.length ? run('读取 PR thread', [], () =>
      reviewThreads(fetchImpl, api, token, repository, pullNumber)) : undefined,
    needsReview ? run('读取已发布 Review', [], () => listPullRecords<{
      id: number; body: string; html_url: string; user?: { login?: string };
    }>(fetchImpl, api, token, `${route}/reviews`)) : undefined,
  ]);
  // 只有失败需要提醒读者；全部成功时 GitHub 上的状态本身就是执行结果。
  const notice = () => {
    const failed = publication.operations.filter(item => item.status !== 'succeeded').length;
    return failed
      ? reviewText(language,
        `> [!WARNING]\n> 发布未全部完成：${failed} 项操作失败或因前置失败未执行。下文是审查判断，不能据此认定问题已发布或讨论已关闭；实际执行结果见 Check 详情。`,
        `> [!WARNING]\n> Publication is incomplete: ${failed} operations failed or were blocked. The review below does not prove that findings were posted or discussions resolved; see the Check for actual results.`)
      : '';
  };
  const compose = (...parts: string[]) => parts.filter(Boolean).join('\n\n');
  const runLink = metadataBlock(runLinkText(runUrl, language));
  const statusUpdatePrefix = reviewText(language, '**状态更新：', '**Status update: ');
  const firstLine = (body: string) => body.split('\n', 1)[0];
  const summaryTag = marker('summary', result);
  // 自动总评标记与发布标记同处首行，模型正文从标题之后开始，不能冒充。
  const summaryHead = requestSource === 'automatic' ? `${summaryTag}${automaticSummaryMarker}` : summaryTag;
  const ownSummary = () => reviews!.value!.find(item => isBot(item) && firstLine(item.body).includes(summaryTag));
  // 同一 PR 的审查在执行层串行；首次创建 Check 的先后才是执行顺序，运行号只标识身份。
  // 后续完整自动审查取代旧自动审查，旧运行重跑整体失败；局部评论请求不取代完整审查。
  // 重跑会重新准备当前讨论并执行 Agent，评论请求后的完整复核仍依据最新讨论判断状态。
  const fresh = requestSource === 'automatic' ? [await run('确认没有更新的审查', [], async () => {
    const latest = await latestAutomaticRun();
    if (latest !== runId) throw new Error(`Run ${latest} has already started reviewing this head; rerun of run ${runId} must not overwrite it`);
  })] : [];

  for (const update of result.thread_updates) {
    const id = `thread ${update.root_comment_id}`;
    const root = await run(`${id} 归属校验`, [comments!], async () => {
      const found = comments!.value!.find(item => item.id === update.root_comment_id && item.in_reply_to_id == null);
      if (!found) throw new Error(`${update.root_comment_id} is not a root comment in this PR`);
      return found;
    });
    const label = statusLabelText(update.status, language);
    // 标注带本运行的发布标记，重跑时据此认出自己写入的标注。
    const statusTag = marker(`${id} status`, update);
    const statusLine = reviewText(language, `**${label}**（${short(expectedHeadSha)}）：${update.evidence}`, `**${label}** (${short(expectedHeadSha)}): ${update.evidence}`) + ` ${statusTag}${statusMarker}`;
    // 状态同步、状态标注与回复互不依赖，三项均结束后再汇总失败并发布总评。
    await Promise.all([
      run(`${id} 状态同步`, [root, threads!, ...fresh], async () => {
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
      // 本 bot 发出的问题在首行标注最新状态；编辑不产生通知，展开讨论即可看到原因。
      run(`${id} 状态标注`, [root, ...fresh], async () => {
        if (!isBot(root.value!)) return;
        const body = root.value!.body;
        const [first, ...others] = body.split('\n\n');
        const next = `${statusLine}\n\n${first.endsWith(statusMarker) ? others.join('\n\n') : body}`;
        if (next !== body) await request(`/repos/${repository}/pulls/comments/${root.value!.id}`, {
          method: 'PATCH', body: JSON.stringify({ body: next }),
        });
      }),
      // 关闭只需标注；重现、升级需要通知人，他人发起的讨论也无法改写原文，二者改为回复。
      run(`${id} 状态回复`, [root, ...fresh], async () => {
        if (update.status === 'resolved' && isBot(root.value!)) return;
        const tag = marker(`${id} evidence`, update);
        const replies = comments!.value!.filter(item => item.in_reply_to_id === update.root_comment_id && isBot(item));
        if (replies.some(item => item.body.includes(tag))) return;
        const status = `${statusUpdatePrefix}${label}**`;
        // 最新状态相同时不重复。本 bot 的问题关闭时只改标注、不回复，最新状态以标注为准；
        // 标注由本运行写入时说明是重跑，回复仍需补发。
        const annotation = root.value!.body.split('\n\n', 1)[0];
        const unchanged = isBot(root.value!)
          ? annotation.endsWith(statusMarker) && annotation.startsWith(`**${label}**`) && !annotation.includes(statusTag)
          : replies.filter(item => item.body.startsWith(statusUpdatePrefix)).at(-1)?.body.startsWith(status);
        if (unchanged) return;
        await request(`${route}/comments/${update.root_comment_id}/replies`, {
          method: 'POST', body: JSON.stringify({ body: `${compose(status, update.evidence, runLink)}\n${tag}` }),
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
      const coverageGap = !needsReview ? coverageNotice : '';
      const body = `${compose(notice(), coverageGap, result.request_reply!.body, runLink)}\n${tag}`;
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
    const findings = result.comments.map((comment, index) => ({
      comment, id: `finding ${index + 1} (${comment.path}:${comment.line ?? 'file'})`,
      tag: marker(`finding ${index + 1} (${comment.path}:${comment.line ?? 'file'})`, comment),
    }));
    const inline = findings.filter(({ comment }) => comment.line !== null);
    const fileLevel = findings.filter(({ comment }) => comment.line === null);
    // 创建 Review 的 comments 不支持文件级讨论，只能单独发布；它与 inline 问题一样有 thread 状态，下一轮能进入索引并被关闭。
    // 先于总评发布且总评依赖它们：总评一旦存在，列出的讨论都已存在，后续审查读取时不会漏掉它们。重跑按标记去重。
    const posted = [];
    for (const { comment, id, tag: findingTag } of fileLevel) {
      posted.push(await run(id, [comments!, ...fresh], async () => {
        if (comments!.value!.some(item => isBot(item) && item.body.includes(findingTag))) return;
        await request(`${route}/comments`, { method: 'POST', body: JSON.stringify({
          body: `${renderFinding(comment, language)}\n\n${findingTag}`, commit_id: expectedHeadSha, path: comment.path, subject_type: 'file',
        }) });
      }));
    }
    const review = await run('Review 正文', [reviews!, comments!, threads!, ...fresh, ...posted], async () => {
      const automatic = requestSource === 'automatic';
      const index = summaryIndex({
        result, findings: findings.map(item => item.tag), comments: comments!.value!.filter(isBot),
        allComments: comments!.value!, threads: threads!.value!, language,
      });
      const pending = coverage ? coverage.total - coverage.reviewed : 0;
      const heading = reviewText(language, '## 自动审查：', '## Automated review: ') + [
        ...(pending ? [reviewText(language, `未审完（已审 ${coverage!.reviewed}/${coverage!.total} 个文件）`, `Incomplete (${coverage!.reviewed}/${coverage!.total} files reviewed)`)] : []),
        ...(index.fix ? [reviewText(language, `${index.fix} 个问题需要修改`, `${index.fix} ${index.fix === 1 ? 'finding' : 'findings'} to address`)] : []),
        ...(index.confirm ? [reviewText(language, `${index.confirm} 项需要你确认`, `${index.confirm} ${index.confirm === 1 ? 'decision needs' : 'decisions need'} confirmation`)] : []),
        ...(index.fix || index.confirm ? [] : [reviewText(language, pending ? '已审部分没有需要处理的问题' : '没有需要处理的问题', pending ? 'No actionable findings in reviewed files' : 'No actionable findings')]),
      ].join(reviewText(language, '，', '; '));
      const scope = [
        reviewText(language, `审至 ${short(expectedHeadSha)}${previousHeadSha && previousHeadSha !== expectedHeadSha ? `（上次 ${short(previousHeadSha)}）` : ''}`,
          `Reviewed through ${short(expectedHeadSha)}${previousHeadSha && previousHeadSha !== expectedHeadSha ? ` (previous ${short(previousHeadSha)})` : ''}`),
        ...(coverage ? [reviewText(language, `已审 ${coverage.reviewed}/${coverage.total} 个文件${coverage.sourceReviewed
          ? `（其中 ${coverage.sourceReviewed} 个由来源 PR 审过）` : ''}`, `Reviewed ${coverage.reviewed}/${coverage.total} files${coverage.sourceReviewed ? ` (${coverage.sourceReviewed} from source PRs)` : ''}`)] : []),
      ].join(' · ');
      // GitHub 评论把单个换行渲染为换行，两行运行信息不需要空行分隔。
      const render = (first: string) => `${first}\n${compose(heading, notice(), coverageNotice,
        placeIndex(result.body, index.markdown, language))}\n\n---\n\n${metadataBlock(`${footer.links} · ${scope}\n${footer.details}`)}`;
      // 重跑找到自己的总评时只更新发布结果；被更新运行收起或就地更新的情况已由前置校验拦下。
      const existing = ownSummary();
      if (existing) {
        const body = render(firstLine(existing.body));
        if (existing.body !== body) await request(`${route}/reviews/${existing.id}`, {
          method: 'PUT', body: JSON.stringify({ body }),
        });
        return { id: existing.id, url: existing.html_url };
      }
      const latest = automatic ? latestAutomaticSummary(reviews!.value!.filter(isBot)) : undefined;
      // 没有新问题、没有状态变化且结论标题不变时，就地更新最新总评，不产生新的时间线条目和通知。
      if (latest && !result.comments.length && !result.thread_updates.length && latest.body.split('\n')[1] === heading) {
        // 保留此前各轮的发布标记，旧运行重跑仍能找到这条总评。
        const body = render(`${firstLine(latest.body).slice(0, -automaticSummaryMarker.length)}${summaryHead}`);
        await request(`${route}/reviews/${latest.id}`, { method: 'PUT', body: JSON.stringify({ body }) });
        return { id: latest.id, url: latest.html_url };
      }
      // 新问题挂在同一条 Review 下，每轮只占一条时间线记录；行号已在提交时按 PR diff 校验。
      const response = await request<{ id: number; html_url: string }>(`${route}/reviews`, {
        method: 'POST', body: JSON.stringify({
          body: render(summaryHead), commit_id: expectedHeadSha, event: 'COMMENT',
          ...(inline.length ? { comments: inline.map(({ comment, tag: findingTag }) => ({
            path: comment.path, line: comment.line, side: 'RIGHT', body: `${renderFinding(comment, language)}\n\n${findingTag}`,
            ...(comment.start_line === null ? {} : { start_line: comment.start_line, start_side: 'RIGHT' }),
          })) } : {}),
        }),
      });
      return { id: response.id, url: response.html_url };
    });
    reviewUrl = review.value?.url ?? '';
    // 最新自动总评代表当前结论；更早的自动总评正文收起为一行指向，原文保留在折叠区供展开和下一轮读取。
    // 重跑复用当前总评时同样核对，补做上次失败的收起。
    // 其下的讨论不受影响，仍未解决的问题照常显示。评论请求的答复只覆盖请求范围，既不收起其他总评，也不被收起。
    if (requestSource === 'automatic' && review.value) {
      const older = reviews!.value!.filter(item => isBot(item) && item.id < review.value!.id
        && isAutomaticSummary(item.body) && !isSuperseded(item.body));
      for (const item of older) {
        await run(`收起旧 Review ${item.id}`, [review], async () => {
          const [first, heading, ...rest] = item.body.split('\n');
          const body = [first, reviewText(language, `> 已被[${short(expectedHeadSha)} 的审查](${review.value!.url})取代。`, `> Superseded by the [review of ${short(expectedHeadSha)}](${review.value!.url}).`) + supersededMarker, '',
            `<details><summary>${reviewText(language, '原总评：', 'Previous review: ')}${heading.replace(/^## /, '')}</summary>`, '', heading, ...rest, '', '</details>'].join('\n');
          await request(`${route}/reviews/${item.id}`, { method: 'PUT', body: JSON.stringify({ body }) });
        });
      }
    }
  }
  return { reviewUrl, operations: publication.operations };
}

// 审查 job 在执行层串行队列中开始执行时创建 Check，external_id 为 仓库ID:PR:base:head:来源:运行号:尝试次数，只有可信 workflow 写入。
export async function latestAutomaticRun({ api, token, repository, repositoryId, pullNumber, headSha, appSlug, fetchImpl }: {
  api: string; token: string; repository: string; repositoryId: string; pullNumber: number; headSha: string; appSlug: string;
  fetchImpl: typeof fetch;
}) {
  const firstChecks = new Map<number, number>();
  for (let page = 1; ; page++) {
    // 默认 latest 只保留最近的同名 Check；旧运行重跑的新 Check 会遮住较新运行，必须读取全部历史。
    const body = await github<{ check_runs?: Array<{ id: number; external_id?: string | null; app?: { slug?: string } | null }> }>(fetchImpl, api, token,
      `/repos/${repository}/commits/${headSha}/check-runs?filter=all&per_page=100&page=${page}`);
    if (!Array.isArray(body.check_runs)) throw new Error('Invalid check run page');
    for (const check of body.check_runs) {
      const parts = check.app?.slug === appSlug ? check.external_id?.split(':') ?? [] : [];
      if (parts.length === 7 && parts[0] === repositoryId && parts[1] === String(pullNumber) && parts[3] === headSha
        && parts[4] === 'automatic' && /^[0-9]+$/.test(parts[5])) {
        const runId = Number(parts[5]);
        firstChecks.set(runId, Math.min(firstChecks.get(runId) ?? Infinity, check.id));
      }
    }
    if (body.check_runs.length < 100) break;
  }
  let latest = 0;
  let lastCheck = 0;
  for (const [runId, checkId] of firstChecks) {
    if (checkId > lastCheck) { latest = runId; lastCheck = checkId; }
  }
  if (!latest) throw new Error('No automatic review Check found for this head');
  return latest;
}

const publicationTagPrefix = '<!-- agentic-review-publication:';
const statusMarker = '<!-- agentic-review:status -->';
const automaticSummaryMarker = '<!-- agentic-review:automatic-summary -->';
const supersededMarker = '<!-- agentic-review:superseded -->';
const isAutomaticSummary = (body: string) => body.split('\n', 1)[0].endsWith(automaticSummaryMarker);
const isSuperseded = (body: string) => body.split('\n', 2)[1]?.endsWith(supersededMarker) ?? false;

function latestAutomaticSummary<T extends { id: number; body: string }>(reviews: T[]) {
  return reviews.filter(item => isAutomaticSummary(item.body) && !isSuperseded(item.body))
    .reduce<T | undefined>((latest, item) => !latest || item.id > latest.id ? item : latest, undefined);
}

export function renderFinding(comment: ReviewResult['comments'][number], language: ReviewLanguage = 'zh-CN') {
  return `> [!${findingLabels[comment.label].alert}]\n> **${findingLabelText(comment.label, language)}${reviewText(language, '：', ': ')}${comment.title}**\n\n${comment.body}`;
}

// 历史问题的标签和标题取自发布器写入的标题行，索引与讨论使用同一标题。
function findingHeader(body: string) {
  const match = body.match(/^> \*\*([^*\n：:]+)[：:] ?([^\n]+)\*\*$/m);
  return match ? { label: findingLabelFromText(match[1]), displayLabel: match[1], title: match[2] } : undefined;
}

function rootText(body: string, language: ReviewLanguage) {
  const header = findingHeader(body);
  if (header) return `${header.label ? findingLabelText(header.label, language) : header.displayLabel}${reviewText(language, '：', ': ')}${header.title}`;
  const line = body.split('\n').map(item => item.replace(/^[>#*\s-]+|\*+$/g, '').trim())
    .find(item => item && !item.startsWith('<!--') && !item.startsWith('[!')) ?? reviewText(language, '讨论', 'Discussion');
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

const labelOrder = Object.keys(findingLabels);

// 问题索引是确定的事实：本轮新问题加上仍未关闭的历史问题，标题原样取自讨论。
function summaryIndex({ result, findings, comments, allComments, threads, language }: {
  result: ReviewResult; findings: string[]; comments: ReviewComment[]; allComments: ReviewComment[]; threads: ReviewThread[];
  language: ReviewLanguage;
}) {
  const groupNames = language === 'en' ? { fix: 'Changes needed', confirm: 'Confirmation needed', improve: 'Optional improvements' }
    : { fix: '需要修改', confirm: '需要你确认', improve: '可选改进' };
  const updates = new Map(result.thread_updates.map(update => [update.root_comment_id, update]));
  const resolved = new Map(threads.map(thread => [thread.comments.nodes[0]?.databaseId, thread.isResolved]));
  const marks = { resolved: '', severity_increased: '⚠️ ', reintroduced: '🔁 ' } as const;
  const items: Array<{ group: keyof typeof groupNames; rank: number; line: string }> = [];
  const add = (label: string | undefined, text: string, line: string) => {
    const known = label !== undefined && Object.hasOwn(findingLabels, label);
    items.push({ group: known ? findingLabels[label as FindingLabel].group : 'fix',
      rank: known ? labelOrder.indexOf(label!) : labelOrder.length, line: `- ${line}${text}` });
  };
  for (const comment of result.comments) {
    add(comment.label, `${findingLabelText(comment.label, language)}${reviewText(language, '：', ': ')}${comment.title}`, '🆕 ');
  }
  for (const root of comments) {
    if (root.in_reply_to_id != null || !root.body.includes(publicationTagPrefix) || findings.some(tag => root.body.includes(tag))) continue;
    const update = updates.get(root.id);
    if (update ? update.status === 'resolved' : resolved.get(root.id) !== false) continue;
    add(findingHeader(root.body)?.label, `${rootText(root.body, language)} · [${reviewText(language, '讨论', 'Discussion')}](${root.html_url})`, update ? marks[update.status] : '');
  }
  items.sort((a, b) => a.rank - b.rank);
  const closed = result.thread_updates.filter(update => update.status === 'resolved').map(update => {
    const root = allComments.find(item => item.id === update.root_comment_id);
    return `- ${root ? `${rootText(root.body, language)} · [${reviewText(language, '讨论', 'Discussion')}](${root.html_url})` : `${reviewText(language, '讨论', 'Discussion')} ${update.root_comment_id}`}`;
  });
  const sections: Array<[string, string[]]> = (Object.keys(groupNames) as Array<keyof typeof groupNames>)
    .map(group => [groupNames[group], items.filter(item => item.group === group).map(item => item.line)]);
  sections.push([reviewText(language, '本轮关闭', 'Resolved this round'), closed]);
  return {
    fix: items.filter(item => item.group === 'fix').length,
    confirm: items.filter(item => item.group === 'confirm').length,
    markdown: sections.filter(([, lines]) => lines.length)
      .map(([name, lines]) => `### ${name}\n\n${lines.join('\n')}`).join('\n\n'),
  };
}

// 索引放在“核对了什么”之前；模型正文没有这一节时放在末尾。
function placeIndex(body: string, index: string, language: ReviewLanguage) {
  if (!index) return body;
  const lines = body.split('\n');
  const at = lines.findIndex(line => line.trim() === reviewText(language, '### 核对了什么', '### What was checked'));
  return at === -1 ? `${body}\n\n${index}` : [...lines.slice(0, at), index, '', ...lines.slice(at)].join('\n');
}

// 覆盖缺口来自可信文件进度，不取自模型正文；未审查文件全部列出，读者无需打开工作稿。
export function coverageNotice(pending: string[], total: number, language: ReviewLanguage = 'zh-CN') {
  if (!pending.length) return '';
  return [
    '> [!WARNING]',
    reviewText(language, `> 本轮在时间预算内只完成了部分审查：已覆盖 ${total - pending.length}/${total} 个文件，下列 ${pending.length} 个文件尚未审查，本轮结论不涵盖它们。在 PR 评论区发起新的评论请求（thread 内回复不续审）会接着审查剩余文件，若期间有新提交，只有直接变化的文件需要重新审查；续审结论不会更新该提交的 \`Agentic Review / audit\` 检查，推送新提交或重新运行自动审查才会重新评定。`,
      `> This review covered ${total - pending.length}/${total} files within the time budget. The ${pending.length} files below remain unreviewed and are outside these conclusions. A new PR comment request can continue the review; a reply inside a thread cannot. If new commits arrive, only directly changed files need to be reviewed again. A continued review does not update this commit's \`Agentic Review / audit\` Check; push a new commit or rerun the automatic review to reassess it.`),
    '',
    `<details><summary>${reviewText(language, `未审查文件（${pending.length}）`, `Unreviewed files (${pending.length})`)}</summary>`,
    '',
    ...pending.map((file) => `- \`${file}\``),
    '',
    '</details>',
  ].join('\n');
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
  const language = parseReviewLanguage(process.env.REVIEW_LANGUAGE);
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
      language,
      runUrl: requiredEnv('REVIEW_RUN_URL'), workspaceUrl: requiredEnv('REVIEW_WORKSPACE_URL'),
      model: requiredEnv('REVIEW_MODEL'), thinkingLevel: process.env.REVIEW_THINKING_LEVEL,
      durationSeconds: optionalNumber(process.env.REVIEW_DURATION_SECONDS),
      inputTokens: optionalNumber(process.env.REVIEW_INPUT_TOKENS),
      outputTokens: optionalNumber(process.env.REVIEW_OUTPUT_TOKENS), cost: optionalNumber(process.env.REVIEW_COST),
      controlSha: process.env.GITHUB_SHA, priceKnown: usage.priceKnown,
    });
    const counts = { reviewed: total - pending.length, total, sourceReviewed };
    const record = { footer, usage, result, coverage: counts, language };
    const options: PublishOptions = {
      language,
      publication, publicationId: requiredEnv('REVIEW_RUN_URL'), result, footer, runUrl: requiredEnv('REVIEW_RUN_URL'),
      runId: Number(requiredEnv('REVIEW_RUN_ID')),
      latestAutomaticRun: () => latestAutomaticRun({ api: process.env.GITHUB_API_URL ?? 'https://api.github.com', token: requiredEnv('GH_TOKEN'),
        repository: request.repository, repositoryId: requiredEnv('REVIEW_REPOSITORY_ID'), pullNumber: request.pull_number,
        headSha: request.head_sha, appSlug: requiredEnv('REVIEW_BOT_LOGIN').replace(/\[bot\]$/, ''), fetchImpl: fetch }),
      repository: request.repository, pullNumber: request.pull_number, expectedHeadSha: request.head_sha,
      previousHeadSha: process.env.REVIEW_CHECKPOINT_HEAD ?? '',
      botLogin: requiredEnv('REVIEW_BOT_LOGIN'), token: requiredEnv('GH_TOKEN'),
      api: process.env.GITHUB_API_URL ?? 'https://api.github.com',
      requestSource: request.source, requestCommentId: request.comment_id ?? '',
      requestRootCommentId: request.root_comment_id ?? '',
      threadReplyOnly: request.source === 'thread' && coverage.scope.mode === 'focused',
      coverage: counts, coverageNotice: coverageNotice(pending, total, language),
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
      const text = checkText({ language, ...input.value?.record, operations: report.operations });
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
