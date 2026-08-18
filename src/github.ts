import { readFile, writeFile } from 'node:fs/promises';
import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { assertDiffRange, collectDiffSideLines, type DiffSideLines } from './diff.ts';
import type { Finding } from './schema.ts';

export const pullRequestReviewSchema = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 10_000, pattern: '^## (✅|⚠️) Agentic Review' }),
  comments: Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1 }),
      line: Type.Integer({ minimum: 1 }),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      side: Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')]),
      body: Type.String({ minLength: 1, maxLength: 25_000 }),
    }, { additionalProperties: false }),
  ),
}, { additionalProperties: false });

export type PullRequestReview = Static<typeof pullRequestReviewSchema>;
const reviewValidator = Compile(pullRequestReviewSchema);

export function validatePullRequestReview(value: unknown): PullRequestReview {
  if (!reviewValidator.Check(value)) throw new Error(`Invalid pull request review: ${JSON.stringify(reviewValidator.Errors(value))}`);
  if (!value.body.replace(/^## (✅|⚠️) Agentic Review/, '').trim()) throw new Error('Agentic Review overview is required');
  return value;
}

export type ReviewExpectations = {
  overview: string;
  notes: string[];
  findingGroups: Finding[][];
  failedReviewers: string[];
};

export function buildPullRequestReview(expected: ReviewExpectations): PullRequestReview {
  const warning = expected.findingGroups.length > 0 || expected.failedReviewers.length > 0;
  const sections = [
    `## ${warning ? '⚠️' : '✅'} Agentic Review`,
    expected.overview,
    expected.findingGroups.length
      ? `### 审查结果\n\n发现 ${expected.findingGroups.length} 个需要处理的问题，详见行内评论。`
      : '### 审查结果\n\n未发现需要处理的问题。',
    expected.notes.length ? `### 审查说明\n\n${expected.notes.map((note) => `- ${note}`).join('\n')}` : '',
    expected.failedReviewers.length
      ? `### 审查范围\n\n${expected.failedReviewers.map((reviewer) => `- \`${reviewer}\` 执行失败，审查范围不完整。`).join('\n')}`
      : '',
  ].filter(Boolean);
  const review = validatePullRequestReview({
    body: sections.join('\n\n'),
    comments: expected.findingGroups.map((group) => {
      const first = group[0];
      if (!first) throw new Error('Finding group must not be empty');
      if (group.some((finding) => finding.path !== first.path || finding.side !== first.side || finding.suggestedSeverity !== first.suggestedSeverity)) {
        throw new Error('Finding group must share path, side, and severity');
      }
      if (Math.max(...group.map(({ startLine }) => startLine)) > Math.min(...group.map(({ endLine }) => endLine))) {
        throw new Error('Finding group locations must overlap');
      }
      const startLine = Math.min(...group.map((finding) => finding.startLine));
      const endLine = Math.max(...group.map((finding) => finding.endLine));
      return {
        path: first.path,
        line: endLine,
        ...(startLine < endLine ? { startLine } : {}),
        side: first.side,
        body: renderFindingGroupBody(group),
      };
    }),
  });
  if (Buffer.byteLength(JSON.stringify(review)) > 190 * 1024) throw new Error('Review request exceeds the staged artifact budget');
  return review;
}

export function renderFindingGroupBody(group: Finding[]): string {
  const first = group[0];
  if (!first) throw new Error('Finding group must not be empty');
  return [
    `**${first.suggestedSeverity} · ${first.title}**`,
    renderMergedField('类别', group.map(({ category }) => category)),
    renderMergedField('相关结论', group.map(({ title }) => title)),
    renderMergedField('证据', group.map(({ evidence }) => evidence)),
    renderMergedField('触发条件', group.map(({ trigger }) => trigger)),
    renderMergedField('Base', group.map(({ baseBehavior }) => baseBehavior)),
    renderMergedField('Head', group.map(({ headBehavior }) => headBehavior)),
    renderMergedField('违反约束', group.map(({ violatedConstraint }) => violatedConstraint)),
    renderMergedField('影响', group.map(({ impact }) => impact)),
  ].join('\n\n');
}

function renderMergedField(label: string, values: string[]): string {
  const unique = [...new Set(values)];
  return `**${label}：** ${unique.length === 1 ? unique[0] : `\n${unique.map((value) => `- ${value}`).join('\n')}`}`;
}

export function addDiffContext(review: PullRequestReview, sideLines: DiffSideLines, radius = 2): PullRequestReview {
  return {
    ...review,
    comments: review.comments.map((comment) => {
      const valid = sideLines[comment.side].get(comment.path);
      let startLine = comment.startLine ?? comment.line;
      let endLine = comment.line;
      for (let count = 0; count < radius && valid?.has(startLine - 1); count++) startLine--;
      for (let count = 0; count < radius && valid?.has(endLine + 1); count++) endLine++;
      const { startLine: _originalStartLine, ...rest } = comment;
      return {
        ...rest,
        line: endLine,
        ...(startLine < endLine ? { startLine } : {}),
      };
    }),
  };
}

export async function submitPullRequestReview(contextRoot: string, review: PullRequestReview): Promise<void> {
  review = addDiffContext(validatePullRequestReview(review), collectDiffSideLines(await readFile(`${contextRoot}/pr.diff`, 'utf8')));
  await validateLocations(contextRoot, review);
  const outputPath = process.env.REVIEW_OUTPUT_PATH;
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(review, null, 2)}\n`);
  else await publishGitHubReview(contextRoot, review);
  console.log(`[agentic-review] ${outputPath ? 'Staged' : 'Published'} Review with ${review.comments.length} inline comment(s)`);
}

export async function publishGitHubReview(contextRoot: string, review: PullRequestReview): Promise<string> {
  review = validatePullRequestReview(review);
  await validateLocations(contextRoot, review);
  const token = required('GITHUB_TOKEN');
  const repository = required('GITHUB_REPOSITORY');
  const pull = required('REVIEW_PULL_NUMBER');
  const headSha = required('REVIEW_HEAD_SHA');
  const current = await githubRequest(`/repos/${repository}/pulls/${pull}`, token);
  const currentPull = (await current.json()) as { head: { sha: string } };
  if (currentPull.head.sha !== headSha) throw new Error(`stale review head: ${headSha}`);
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}/pulls/${pull}/reviews`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      event: 'COMMENT',
      body: review.body,
      commit_id: headSha,
      comments: review.comments.map(({ path, line, startLine, side, body }) => ({
        path,
        line,
        side,
        body,
        ...(startLine ? { start_line: startLine, start_side: side } : {}),
      })),
    }),
  });
  if (!response.ok) throw new Error(`GitHub review failed: ${response.status} ${await response.text()}`);
  const result = (await response.json()) as { html_url: string };
  return `Review created: ${result.html_url}`;
}

async function githubRequest(path: string, token: string): Promise<Response> {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
  return response;
}

async function validateLocations(contextRoot: string, review: PullRequestReview): Promise<void> {
  const changedFiles = new Set((await readFile(`${contextRoot}/changed-files.txt`, 'utf8')).split('\n').filter(Boolean));
  const sideLines = collectDiffSideLines(await readFile(`${contextRoot}/pr.diff`, 'utf8'));
  for (const comment of review.comments) {
    assertDiffRange(changedFiles, sideLines, comment.path, comment.side, comment.startLine ?? comment.line, comment.line);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
